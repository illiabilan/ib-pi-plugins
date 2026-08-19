/**
 * Process Extension for Pi — background process manager.
 *
 * Replaces the most fragile bash pattern in real pi sessions: hand-rolled
 * background-job juggling with blind sleeps and unconditional kills.
 *
 *   (cmd > /tmp/x.log 2>&1 & P=$!; sleep 40; kill -9 $P 2>/dev/null)
 *     -> process start   + process wait {timeoutSec:40} (+ process kill only if needed)
 *   cmd > log 2>&1 & PID=$!; for i in $(seq 1 30); do kill -0 $PID || break; sleep 5; done
 *     -> process wait {id, timeoutSec:150}
 *   for i in $(seq 1 50); do if ! kill -0 <pid>; then echo done; break; fi; sleep 10; done
 *     -> process poll {id}  (or process wait)
 *   tail -n 40 /tmp/x.log | grep -i error
 *     -> process tail {id, lines:40, grepPattern:"error"}
 *   kill -9 <pid>; pkill -f ...
 *     -> process kill {id}   (SIGTERM -> SIGKILL, whole process GROUP)
 *
 * State lives in a registry directory (default $TMPDIR/pi-process, override with
 * PI_PROCESS_DIR): one `<id>.json` metadata file plus one `<id>.log` per process.
 * Per-id metadata files (never a single shared JSON) so concurrent pi sessions
 * cannot clobber each other's registry, and so entries survive a pi restart —
 * with stale-pid / pid-reuse detection when the owning pi process is gone.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Max chars of log text returned by any single call (tail/poll/wait). */
const MAX_OUT_CHARS = 12_000;
/** Default number of log lines returned by tail/poll/wait. */
const DEFAULT_LINES = 20;
/** Hard cap on requested lines. */
const MAX_LINES = 500;
/** Bytes read from the END of the log for plain tail (never reads the whole file). */
const TAIL_WINDOW_BYTES = 512 * 1024;
/** Bytes scanned from the END of the log when grepPattern is used. */
const GREP_WINDOW_BYTES = 8 * 1024 * 1024;
/** Bytes of *new* output actually rendered by poll (the count is always exact). */
const POLL_WINDOW_BYTES = 64 * 1024;
/** Default seconds to wait before escalating SIGTERM -> SIGKILL. */
const DEFAULT_GRACE_SEC = 3;
/** Default seconds for action=wait. */
const DEFAULT_WAIT_SEC = 60;
/** Hard cap for action=wait (a tool call should never hang a session forever). */
const MAX_WAIT_SEC = 900;
/** Entries older than this (and finished) are pruned by action=clean. */
const PRUNE_AGE_MS = 7 * 24 * 3600 * 1000;
/** Max rows returned by action=list. */
const LIST_LIMIT = 40;

type Status = "running" | "exited" | "killed";
/** How the exit was observed — machine-readable confidence marker. */
type ExitSource = "child-event" | "stale-pid" | "pid-reused" | "signalled";

interface Rec {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  /** Real process-group id (captured via ps after spawn); falls back to pid. */
  pgid: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  status: Status;
  logPath: string;
  /** Byte offset already reported to the caller by a previous poll. */
  cursor: number;
  /** `ps -o lstart=` snapshot taken at spawn, used to detect pid reuse later. */
  psStart?: string;
  /** Set when the exit was not observed directly by this pi process. */
  exitSource?: ExitSource;
  /** pid of the pi process that spawned it (for "owned by this session" reporting). */
  ownerPid: number;
}

/** In-memory live handles for processes started by THIS pi process. */
const children = new Map<string, ChildProcess>();
/** In-memory record cache; disk is the source of truth for foreign/older ids. */
const recs = new Map<string, Rec>();
/** Pending timers, so session_shutdown can clear every one of them. */
const timers = new Set<ReturnType<typeof setTimeout>>();

function registryDir(): string {
  return process.env.PI_PROCESS_DIR?.trim() || join(tmpdir(), "pi-process");
}

async function ensureDir(): Promise<string> {
  const dir = registryDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

let idCounter = 0;
function newId(): string {
  // Short but collision-resistant across concurrent sessions: time + pid + counter.
  const t = Date.now().toString(36).slice(-4);
  const p = (process.pid % 1296).toString(36).padStart(2, "0");
  const c = (idCounter++ % 36).toString(36);
  return `p${t}${p}${c}`;
}

async function saveRec(rec: Rec): Promise<void> {
  recs.set(rec.id, rec);
  const dir = await ensureDir();
  const target = metaPath(dir, rec.id);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(rec), "utf8");
  await fsp.rename(tmp, target); // atomic: readers never see a partial file
}

/** Serialized per-id writes, so two overlapping updates cannot clobber each other. */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Merge a partial update into the current record and persist it.
 *
 * MUST be used instead of saveRec({...snapshot, change}) for every update: a
 * child's 'exit' handler can fire at any await point, and writing back a stale
 * snapshot (e.g. a poll advancing `cursor`) would silently erase the real exit
 * code and leave the entry looking "running" forever — which then degrades to
 * exit=unknown(stale-pid) on the next check.
 */
function patchRec(id: string, patch: Partial<Rec>): Promise<Rec | null> {
  const prev = writeQueues.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const cur = recs.get(id) ?? (await loadRec(id));
    if (!cur) return null;
    const merged: Rec = { ...cur, ...patch };
    await saveRec(merged);
    return merged;
  });
  writeQueues.set(
    id,
    next.catch(() => null),
  );
  return next.catch(() => null);
}

async function loadRec(id: string): Promise<Rec | null> {
  const cached = recs.get(id);
  if (cached) return cached;
  try {
    const raw = await fsp.readFile(metaPath(registryDir(), id), "utf8");
    const rec = JSON.parse(raw) as Rec;
    recs.set(id, rec);
    return rec;
  } catch {
    return null;
  }
}

async function allRecs(): Promise<Rec[]> {
  const dir = registryDir();
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [...recs.values()];
  }
  const out = new Map<string, Rec>();
  for (const rec of recs.values()) out.set(rec.id, rec);
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const id = name.slice(0, -5);
    if (out.has(id)) continue;
    const rec = await loadRec(id);
    if (rec) out.set(id, rec);
  }
  return [...out.values()].sort((a, b) => b.startedAt - a.startedAt);
}

function run(cmd: string, args: string[], timeout = 4000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || "").trim() });
    });
  });
}

/** `ps` snapshot for a pid: process-group id + start time (used for pid-reuse detection). */
async function psInfo(pid: number): Promise<{ pgid?: number; lstart?: string }> {
  const r = await run("ps", ["-o", "pgid=,lstart=", "-p", String(pid)]);
  if (!r.ok || !r.out) return {};
  const m = /^\s*(\d+)\s+(.*)$/.exec(r.out.split("\n")[0] ?? "");
  if (!m) return {};
  return { pgid: Number(m[1]), lstart: (m[2] ?? "").trim() };
}

/**
 * Snapshot of every process that belongs to the job right now: the whole process
 * group PLUS the ppid-closure of descendants. The descendant closure matters because
 * a grandchild that calls setsid() (gradle daemons, some node/npm wrappers) LEAVES the
 * process group, so `kill(-pgid)` never reaches it and `pgrep -g` cannot see it. Taking
 * the snapshot BEFORE signalling is what makes those reachable at all.
 */
async function jobPids(pid: number, pgid: number): Promise<number[]> {
  const r = await run("ps", ["-axo", "pid=,ppid=,pgid="]);
  if (!r.ok || !r.out) return [];
  const kids = new Map<number, number[]>();
  const found = new Set<number>();
  for (const line of r.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const [p, pp, pg] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp)!.push(p);
    if (pgid > 1 && pg === pgid) found.add(p);
  }
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const kid of kids.get(cur) ?? []) {
      if (found.has(kid)) continue;
      found.add(kid);
      queue.push(kid);
    }
  }
  found.add(pid);
  found.delete(process.pid);
  found.delete(1);
  return [...found];
}

/** Start times (ms epoch) for the given pids, via `ps -o lstart=`. Missing pids are omitted. */
async function pidStartTimes(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (pids.length === 0) return out;
  const r = await run("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]);
  if (!r.ok || !r.out) return out;
  for (const line of r.out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const ts = Date.parse((m[2] ?? "").trim());
    if (!Number.isNaN(ts)) out.set(Number(m[1]), ts);
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return e?.code === "EPERM";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      timers.delete(t);
      cleanup();
      resolve();
    }, ms);
    timers.add(t);
    const onAbort = () => {
      clearTimeout(t);
      timers.delete(t);
      cleanup();
      resolve();
    };
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m${rem}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

async function logSize(rec: Rec): Promise<number> {
  try {
    return (await fsp.stat(rec.logPath)).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve the live status of a record, healing stale entries left behind by a
 * previous pi process (crash/restart) and detecting pid reuse.
 */
async function resolveStatus(input: Rec): Promise<Rec> {
  // Always start from the freshest known copy: a child's exit handler may have
  // patched the record after the caller captured its snapshot.
  const rec = recs.get(input.id) ?? input;
  if (rec.status !== "running") return rec;

  const child = children.get(rec.id);
  if (pidAlive(rec.pid)) {
    if (!child && rec.psStart) {
      // Not our child: the pid could have been recycled by an unrelated process.
      const info = await psInfo(rec.pid);
      if (info.lstart && info.lstart !== rec.psStart) {
        return (
          (await patchRec(rec.id, { status: "exited", exitCode: null, endedAt: Date.now(), exitSource: "pid-reused" })) ?? rec
        );
      }
    }
    return rec;
  }

  // pid is gone. If it is our own child the 'exit' handler is about to update the
  // record — give it a moment so we report the real exit code instead of "unknown".
  if (child) {
    for (let i = 0; i < 6; i++) {
      await sleep(50);
      const fresh = recs.get(rec.id);
      if (fresh && fresh.status !== "running") return fresh;
    }
  }
  return (await patchRec(rec.id, { status: "exited", exitCode: null, endedAt: Date.now(), exitSource: "stale-pid" })) ?? rec;
}

function statusLine(rec: Rec, size: number): string {
  const now = Date.now();
  const runtime = fmtDur((rec.endedAt ?? now) - rec.startedAt);
  if (rec.status === "running") return `running pid=${rec.pid} runtime=${runtime} log=${fmtBytes(size)}`;
  const how =
    rec.exitSource === "stale-pid"
      ? " exit=unknown(stale-pid: process gone, not observed by this pi process)"
      : rec.exitSource === "pid-reused"
        ? " exit=unknown(pid-reused: pid now belongs to a different process)"
        : rec.exitSource === "signalled"
          ? ` signal=${rec.signal ?? "?"} (killed by process tool; exit code not observed)`
          : rec.signal
          ? ` signal=${rec.signal}`
          : ` exit=${rec.exitCode ?? "?"}`;
  return `${rec.status}${how} runtime=${runtime} log=${fmtBytes(size)}`;
}

/** Read the tail window of a file without ever buffering the whole thing. */
async function readWindow(
  path: string,
  maxBytes: number,
  from?: number,
): Promise<{ text: string; size: number; start: number; missing?: boolean }> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(path, "r");
    const { size } = await fh.stat();
    const start = from !== undefined ? Math.max(from, size - maxBytes, 0) : Math.max(0, size - maxBytes);
    const len = Math.max(0, size - start);
    if (len === 0) return { text: "", size, start };
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return { text: buf.toString("utf8"), size, start };
  } catch {
    // The log file is gone (deleted by hand, or the registry dir was wiped).
    return { text: "", size: 0, start: 0, missing: true };
  } finally {
    await fh?.close();
  }
}

function lastLines(text: string, n: number, partialStart: boolean): string {
  let lines = text.split("\n");
  if (partialStart && lines.length > 1) lines = lines.slice(1); // drop a half-read first line
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(Math.max(0, lines.length - n));
  return kept.join("\n");
}

function capChars(text: string): string {
  if (text.length <= MAX_OUT_CHARS) return text;
  return (
    text.slice(text.length - MAX_OUT_CHARS) +
    `\n... [output capped at ${MAX_OUT_CHARS} chars; use grepPattern or a smaller 'lines' to narrow]`
  );
}

function buildMatcher(pattern: string): { test: (line: string) => boolean; kind: "regex" | "literal" } {
  try {
    const re = new RegExp(pattern);
    return { test: (l) => re.test(l), kind: "regex" };
  } catch {
    return { test: (l) => l.includes(pattern), kind: "literal" };
  }
}

const actionEnum = ["start", "list", "poll", "tail", "wait", "kill", "clean"] as const;

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "start=spawn detached background process (returns immediately with an id); poll=status + only the NEW output since the last poll; " +
        "tail=last N log lines (optionally grep-filtered); wait=block until exit or timeoutSec (replaces `sleep N; kill -9`); " +
        "kill=SIGTERM then SIGKILL the whole process group; list=registry of ids; clean=drop finished entries and their logs.",
    },
  ),
  command: Type.Optional(
    Type.String({ description: "For action=start: the shell command line to run in the background (run via `bash -c`)." }),
  ),
  cwd: Type.Optional(Type.String({ description: "For action=start: working directory (default: the session cwd)." })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "For action=start: extra environment variables merged onto the inherited environment.",
    }),
  ),
  id: Type.Optional(
    Type.String({ description: "Process id returned by action=start. Required for poll/tail/wait/kill; optional for clean." }),
  ),
  lines: Type.Optional(
    Type.Number({ description: `Log lines to return for tail/poll/wait (default ${DEFAULT_LINES}, max ${MAX_LINES}).` }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `For action=wait: max seconds to block (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}). For action=kill: seconds to wait after SIGTERM before SIGKILL (default ${DEFAULT_GRACE_SEC}).`,
    }),
  ),
  grepPattern: Type.Optional(
    Type.String({
      description: "For action=tail: only return log lines matching this regex (falls back to a literal substring match if it is not a valid regex). Replaces `| grep pat | tail`.",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({ description: "For action=clean: remove ALL finished entries and their logs (default true when no id is given)." }),
  ),
});

type Params = Static<typeof schema>;

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    // Deliberately NOT killing the children: they are detached on purpose so a
    // long build/benchmark survives a pi restart. `process list` re-discovers
    // them from the registry, with stale-pid detection.
  });

  pi.registerTool({
    name: "process",
    label: "Process",
    description: `Manage long-running background processes (builds, benchmarks, servers, nested \`pi\` runs) without hand-rolled shell job control.

Actions:
  start  {command, cwd?, env?}          spawn detached, stdout+stderr -> a log file, returns a short id IMMEDIATELY (never blocks)
  poll   {id, lines?}                   running/exited + exit code + runtime + ONLY the output that is new since the previous poll
  tail   {id, lines?, grepPattern?}     last N log lines, optionally regex-filtered; also reports matches=N, so it COUNTS occurrences (no extra grep call needed)
  wait   {id, timeoutSec?, lines?}      block until the process exits OR the timeout elapses; says which happened
  kill   {id, timeoutSec?}              SIGTERM the whole process group, escalate to SIGKILL after timeoutSec, report unreaped orphans
  list   {}                             every known id: status, runtime, log size, command
  clean  {id? | all?}                   forget finished entries and delete their logs (never touches running ones)

Use this instead of bash background-job juggling. Concretely:
  BAD:  (cmd > /tmp/o.log 2>&1 & P=$!; sleep 40; kill -9 $P)
  GOOD: process {action:"start", command:"cmd"} -> {action:"wait", id:"pXXXX", timeoutSec:40} -> only if it timed out, {action:"kill", id:"pXXXX"}
  BAD:  for i in $(seq 1 30); do kill -0 $PID || break; sleep 5; done
  GOOD: process {action:"wait", id, timeoutSec:150}   (returns the instant it exits — no blind sleeping, no truncated run)

wait returns as soon as the process exits, so it is both faster and safer than sleeping a fixed duration and killing. poll is incremental: each call reports only bytes written since the previous poll, so polling a chatty job repeatedly does not re-send output you already read.

To count matching lines in a job's log (errors, warnings, test failures), use tail with grepPattern and read matches=N from the header — do not spend a second grep/bash call on the log path. tail scans the last 8MB of the log (last 512KB when no grepPattern); the header states the scanned window, so only fall back to grep on the printed log path when the log is larger than that window and you need an exact whole-file count.

Exit codes are only exact when this pi process observed the exit. If a result says exit=unknown(stale-pid) or exit=unknown(pid-reused), the process was started by an earlier pi process (or its pid was recycled) — treat the exit code as unknown and read the log tail instead of trusting a status.`,
    promptSnippet:
      "Start/poll/tail/wait/kill background processes (replaces `cmd & sleep N; kill -9`, `tail | grep`, kill/pkill juggling)",
    promptGuidelines: [
      "Use process (action=start) instead of bash with a trailing `&`, `nohup`, or `$!` capture for anything that takes more than a few seconds; then use process action=wait or poll instead of `sleep`.",
      "Use process action=wait with timeoutSec INSTEAD of `sleep N; kill -9 $PID` — wait returns the moment the process exits, so it neither wastes wall-clock nor truncates a run that needed longer.",
      "Use process action=poll to check on a running job: it returns only the output added since your previous poll, so repeated polling does not re-send text you already saw.",
      "Use process action=tail with grepPattern to search OR count lines in a background job's log (the header reports matches=N) instead of calling grep/bash on the log file path — one call, and it never loads the whole log.",
      "Use process action=kill instead of `kill -9`/`pkill`: it SIGTERMs then SIGKILLs the entire process group, so nested children (gradle daemons, spawned pi runs, npm subprocesses) die too, and it reports orphans it could not reap.",
      "Do NOT use process for fast, foreground commands (ls, git status, a quick grep, a 2-second script) — plain bash is cheaper there. process pays off when the command is slow, chatty, or needs to be monitored/killed.",
      "If a process result reports exit=unknown(stale-pid) or exit=unknown(pid-reused), the exit code was never observed (started before a pi restart, or the pid was recycled): check the log tail before concluding success or failure.",
    ],
    parameters: schema,
    async execute(_toolCallId, params: Params, signal, onUpdate, ctx: ExtensionContext) {
      const fin = (text: string, details: Record<string, unknown>, isError = false) => ({
        content: [{ type: "text" as const, text }],
        details: { action: params.action, ...details },
        isError,
      });
      const bad = (msg: string) => fin(`Error: ${msg}`, { error: msg }, true);

      const needId = async (): Promise<Rec | string> => {
        if (!params.id) return `action=${params.action} requires 'id' (from action=start; use action=list to see ids).`;
        const rec = await loadRec(params.id);
        if (!rec) return `Unknown process id '${params.id}'. Use action=list to see known ids.`;
        return rec;
      };

      const linesWanted = Math.max(1, Math.min(Math.floor(params.lines ?? DEFAULT_LINES), MAX_LINES));

      try {
        switch (params.action) {
          case "start": {
            const command = params.command?.trim();
            if (!command) return bad("action=start requires 'command'.");
            const cwd = params.cwd || ctx.cwd || process.cwd();
            if (!existsSync(cwd)) return bad(`cwd does not exist: ${cwd}`);

            const dir = await ensureDir();
            let id = newId();
            // Paranoia: never reuse an id that already has files (would append to a
            // foreign log and overwrite its metadata).
            for (let i = 0; i < 50 && existsSync(metaPath(dir, id)); i++) id = newId();
            const logPath = join(dir, `${id}.log`);

            const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
            const fh = await fsp.open(logPath, "a");
            let child: ChildProcess;
            try {
              child = spawn(shell, ["-c", command], {
                cwd,
                env: { ...process.env, ...(params.env ?? {}) },
                detached: true, // own process group => kill(-pgid) reaches grandchildren
                stdio: ["ignore", fh.fd, fh.fd],
              });
            } finally {
              await fh.close(); // the child holds its own dup of the fd
            }
            if (!child.pid) return bad(`failed to spawn: ${command}`);
            child.unref(); // never hold pi's event loop open for a detached job

            const startedAt = Date.now();
            const rec: Rec = {
              id,
              command,
              cwd,
              pid: child.pid,
              pgid: child.pid,
              startedAt,
              status: "running",
              logPath,
              cursor: 0,
              ownerPid: process.pid,
            };
            children.set(id, child);
            await saveRec(rec);
            child.on("exit", (code, sig) => {
              void patchRec(id, {
                status: sig ? "killed" : "exited",
                exitCode: code,
                signal: sig ?? null,
                endedAt: Date.now(),
                exitSource: "child-event",
              });
            });
            child.on("error", () => {
              void patchRec(id, { status: "exited", exitCode: null, signal: null, endedAt: Date.now(), exitSource: "child-event" });
            });

            // Capture pgid + start time for group kills and pid-reuse detection.
            const info = await psInfo(child.pid);
            await patchRec(id, { pgid: info.pgid && info.pgid > 1 ? info.pgid : child.pid, psStart: info.lstart });

            return fin(
              `started id=${id} pid=${child.pid} cwd=${cwd}\ncmd: ${command}\nlog: ${logPath}\nNot blocking. Next: {action:"wait",id:"${id}",timeoutSec:N} to block until exit, or {action:"poll",id:"${id}"} for incremental output.`,
              { id, pid: child.pid, logPath, cwd },
            );
          }

          case "list": {
            const all = await allRecs();
            if (all.length === 0) return fin("No processes in the registry.", { count: 0 });
            const rows: string[] = [];
            let running = 0;
            for (const raw of all.slice(0, LIST_LIMIT)) {
              const rec = await resolveStatus(raw);
              if (rec.status === "running") running++;
              const size = await logSize(rec);
              const own = rec.ownerPid === process.pid ? "" : " (other/prior pi session)";
              const cmd = rec.command.length > 90 ? `${rec.command.slice(0, 90)}…` : rec.command;
              rows.push(`${rec.id}  ${statusLine(rec, size)}${own}\n   cmd: ${cmd}`);
            }
            const more = all.length > LIST_LIMIT ? `\n... ${all.length - LIST_LIMIT} more (use action=clean to prune finished ones)` : "";
            return fin(
              `${all.length} process(es), ${running} running. registry: ${registryDir()}\n${rows.join("\n")}${more}`,
              { count: all.length, running },
            );
          }

          case "poll": {
            const got = await needId();
            if (typeof got === "string") return bad(got);
            let rec = await resolveStatus(got);
            const size = await logSize(rec);
            const from = Math.min(rec.cursor, size);
            const newBytes = Math.max(0, size - from);

            let body = "";
            let skipped = 0;
            if (newBytes > 0) {
              const win = await readWindow(rec.logPath, POLL_WINDOW_BYTES, from);
              // Only drop a leading half-line when the window itself clipped bytes.
              // When win.start === cursor we are resuming exactly where the previous
              // poll stopped, so the first line is genuinely new output (dropping it
              // there silently swallowed a whole line — real bug, caught in testing).
              const clipped = win.start > from;
              skipped = win.start - from;
              body = lastLines(win.text, linesWanted, clipped);
            }
            rec = (await patchRec(rec.id, { cursor: size })) ?? rec;

            const head = `${rec.id} ${statusLine(rec, size)} new=${fmtBytes(newBytes)}`;
            const hint =
              newBytes === 0
                ? rec.status === "running"
                  ? "\n(no new output since last poll)"
                  : ""
                : `${skipped > 0 ? `\n(skipped ${fmtBytes(skipped)} of new output — too much to render; use tail with grepPattern to search it)` : ""}\n--- new output (last ${linesWanted} lines of ${fmtBytes(newBytes)}) ---\n${capChars(body)}`;
            const next =
              rec.status === "running"
                ? `\nStill running: prefer {action:"wait",id:"${rec.id}",timeoutSec:N} over repeated polling.`
                : "";
            return fin(`${head}${hint}${next}`, {
              id: rec.id,
              status: rec.status,
              exitCode: rec.exitCode ?? null,
              exitSource: rec.exitSource ?? null,
              runtimeMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
              newBytes,
              logBytes: size,
            });
          }

          case "tail": {
            const got = await needId();
            if (typeof got === "string") return bad(got);
            const rec = await resolveStatus(got);
            const window = params.grepPattern ? GREP_WINDOW_BYTES : TAIL_WINDOW_BYTES;
            const win = await readWindow(rec.logPath, window);
            const partial = win.start > 0;
            let body: string;
            let note = "";
            if (params.grepPattern) {
              const m = buildMatcher(params.grepPattern);
              let lines = win.text.split("\n");
              if (partial && lines.length > 1) lines = lines.slice(1);
              const matched = lines.filter((l) => m.test(l));
              body = matched.slice(Math.max(0, matched.length - linesWanted)).join("\n");
              note = ` matches=${matched.length}${m.kind === "literal" ? " (pattern is not valid regex -> literal substring match)" : ""}`;
              if (matched.length === 0) body = "(no matching lines)";
            } else {
              body = lastLines(win.text, linesWanted, partial) || (win.missing ? `(log file is MISSING: ${rec.logPath} was deleted — output is unrecoverable)` : "(log is empty)");
            }
            const scanned = partial ? ` scanned=last ${fmtBytes(win.size - win.start)} of log` : "";
            return fin(
              `${rec.id} ${statusLine(rec, win.size)}${scanned}${note}\n--- tail ${linesWanted} lines${params.grepPattern ? ` matching /${params.grepPattern}/` : ""} ---\n${capChars(body)}`,
              { id: rec.id, status: rec.status, logBytes: win.size, scannedBytes: win.size - win.start, exitCode: rec.exitCode ?? null, exitSource: rec.exitSource ?? null },
            );
          }

          case "wait": {
            const got = await needId();
            if (typeof got === "string") return bad(got);
            let rec = await resolveStatus(got);
            const timeoutSec = Math.max(0.1, Math.min(params.timeoutSec ?? DEFAULT_WAIT_SEC, MAX_WAIT_SEC));
            const deadline = Date.now() + timeoutSec * 1000;
            let aborted = false;
            let waitedMs = 0;

            while (rec.status === "running") {
              if (signal?.aborted) {
                aborted = true;
                break;
              }
              const remaining = deadline - Date.now();
              if (remaining <= 0) break;
              const step = Math.min(waitedMs < 2000 ? 100 : waitedMs < 15000 ? 400 : 1000, remaining);
              await sleep(step, signal);
              waitedMs += step;
              if (waitedMs % 5000 < step) {
                onUpdate?.({
                  content: [{ type: "text", text: `waiting on ${rec.id} (${fmtDur(waitedMs)} / ${timeoutSec}s)` }],
                  details: { action: "wait", id: rec.id, waitedMs },
                });
              }
              rec = await resolveStatus(rec);
            }

            const size = await logSize(rec);
            const win = await readWindow(rec.logPath, TAIL_WINDOW_BYTES);
            const tail =
              lastLines(win.text, linesWanted, win.start > 0) ||
              (win.missing ? `(log file is MISSING: ${rec.logPath} was deleted — output is unrecoverable)` : "(log is empty)");
            const outcome =
              rec.status !== "running"
                ? "exited"
                : aborted
                  ? "aborted"
                  : "timeout";
            const header =
              outcome === "exited"
                ? `${rec.id} EXITED after ${fmtDur((rec.endedAt ?? Date.now()) - rec.startedAt)} — ${statusLine(rec, size)}`
                : outcome === "aborted"
                  ? `${rec.id} still RUNNING (wait aborted after ${fmtDur(waitedMs)}) — ${statusLine(rec, size)}`
                  : `${rec.id} still RUNNING after the ${timeoutSec}s timeout — ${statusLine(rec, size)}\nDecide explicitly: wait again with a larger timeoutSec, or {action:"kill",id:"${rec.id}"}.`;
            // Waiting counts as consuming output: advance the cursor so a later poll
            // reports only what arrives after this point.
            rec = (await patchRec(rec.id, { cursor: size })) ?? rec;
            return fin(`${header}\n--- last ${linesWanted} lines ---\n${capChars(tail)}`, {
              id: rec.id,
              outcome,
              status: rec.status,
              exitCode: rec.exitCode ?? null,
              exitSource: rec.exitSource ?? null,
              waitedMs,
              runtimeMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
              logBytes: size,
            });
          }

          case "kill": {
            const got = await needId();
            if (typeof got === "string") return bad(got);
            let rec = await resolveStatus(got);
            if (rec.status !== "running") {
              const size = await logSize(rec);
              // The leader is gone, but children it left behind (daemons, orphaned
              // background jobs) can still be in its process group — reap those instead
              // of reporting "nothing to do" and leaking them.
              let reaped: number[] = [];
              if (rec.pgid > 1 && rec.pgid !== process.pid) {
                const r = await run("pgrep", ["-g", String(rec.pgid)]);
                const candidates = r.out
                  .split("\n")
                  .map((s) => Number(s.trim()))
                  .filter((p) => p > 1 && p !== process.pid && pidAlive(p));
                // SAFETY: a process group id can be recycled once the whole group is
                // gone, so "pgrep -g <old pgid>" can match a completely unrelated group.
                // Only reap processes that were already alive while the job was — a
                // recycled pid/pgid necessarily started after the job ended.
                const starts = await pidStartTimes(candidates);
                const cutoff = (rec.endedAt ?? Date.now()) + 2000;
                const lingering = candidates.filter((p) => {
                  const t = starts.get(p);
                  return t !== undefined && t >= rec.startedAt - 2000 && t <= cutoff;
                });
                for (const p of lingering) {
                  try {
                    process.kill(p, "SIGTERM");
                  } catch {
                    /* gone */
                  }
                }
                if (lingering.length) {
                  await sleep(300);
                  for (const p of lingering.filter((p) => pidAlive(p))) {
                    try {
                      process.kill(p, "SIGKILL");
                    } catch {
                      /* gone */
                    }
                  }
                  reaped = lingering;
                }
              }
              return fin(
                `${rec.id} was already finished. ${statusLine(rec, size)}${
                  reaped.length
                    ? `\nReaped ${reaped.length} lingering process(es) left in its process group: ${reaped.join(" ")}`
                    : "\nNothing left to kill."
                }`,
                {
                  id: rec.id,
                  alreadyDead: true,
                  status: rec.status,
                  reaped: reaped.length,
                  exitCode: rec.exitCode ?? null,
                  exitSource: rec.exitSource ?? null,
                },
              );
            }

            const graceSec = Math.max(0, Math.min(params.timeoutSec ?? DEFAULT_GRACE_SEC, 60));
            const pgid = rec.pgid > 1 && rec.pgid !== process.pid ? rec.pgid : 0;
            const steps: string[] = [];

            let lastSignal: NodeJS.Signals | null = null;
            const signalGroup = (sig: NodeJS.Signals): boolean => {
              lastSignal = sig;
              let sent = false;
              if (pgid) {
                try {
                  process.kill(-pgid, sig); // negative pid => whole process group
                  sent = true;
                } catch {
                  /* group already gone */
                }
              }
              try {
                process.kill(rec.pid, sig);
                sent = true;
              } catch {
                /* leader already gone */
              }
              return sent;
            };

            // Snapshot the job's processes BEFORE signalling, so setsid()-escaped
            // grandchildren can still be swept up afterwards.
            const snapshot = await jobPids(rec.pid, pgid);
            signalGroup("SIGTERM");
            steps.push(`SIGTERM -> group ${pgid || rec.pid} (${snapshot.length} pid(s) in job)`);
            const deadline = Date.now() + graceSec * 1000;
            while (Date.now() < deadline) {
              await sleep(Math.min(100, Math.max(10, deadline - Date.now())));
              rec = await resolveStatus(rec);
              if (rec.status !== "running") break;
            }

            let escalated = false;
            if (rec.status === "running") {
              escalated = true;
              signalGroup("SIGKILL");
              steps.push(`ignored SIGTERM for ${graceSec}s -> SIGKILL`);
              const hard = Date.now() + 2000;
              while (Date.now() < hard) {
                await sleep(100);
                rec = await resolveStatus(rec);
                if (rec.status !== "running") break;
              }
            }

            // Sweep any snapshot pid that outlived the group signal (setsid escapees).
            const strays = snapshot.filter((p) => p !== rec.pid && pidAlive(p));
            if (strays.length) {
              for (const p of strays) {
                try {
                  process.kill(p, "SIGTERM");
                } catch {
                  /* already gone */
                }
              }
              await sleep(300);
              const stillThere = strays.filter((p) => pidAlive(p));
              for (const p of stillThere) {
                try {
                  process.kill(p, "SIGKILL");
                } catch {
                  /* already gone */
                }
              }
              if (stillThere.length) await sleep(200);
              steps.push(
                `swept ${strays.length} escaped descendant pid(s) (${strays.slice(0, 8).join(",")})${
                  stillThere.length ? ` — ${stillThere.length} needed SIGKILL` : ""
                }`,
              );
            }

            // If the process was started by an EARLIER pi process we never see an 'exit'
            // event, so resolveStatus would label it "stale-pid" (exit unobserved) even
            // though we are the ones who just killed it. Record that truthfully instead.
            if (rec.status !== "running" && rec.exitSource === "stale-pid") {
              rec = (await patchRec(rec.id, { status: "killed", signal: lastSignal, exitSource: "signalled" })) ?? rec;
            }

            // Anything still in the group after SIGKILL is an orphan we could not reap.
            let orphans: string[] = [];
            {
              const groupPids = pgid ? (await run("pgrep", ["-g", String(pgid)])).out.split("\n") : [];
              const pids = [...new Set([...groupPids.map((s) => s.trim()), ...snapshot.filter((p) => pidAlive(p)).map(String)])].filter(
                (s) => s && s !== String(process.pid),
              );
              if (pids.length) {
                const info = await run("ps", ["-o", "pid=,command=", "-p", pids.join(",")]);
                orphans = (info.out || pids.join(" ")).split("\n").map((s) => s.trim()).filter(Boolean);
              }
            }

            const size = await logSize(rec);
            const orphanText = orphans.length
              ? `\nWARNING: ${orphans.length} process(es) from this job survived SIGKILL (could not reap — likely owned by another user or stuck in uninterruptible I/O). Handle them explicitly:\n${orphans.slice(0, 10).join("\n")}`
              : "";
            return fin(
              `${rec.id} ${rec.status === "running" ? "STILL RUNNING after SIGKILL (?)" : "terminated"} — ${statusLine(rec, size)}\nsteps: ${steps.join("; ")}${orphanText}`,
              {
                id: rec.id,
                status: rec.status,
                escalated,
                orphans: orphans.length,
                exitCode: rec.exitCode ?? null,
                signal: rec.signal ?? null,
              },
              rec.status === "running" || orphans.length > 0,
            );
          }

          case "clean": {
            const dir = registryDir();
            const targets: Rec[] = [];
            if (params.id) {
              const rec = await loadRec(params.id);
              if (!rec) return bad(`Unknown process id '${params.id}'.`);
              targets.push(await resolveStatus(rec));
            } else {
              for (const raw of await allRecs()) targets.push(await resolveStatus(raw));
            }

            const removed: string[] = [];
            const skipped: string[] = [];
            for (const rec of targets) {
              if (rec.status === "running") {
                skipped.push(`${rec.id} (running — kill it first)`);
                continue;
              }
              if (!params.id && params.all === false && Date.now() - (rec.endedAt ?? rec.startedAt) < PRUNE_AGE_MS) {
                skipped.push(`${rec.id} (finished recently; all=false only prunes entries older than 7d)`);
                continue;
              }
              await fsp.rm(rec.logPath, { force: true });
              await fsp.rm(metaPath(dir, rec.id), { force: true });
              recs.delete(rec.id);
              children.delete(rec.id);
              removed.push(rec.id);
            }
            return fin(
              `cleaned ${removed.length} entr${removed.length === 1 ? "y" : "ies"}${removed.length ? `: ${removed.join(" ")}` : ""}${
                skipped.length ? `\nkept ${skipped.length}: ${skipped.join(", ")}` : ""
              }`,
              { removed, kept: skipped.length },
            );
          }

          default:
            return bad(`Unknown action '${(params as any).action}'. Valid: ${actionEnum.join(", ")}`);
        }
      } catch (e: any) {
        return bad(`${params.action} failed: ${e?.message ?? String(e)}`);
      }
    },
    renderCall(args: Params, theme) {
      const bits = [
        args.id,
        args.action === "start" ? args.command : undefined,
        args.timeoutSec !== undefined ? `${args.timeoutSec}s` : undefined,
        args.grepPattern ? `/${args.grepPattern}/` : undefined,
      ].filter(Boolean) as string[];
      const detail = bits.join(" ");
      return new Text(
        `${theme.fg("accent", "process")} ${theme.bold(args.action)}${detail ? ` ${theme.fg("dim", detail.slice(0, 120))}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const first = result.content[0];
      const text = (first && "text" in first ? first.text : "") ?? "";
      if (isPartial) return new Text(theme.fg("warning", text || "working..."), 0, 0);
      if (text.startsWith("Error:")) return new Text(theme.fg("error", text), 0, 0);
      const lines = text.split("\n");
      if (!expanded && lines.length > 12) {
        return new Text(`${lines.slice(0, 12).join("\n")}\n... and ${lines.length - 12} more lines`, 0, 0);
      }
      return new Text(text, 0, 0);
    },
  });
}
