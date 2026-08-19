/**
 * pi_trace — run and analyze pi agent traces / benchmarks.
 *
 * Replaces the hand-rolled bash+node workflow that shows up over and over in real
 * sessions (150 `pi -p --mode json ... > /tmp/x.log` invocations plus ~100 throwaway
 * `node -e '...'` JSONL parsers in one 266-session corpus):
 *
 *   pi --mode json -p "..." > /tmp/x.log            -> { action: "run", prompt: "..." }
 *   node -e 'lines.filter(o=>o.type==="tool_execution_start")...'
 *                                                   -> { action: "analyze", view: "tools" }
 *   node -e '...obj.message.usage... sum cacheWrite' -> { action: "analyze", view: "tokens" }
 *   node -e '...c.type==="thinking"...'              -> { action: "analyze", view: "thinking" }
 *   node -e '...result.content[0].text...'           -> { action: "analyze", view: "toolResults" }
 *   grep -c '"type":"agent_end"' x.log               -> completed flag in every summary
 *   scripts/compare.js a.jsonl b.jsonl               -> { action: "compare", tracePaths: [a, b] }
 *   ls -t ~/.pi/agent/sessions/<proj>/*.jsonl | head -> { action: "list" }
 *
 * It understands BOTH trace formats:
 *   - `pi --mode json` event streams (tool_execution_start/end, turn_end, agent_end)
 *   - saved session files in ~/.pi/agent/sessions (type:"message" entries with
 *     role assistant / toolResult / bashExecution)
 *
 * Malformed or truncated JSONL lines (killed run, non-JSON extension banners on
 * stdout) are counted and reported instead of crashing the parse.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";

/** Default overall output cap; every view is truncated to fit. */
const DEFAULT_MAX_CHARS = 30_000;
/** Absolute ceiling a caller can raise `maxChars` to. */
const HARD_MAX_CHARS = 120_000;
/** Per-tool-result text we keep in memory while parsing (protects against a 50MB result). */
const STORE_CAP = 250_000;
/** Default run timeout in seconds. */
const DEFAULT_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 1800;
/** stderr tail kept from a run. */
const STDERR_CAP = 4_000;
/** Grace period for stdout to flush after the child exits, before we stop waiting. */
const FLUSH_GRACE_MS = 2_000;
/** Grace period between SIGTERM and SIGKILL on timeout. */
const KILL_GRACE_MS = 3_000;

const actionEnum = ["run", "analyze", "compare", "list"] as const;
const viewEnum = ["summary", "tools", "tokens", "thinking", "toolResults", "full"] as const;

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "run=execute `pi --mode json -p --no-session` with a hard timeout and return a compact summary (never the raw log); " +
        "analyze=parse one stored trace or saved session file and render `view`; " +
        "compare=A/B two traces side by side; list=stored runs + recent session files.",
    },
  ),
  prompt: Type.Optional(Type.String({ description: "action=run: the prompt to send to the child pi process." })),
  cwd: Type.Optional(
    Type.String({ description: "action=run: working directory for the child pi process (default: current cwd)." }),
  ),
  extensions: Type.Optional(
    Type.Array(Type.String(), {
      description: "action=run: extension files to load in the child (each becomes `-e <path>`). Use absolute paths.",
    }),
  ),
  excludeTools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "action=run: tool names to disable in the child (`--exclude-tools a,b`). This is the 'without' half of an A/B pair: " +
        "run once with it and once without, then compare the two traces.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: "action=run: allowlist of tool names (`--tools a,b`)." }),
  ),
  model: Type.Optional(Type.String({ description: "action=run: model pattern for the child (`--model`)." })),
  thinking: Type.Optional(
    Type.String({
      description:
        "action=run: child thinking level (off|minimal|low|medium|high|xhigh|max). Use 'high' when you need the model's " +
        "reasoning captured so `view: 'thinking'` has something to show.",
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: "action=run: extra pi CLI args passed through verbatim (e.g. ['--no-extensions']).",
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `action=run: wall-clock timeout (default ${DEFAULT_TIMEOUT_SEC}s, max ${MAX_TIMEOUT_SEC}s). On timeout the whole child process group is killed and the partial trace is still parsed.`,
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "action=run: short label used in the stored trace filename (e.g. 'with-tool')." }),
  ),
  traceDir: Type.Optional(
    Type.String({ description: "Directory for stored run traces (default $PI_TRACE_DIR or <tmp>/pi-trace)." }),
  ),
  tracePath: Type.Optional(
    Type.String({
      description:
        "action=analyze: path to a `--mode json` trace or a ~/.pi/agent/sessions/**.jsonl session file. A unique " +
        "filename fragment (e.g. a session-id prefix) is resolved against the trace dir and the sessions dir.",
    }),
  ),
  tracePaths: Type.Optional(
    Type.Array(Type.String(), { description: "action=compare: exactly two trace paths/fragments, [A, B]." }),
  ),
  view: Type.Optional(
    Type.Union(
      viewEnum.map((v) => Type.Literal(v)),
      {
        description:
          "action=analyze: summary (default; totals + tool histogram + final answer) | tools (ordered call sequence with " +
          "args digest and result sizes) | tokens (per-turn input/output/cacheRead/cacheWrite/cost deltas) | thinking " +
          "(model reasoning blocks) | toolResults (VERBATIM tool result text, combine with toolFilter) | full (all of them).",
      },
    ),
  ),
  toolFilter: Type.Optional(
    Type.String({
      description:
        "action=analyze with view=toolResults/tools: keep only calls whose tool name contains this string " +
        "(case-insensitive), or a 1-based call index like '3' / '3,7' to inspect specific calls.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max items per section (tool calls, thinking blocks, results, listed files)." }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: `Overall output cap in characters (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).`,
    }),
  ),
  filter: Type.Optional(
    Type.String({ description: "action=list: substring filter on the file path (e.g. 'diner-android')." }),
  ),
  sessionsDir: Type.Optional(
    Type.String({ description: `Sessions directory (default ~/${CONFIG_DIR_NAME}/agent/sessions).` }),
  ),
});

type Params = Static<typeof schema>;

/* ------------------------------------------------------------------ parsing */

interface ParsedCall {
  n: number;
  name: string;
  args: unknown;
  resultText: string;
  resultChars: number;
  /** True when resultText was cut at STORE_CAP while parsing. */
  storeTruncated: boolean;
  isError: boolean;
  gotResult: boolean;
}

interface ParsedTurn {
  n: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model?: string;
}

interface ParsedTrace {
  path: string;
  sizeBytes: number;
  /** json-stream = `pi --mode json` events; session = saved ~/.pi/agent/sessions file. */
  format: "json-stream" | "session" | "mixed" | "empty" | "unknown";
  totalLines: number;
  /** Lines that looked like JSON (`{`...) but failed to parse — a killed run truncates its last line. */
  malformed: number;
  lastLineTruncated: boolean;
  /** Non-JSON stdout noise, e.g. "Token/Sec extension loaded." banners from extensions. */
  noiseLines: number;
  calls: ParsedCall[];
  turns: ParsedTurn[];
  thinking: string[];
  userPrompts: string[];
  finalAnswer: string;
  agentEnds: number;
  bashExecutions: { command: string; exitCode: number | undefined; outputChars: number }[];
  /** Usage reported by tools that ran nested LLM work (subagents). */
  nested: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  /**
   * Provenance of the token numbers, so a degraded parse is visible instead of silently low:
   * "turn_end"/"assistant messages" are the normal sources; "message_end (turn_end missing…)"
   * means the run was interrupted before its turns closed and usage was recovered from the
   * per-message events instead.
   */
  usageSource: string;
  /**
   * Usage attached to `compaction` / `branch_summary` session entries (summaries generated by
   * an LLM). Reported separately instead of silently dropped, because it is real spend that is
   * not part of any assistant turn.
   */
  summaryUsage: { entries: number; input: number; output: number; cacheWrite: number; cost: number };
  cwd?: string;
  sessionId?: string;
  firstTs?: number;
  lastTs?: number;
  models: Set<string>;
}

function emptyTrace(path: string, sizeBytes: number): ParsedTrace {
  return {
    path,
    sizeBytes,
    format: "empty",
    totalLines: 0,
    malformed: 0,
    lastLineTruncated: false,
    noiseLines: 0,
    calls: [],
    turns: [],
    thinking: [],
    userPrompts: [],
    finalAnswer: "",
    agentEnds: 0,
    bashExecutions: [],
    nested: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usageSource: "none",
    summaryUsage: { entries: 0, input: 0, output: 0, cacheWrite: 0, cost: 0 },
    models: new Set(),
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string") {
      out += (c as any).text;
    } else if (c && typeof c === "object" && typeof (c as any).text === "string") {
      out += (c as any).text;
    }
  }
  return out;
}

function tsOf(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * Stream-parse a JSONL trace. Both formats are collected into separate buckets and
 * the richer one wins, so a `--mode json` stream (which contains BOTH
 * tool_execution_* events AND message_end toolResult messages) never double-counts.
 */
async function parseTrace(path: string): Promise<ParsedTrace> {
  const st = statSync(path);
  const trace = emptyTrace(path, st.size);

  // Event-stream buckets (pi --mode json)
  const evCalls: ParsedCall[] = [];
  const evById = new Map<string, ParsedCall>();
  const evTurns: ParsedTurn[] = [];
  const evThinking: string[] = [];
  let evFinal = "";
  // Fallback bucket: a run killed mid-turn emits assistant `message_end` events but never the
  // matching `turn_end`, so turn_end-only accounting reports 0 tokens for an interrupted run.
  // These carry identical `usage` objects (verified against real traces), so they are a safe
  // recovery source — used only when turn_end is missing, and flagged in the output when it is.
  const meTurns: ParsedTurn[] = [];
  const meThinking: string[] = [];
  let meFinal = "";

  // Session-file buckets
  const seCalls: ParsedCall[] = [];
  const seById = new Map<string, ParsedCall>();
  const seTurns: ParsedTurn[] = [];
  const seThinking: string[] = [];
  let seFinal = "";

  const store = (s: string): { text: string; truncated: boolean } =>
    s.length > STORE_CAP ? { text: s.slice(0, STORE_CAP), truncated: true } : { text: s, truncated: false };

  const pushUsage = (bucket: ParsedTurn[], msg: any) => {
    const u = msg?.usage;
    if (!u) return;
    bucket.push({
      n: bucket.length + 1,
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheWrite: u.cacheWrite || 0,
      cost: u.cost?.total || 0,
      model: typeof msg.model === "string" ? msg.model : undefined,
    });
    if (typeof msg.model === "string") trace.models.add(msg.model);
  };

  const collectThinking = (bucket: string[], msg: any) => {
    for (const c of msg?.content ?? []) {
      if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) bucket.push(c.thinking.trim());
    }
  };

  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let lastRawLine = "";
  let lastLineWasMalformed = false;

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    trace.totalLines++;
    lastRawLine = line;
    lastLineWasMalformed = false;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // `{`-prefixed => real JSONL that got cut (killed run / disk full).
      // Anything else => stdout noise, e.g. an extension banner printed before the stream.
      if (line.startsWith("{") || line.startsWith("[")) {
        trace.malformed++;
        lastLineWasMalformed = true;
      } else {
        trace.noiseLines++;
      }
      continue;
    }
    if (!obj || typeof obj !== "object") {
      trace.noiseLines++;
      continue;
    }

    const ts = tsOf(obj.timestamp) ?? tsOf(obj.message?.timestamp);
    if (ts !== undefined) {
      if (trace.firstTs === undefined) trace.firstTs = ts;
      trace.lastTs = ts;
    }

    switch (obj.type) {
      case "session":
        trace.cwd = typeof obj.cwd === "string" ? obj.cwd : trace.cwd;
        trace.sessionId = typeof obj.id === "string" ? obj.id : trace.sessionId;
        break;

      /* ---- pi --mode json event stream ---- */
      case "tool_execution_start": {
        const call: ParsedCall = {
          n: evCalls.length + 1,
          name: String(obj.toolName ?? "?"),
          args: obj.args,
          resultText: "",
          resultChars: 0,
          storeTruncated: false,
          isError: false,
          gotResult: false,
        };
        evCalls.push(call);
        if (typeof obj.toolCallId === "string") evById.set(obj.toolCallId, call);
        break;
      }
      case "tool_execution_end": {
        const raw = textOf(obj.result?.content);
        const s = store(raw);
        let call = typeof obj.toolCallId === "string" ? evById.get(obj.toolCallId) : undefined;
        if (!call) {
          // Out-of-band end (start event lost to truncation): synthesize a call.
          call = {
            n: evCalls.length + 1,
            name: String(obj.toolName ?? "?"),
            args: obj.args,
            resultText: "",
            resultChars: 0,
            storeTruncated: false,
            isError: false,
            gotResult: false,
          };
          evCalls.push(call);
        }
        call.resultText = s.text;
        call.storeTruncated = s.truncated;
        call.resultChars = raw.length;
        call.isError = !!obj.isError;
        call.gotResult = true;
        break;
      }
      case "turn_end":
        pushUsage(evTurns, obj.message);
        collectThinking(evThinking, obj.message);
        break;
      case "agent_end": {
        trace.agentEnds++;
        const msgs = Array.isArray(obj.messages) ? obj.messages : [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.role !== "assistant") continue;
          const t = (m.content ?? []).find((c: any) => c?.type === "text");
          if (t?.text) {
            evFinal = t.text;
            break;
          }
        }
        break;
      }

      /* ---- saved session file ---- */
      case "message": {
        const m = obj.message;
        if (!m || typeof m !== "object") break;
        if (m.role === "assistant") {
          pushUsage(seTurns, m);
          collectThinking(seThinking, m);
          const t = (m.content ?? []).find((c: any) => c?.type === "text");
          if (t?.text) seFinal = t.text;
          for (const c of m.content ?? []) {
            if (c?.type !== "toolCall") continue;
            const call: ParsedCall = {
              n: seCalls.length + 1,
              name: String(c.name ?? "?"),
              args: c.arguments,
              resultText: "",
              resultChars: 0,
              storeTruncated: false,
              isError: false,
              gotResult: false,
            };
            seCalls.push(call);
            if (typeof c.id === "string") seById.set(c.id, call);
          }
        } else if (m.role === "toolResult") {
          const raw = textOf(m.content);
          const s = store(raw);
          let call = typeof m.toolCallId === "string" ? seById.get(m.toolCallId) : undefined;
          if (!call) {
            call = {
              n: seCalls.length + 1,
              name: String(m.toolName ?? "?"),
              args: undefined,
              resultText: "",
              resultChars: 0,
              storeTruncated: false,
              isError: false,
              gotResult: false,
            };
            seCalls.push(call);
          }
          call.name = call.name === "?" ? String(m.toolName ?? "?") : call.name;
          call.resultText = s.text;
          call.storeTruncated = s.truncated;
          call.resultChars = raw.length;
          call.isError = !!m.isError;
          call.gotResult = true;
          // Tools that run their own LLM work (subagent) report nested usage here.
          if (m.usage) {
            trace.nested.calls++;
            trace.nested.input += m.usage.input || 0;
            trace.nested.output += m.usage.output || 0;
            trace.nested.cacheRead += m.usage.cacheRead || 0;
            trace.nested.cacheWrite += m.usage.cacheWrite || 0;
            trace.nested.cost += m.usage.cost?.total || 0;
          }
        } else if (m.role === "user") {
          const t = textOf(m.content);
          if (t.trim()) trace.userPrompts.push(t.trim());
        } else if (m.role === "bashExecution") {
          trace.bashExecutions.push({
            command: String(m.command ?? ""),
            exitCode: typeof m.exitCode === "number" ? m.exitCode : undefined,
            outputChars: typeof m.output === "string" ? m.output.length : 0,
          });
        }
        break;
      }
      case "compaction":
      case "branch_summary": {
        trace.summaryUsage.entries++;
        const u = obj.usage;
        if (u) {
          trace.summaryUsage.input += u.input || 0;
          trace.summaryUsage.output += u.output || 0;
          trace.summaryUsage.cacheWrite += u.cacheWrite || 0;
          trace.summaryUsage.cost += u.cost?.total || 0;
        }
        break;
      }
      case "message_end": {
        // json-stream: capture the user prompt; usage/thinking here is only a fallback for
        // interrupted runs (see meTurns above) because turn_end repeats the same message.
        const m = obj.message;
        if (m?.role === "user") {
          const t = textOf(m.content);
          if (t.trim()) trace.userPrompts.push(t.trim());
        } else if (m?.role === "assistant") {
          pushUsage(meTurns, m);
          collectThinking(meThinking, m);
          const t = (m.content ?? []).find((c: any) => c?.type === "text");
          if (t?.text) meFinal = t.text;
        }
        break;
      }
      default:
        break;
    }
  }

  if (lastLineWasMalformed && lastRawLine) trace.lastLineTruncated = true;

  const hasEvents = evCalls.length > 0 || evTurns.length > 0 || trace.agentEnds > 0 || meTurns.length > 0;
  const hasMessages = seCalls.length > 0 || seTurns.length > 0;
  trace.format = hasEvents && hasMessages ? "mixed" : hasEvents ? "json-stream" : hasMessages ? "session" : trace.totalLines > 0 ? "unknown" : "empty";

  const preferEvents = hasEvents;
  trace.calls = preferEvents ? evCalls : seCalls;
  if (preferEvents) {
    const interrupted = meTurns.length > evTurns.length;
    trace.turns = interrupted ? meTurns : evTurns;
    trace.thinking = interrupted && meThinking.length > evThinking.length ? meThinking : evThinking;
    trace.finalAnswer = evFinal || meFinal;
    trace.usageSource = trace.turns.length === 0 ? "none" : interrupted ? "message_end (turn_end missing — run interrupted)" : "turn_end";
  } else {
    trace.turns = seTurns;
    trace.thinking = seThinking;
    trace.finalAnswer = seFinal;
    trace.usageSource = seTurns.length ? "assistant messages" : "none";
  }
  return trace;
}

/* --------------------------------------------------------------- formatting */

function totals(t: ParsedTrace) {
  let input = 0,
    output = 0,
    cacheWrite = 0,
    cacheReadSum = 0,
    cost = 0;
  for (const turn of t.turns) {
    input += turn.input;
    output += turn.output;
    cacheWrite += turn.cacheWrite;
    cacheReadSum += turn.cacheRead;
    cost += turn.cost;
  }
  const lastCacheRead = t.turns.length ? t.turns[t.turns.length - 1]!.cacheRead : 0;
  return { input, output, cacheWrite, cacheReadSum, lastCacheRead, cost, newTokens: input + output + cacheWrite };
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function digest(args: unknown, max = 160): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {});
  } catch {
    s = String(args);
  }
  s = s.replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s;
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated: showed ${fmtNum(max)} of ${fmtNum(s.length)} chars]`;
}

function histogram(t: ParsedTrace): string {
  const h = new Map<string, number>();
  for (const c of t.calls) h.set(c.name, (h.get(c.name) ?? 0) + 1);
  const parts = [...h.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(" ") : "(none)";
}

function healthLine(t: ParsedTrace): string {
  const bits: string[] = [];
  if (t.malformed > 0)
    bits.push(
      `${t.malformed} malformed JSONL line(s)${t.lastLineTruncated ? " (last line truncated — run was killed/interrupted)" : ""}`,
    );
  if (t.noiseLines > 0) bits.push(`${t.noiseLines} non-JSON stdout line(s) (extension banners)`);
  const unresolved = t.calls.filter((c) => !c.gotResult).length;
  if (unresolved > 0) bits.push(`${unresolved} tool call(s) with no recorded result`);
  if (t.format === "json-stream" && t.agentEnds === 0) bits.push("no agent_end event — run did not finish");
  return bits.length ? `warnings: ${bits.join("; ")}` : "warnings: none";
}

function headerLines(t: ParsedTrace): string[] {
  const to = totals(t);
  const span = t.firstTs !== undefined && t.lastTs !== undefined ? `${((t.lastTs - t.firstTs) / 1000).toFixed(1)}s` : "n/a";
  const out = [
    `trace: ${t.path}`,
    `format: ${t.format}  lines: ${fmtNum(t.totalLines)}  size: ${fmtNum(t.sizeBytes)}B  span: ${span}` +
      (t.cwd ? `  cwd: ${t.cwd}` : ""),
    `turns: ${t.turns.length}  toolCalls: ${t.calls.length}  errors: ${t.calls.filter((c) => c.isError).length}` +
      (t.format === "json-stream" ? `  agent_end: ${t.agentEnds}` : ""),
    `tools: ${histogram(t)}`,
    `newTokens(input+output+cacheWrite): ${fmtNum(to.newTokens)}  [input=${fmtNum(to.input)} output=${fmtNum(to.output)} cacheWrite=${fmtNum(to.cacheWrite)} cacheRead(last)=${fmtNum(to.lastCacheRead)} cacheRead(sum)=${fmtNum(to.cacheReadSum)}]`,
    `cost: $${to.cost.toFixed(4)}` +
      (t.models.size ? `  models: ${[...t.models].join(",")}` : "") +
      (t.usageSource !== "turn_end" && t.usageSource !== "assistant messages" ? `  usageSource: ${t.usageSource}` : ""),
  ];
  if (t.nested.calls > 0) {
    out.push(
      `nested tool LLM usage (subagents): ${t.nested.calls} result(s), newTokens=${fmtNum(t.nested.input + t.nested.output + t.nested.cacheWrite)}, cost=$${t.nested.cost.toFixed(4)} (NOT included in the totals above)`,
    );
  }
  if (t.summaryUsage.entries > 0) {
    out.push(
      `compaction/branch_summary entries: ${t.summaryUsage.entries}, their newTokens=${fmtNum(t.summaryUsage.input + t.summaryUsage.output + t.summaryUsage.cacheWrite)}, cost=$${t.summaryUsage.cost.toFixed(4)} (NOT included in the totals above; context was compacted, so per-turn numbers are not a full history)`,
    );
  }
  if (t.bashExecutions.length > 0) {
    const failed = t.bashExecutions.filter((b) => b.exitCode !== undefined && b.exitCode !== 0).length;
    out.push(`user shell commands (role=bashExecution): ${t.bashExecutions.length} (${failed} non-zero exit)`);
  }
  out.push(healthLine(t));
  return out;
}

/** Resolve `toolFilter` (name substring or 1-based indices like "3" / "2,5") to a call subset. */
function selectCalls(t: ParsedTrace, toolFilter: string | undefined): ParsedCall[] {
  if (!toolFilter) return t.calls;
  const raw = toolFilter.trim();
  if (/^\d+(\s*,\s*\d+)*$/.test(raw)) {
    const want = new Set(raw.split(",").map((x) => Number(x.trim())));
    return t.calls.filter((c) => want.has(c.n));
  }
  const needle = raw.toLowerCase();
  return t.calls.filter((c) => c.name.toLowerCase().includes(needle));
}

function renderTools(t: ParsedTrace, limit: number, toolFilter?: string): string {
  const calls = selectCalls(t, toolFilter);
  const shown = calls.slice(0, limit);
  const lines = [`--- tool calls (${shown.length} of ${calls.length}${toolFilter ? ` matching '${toolFilter}'` : ""}) ---`];
  for (const c of shown) {
    const status = !c.gotResult ? "NO RESULT" : c.isError ? "ERROR" : "ok";
    lines.push(`${c.n}. ${c.name}(${digest(c.args)}) -> ${fmtNum(c.resultChars)} chars, ${status}`);
  }
  if (calls.length > shown.length) lines.push(`... ${calls.length - shown.length} more (raise 'limit')`);
  if (t.bashExecutions.length) {
    lines.push(`--- user shell commands (not model tool calls) ---`);
    for (const b of t.bashExecutions.slice(0, Math.min(limit, 10))) {
      lines.push(`  ! ${digest(b.command, 120)} (exit=${b.exitCode ?? "?"}, ${fmtNum(b.outputChars)} chars out)`);
    }
  }
  return lines.join("\n");
}

function renderTokens(t: ParsedTrace, limit: number): string {
  const lines = ["--- token usage per turn ---", "turn  input   output  cacheRead  cacheWrite  cost"];
  const shown = t.turns.slice(0, limit);
  for (const turn of shown) {
    lines.push(
      `${String(turn.n).padEnd(5)} ${String(turn.input).padEnd(7)} ${String(turn.output).padEnd(7)} ` +
        `${String(turn.cacheRead).padEnd(10)} ${String(turn.cacheWrite).padEnd(11)} $${turn.cost.toFixed(4)}`,
    );
  }
  if (t.turns.length > shown.length) lines.push(`... ${t.turns.length - shown.length} more turns (raise 'limit')`);
  const to = totals(t);
  lines.push(
    `TOTAL newTokens=${fmtNum(to.newTokens)} (input=${fmtNum(to.input)} output=${fmtNum(to.output)} cacheWrite=${fmtNum(to.cacheWrite)}), cacheRead(last)=${fmtNum(to.lastCacheRead)}, cost=$${to.cost.toFixed(4)}`,
  );
  lines.push(
    "note: cacheRead is cheap reuse of already-cached context; compare newTokens (input+output+cacheWrite) between runs, not totalTokens.",
  );
  return lines.join("\n");
}

function renderThinking(t: ParsedTrace, limit: number, budget: number): string {
  if (!t.thinking.length)
    return "--- thinking ---\n(none captured — rerun with thinking: 'high' to record the model's reasoning)";
  const shown = t.thinking.slice(0, limit);
  const per = Math.max(400, Math.floor(budget / shown.length));
  const lines = [`--- thinking blocks (${shown.length} of ${t.thinking.length}) ---`];
  shown.forEach((th, i) => lines.push(`[${i + 1}] ${cut(th, per)}`));
  if (t.thinking.length > shown.length) lines.push(`... ${t.thinking.length - shown.length} more blocks`);
  return lines.join("\n");
}

function renderToolResults(t: ParsedTrace, limit: number, budget: number, toolFilter?: string): string {
  const calls = selectCalls(t, toolFilter).filter((c) => c.gotResult);
  if (!calls.length)
    return `--- tool results ---\n(no calls${toolFilter ? ` matching '${toolFilter}'` : ""} with recorded results; ${t.calls.length} calls total: ${histogram(t)})`;
  const shown = calls.slice(0, limit);
  const per = Math.max(500, Math.min(20_000, Math.floor(budget / shown.length)));
  const lines = [`--- raw tool results (${shown.length} of ${calls.length}${toolFilter ? ` matching '${toolFilter}'` : ""}) ---`];
  for (const c of shown) {
    const note = c.storeTruncated ? ` [huge result: only the first ${fmtNum(STORE_CAP)} chars were retained by the parser]` : "";
    // Always report the REAL result size in the truncation notice, not the retained slice,
    // otherwise a 5MB result looks like a 250KB one.
    const body =
      c.resultText.length > per
        ? c.resultText.slice(0, per) + `\n... [truncated: showed ${fmtNum(per)} of ${fmtNum(c.resultChars)} chars]`
        : c.resultText;
    lines.push(`\n### ${c.n}. ${c.name} (${fmtNum(c.resultChars)} chars${c.isError ? ", ERROR" : ""})${note}\n${body}`);
  }
  if (calls.length > shown.length) lines.push(`\n... ${calls.length - shown.length} more results (use toolFilter or raise 'limit')`);
  return lines.join("\n");
}

function renderFinal(t: ParsedTrace, budget: number): string {
  const prompt = t.userPrompts.length ? cut(t.userPrompts[0]!, Math.min(600, budget)) : "(none)";
  return `--- first user prompt ---\n${prompt}\n\n--- final answer ---\n${t.finalAnswer ? cut(t.finalAnswer, budget) : "(none recorded)"}`;
}

function renderView(t: ParsedTrace, view: (typeof viewEnum)[number], limit: number, maxChars: number, toolFilter?: string): string {
  const head = headerLines(t).join("\n");
  const budget = Math.max(1_000, maxChars - head.length - 400);
  let body: string;
  switch (view) {
    case "tools":
      body = renderTools(t, limit, toolFilter);
      break;
    case "tokens":
      body = renderTokens(t, limit);
      break;
    case "thinking":
      body = renderThinking(t, limit, budget);
      break;
    case "toolResults":
      body = renderToolResults(t, limit, budget, toolFilter);
      break;
    case "full":
      // Order matters: the cheap, high-value sections come first because the whole body is
      // hard-capped at maxChars — on a big trace the tail (bulky thinking / raw results) is what
      // gets dropped, never the tool sequence, tokens or final answer.
      body = [
        renderTools(t, limit, toolFilter),
        renderTokens(t, limit),
        renderFinal(t, Math.floor(budget * 0.1)),
        renderThinking(t, limit, Math.floor(budget * 0.25)),
        renderToolResults(t, limit, Math.floor(budget * 0.45), toolFilter),
      ].join("\n\n");
      break;
    case "summary":
    default:
      body = [renderTools(t, Math.min(limit, 25), toolFilter), renderFinal(t, Math.min(2_000, budget))].join("\n\n");
      break;
  }
  return cut(`${head}\n\n${body}`, maxChars);
}

/* ------------------------------------------------------------ path handling */

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function defaultTraceDir(params: Params): string {
  return expandHome(params.traceDir ?? process.env.PI_TRACE_DIR ?? join(tmpdir(), "pi-trace"));
}

function defaultSessionsDir(params: Params): string {
  return expandHome(params.sessionsDir ?? join(homedir(), CONFIG_DIR_NAME, "agent", "sessions"));
}

function listJsonl(dir: string, recurseOneLevel: boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile() && (e.endsWith(".jsonl") || e.endsWith(".log"))) out.push(p);
    else if (st.isDirectory() && recurseOneLevel) out.push(...listJsonl(p, false));
  }
  return out;
}

/**
 * Accept an exact path, a path relative to cwd, or a unique filename fragment
 * (session id prefix, run label) resolved against the trace dir and sessions dir.
 * This replaces the `ls ~/.pi/agent/sessions/*​/* | grep <id>` step.
 */
function resolveTrace(spec: string, params: Params, cwd: string): { path: string } | { error: string } {
  const direct = expandHome(spec);
  const abs = isAbsolute(direct) ? direct : resolvePath(cwd, direct);
  if (existsSync(abs) && statSync(abs).isFile()) return { path: abs };
  if (existsSync(direct) && statSync(direct).isFile()) return { path: direct };

  const candidates = [...listJsonl(defaultTraceDir(params), false), ...listJsonl(defaultSessionsDir(params), true)];
  const frag = basename(spec).toLowerCase();
  const hits = candidates.filter((p) => basename(p).toLowerCase().includes(frag));
  if (hits.length === 1) return { path: hits[0]! };
  if (hits.length > 1) {
    hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return {
      error:
        `Ambiguous trace '${spec}' — ${hits.length} files match. Pass a full path. Newest matches:\n` +
        hits.slice(0, 5).map((p) => `  ${p}`).join("\n"),
    };
  }
  return {
    error:
      `No such trace: '${spec}' (looked at ${abs}, then for a filename containing '${frag}' in ${defaultTraceDir(params)} and ${defaultSessionsDir(params)}). ` +
      `Use pi_trace {action:'list'} to see available traces and sessions.`,
  };
}

/* ----------------------------------------------------------------- the tool */

interface RunOutcome {
  tracePath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  wallMs: number;
  stderrTail: string;
  bytes: number;
  argv: string[];
  spawnError?: string;
}

/**
 * Spawn `pi --mode json -p --no-session ...` in its own process group and stream stdout
 * to a trace file. On timeout the whole GROUP is signalled (SIGTERM then SIGKILL), which
 * is the fix for the bash version's failure mode: `pi -p ... > log` under a shell timeout
 * left grandchildren alive and the wrapper hung forever waiting on the pipe.
 */
async function runPi(params: Params, cwd: string, tracePath: string, abort?: AbortSignal): Promise<RunOutcome> {
  const argv = ["--mode", "json", "-p", "--no-session"];
  if (params.model) argv.push("--model", params.model);
  if (params.thinking) argv.push("--thinking", params.thinking);
  for (const e of params.extensions ?? []) argv.push("-e", expandHome(e));
  if (params.excludeTools?.length) argv.push("--exclude-tools", params.excludeTools.join(","));
  if (params.tools?.length) argv.push("--tools", params.tools.join(","));
  for (const a of params.extraArgs ?? []) argv.push(a);
  argv.push(params.prompt!);

  const timeoutSec = Math.max(5, Math.min(params.timeoutSec ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC));
  const started = Date.now();

  const out: RunOutcome = {
    tracePath,
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    wallMs: 0,
    stderrTail: "",
    bytes: 0,
    argv,
  };

  const fileStream = createWriteStream(tracePath, { encoding: "utf8" });
  const child = spawn(process.env.PI_TRACE_PI_BIN || "pi", argv, {
    cwd,
    detached: true, // own process group so we can kill the whole tree
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_TRACE_CHILD: "1" },
  });

  const killGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };

  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    out.timedOut = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  }, timeoutSec * 1000);

  const onAbort = () => {
    out.aborted = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  };
  abort?.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (chunk: Buffer) => {
    out.bytes += chunk.length;
    fileStream.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (out.stderrTail.length < STDERR_CAP) out.stderrTail += chunk.toString("utf8");
  });

  await new Promise<void>((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    child.on("error", (err) => {
      out.spawnError = err instanceof Error ? err.message : String(err);
      finish();
    });
    // 'close' waits for stdio to drain; if a grandchild holds the pipe open it may never
    // fire, so 'exit' arms a bounded grace period and we stop waiting either way.
    child.on("close", finish);
    child.on("exit", (code, sig) => {
      out.exitCode = code;
      out.signal = sig;
      setTimeout(finish, FLUSH_GRACE_MS).unref?.();
    });
  });

  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  abort?.removeEventListener("abort", onAbort);
  await new Promise<void>((r) => fileStream.end(() => r()));
  out.wallMs = Date.now() - started;
  return out;
}

function compareTraces(a: ParsedTrace, b: ParsedTrace, limit: number, maxChars: number): string {
  const ta = totals(a);
  const tb = totals(b);
  const row = (name: string, x: string | number, y: string | number, d: string | number) =>
    `${name.padEnd(16)} ${String(x).padEnd(14)} ${String(y).padEnd(14)} ${d}`;
  const spanA = a.firstTs !== undefined && a.lastTs !== undefined ? (a.lastTs - a.firstTs) / 1000 : NaN;
  const spanB = b.firstTs !== undefined && b.lastTs !== undefined ? (b.lastTs - b.firstTs) / 1000 : NaN;
  const pct = ((ta.newTokens - tb.newTokens) / Math.max(tb.newTokens, 1)) * 100;

  const lines = [
    `A: ${a.path}  (${a.format})`,
    `B: ${b.path}  (${b.format})`,
    "",
    row("metric", "A", "B", "delta (A-B)"),
    row("turns", a.turns.length, b.turns.length, a.turns.length - b.turns.length),
    row("toolCalls", a.calls.length, b.calls.length, a.calls.length - b.calls.length),
    row("toolErrors", a.calls.filter((c) => c.isError).length, b.calls.filter((c) => c.isError).length, a.calls.filter((c) => c.isError).length - b.calls.filter((c) => c.isError).length),
    row("newTokens", fmtNum(ta.newTokens), fmtNum(tb.newTokens), fmtNum(ta.newTokens - tb.newTokens)),
    row("  input", fmtNum(ta.input), fmtNum(tb.input), fmtNum(ta.input - tb.input)),
    row("  output", fmtNum(ta.output), fmtNum(tb.output), fmtNum(ta.output - tb.output)),
    row("  cacheWrite", fmtNum(ta.cacheWrite), fmtNum(tb.cacheWrite), fmtNum(ta.cacheWrite - tb.cacheWrite)),
    row("cacheRead(last)", fmtNum(ta.lastCacheRead), fmtNum(tb.lastCacheRead), fmtNum(ta.lastCacheRead - tb.lastCacheRead)),
    row("cost ($)", ta.cost.toFixed(4), tb.cost.toFixed(4), (ta.cost - tb.cost).toFixed(4)),
    row("wall (s)", Number.isNaN(spanA) ? "n/a" : spanA.toFixed(1), Number.isNaN(spanB) ? "n/a" : spanB.toFixed(1), Number.isNaN(spanA) || Number.isNaN(spanB) ? "n/a" : (spanA - spanB).toFixed(1)),
    "",
    `A uses ${Math.abs(pct).toFixed(0)}% ${ta.newTokens >= tb.newTokens ? "MORE" : "FEWER"} new tokens than B.`,
    `A tools: ${histogram(a)}`,
    `B tools: ${histogram(b)}`,
    "",
    `A warnings: ${healthLine(a).replace(/^warnings: /, "")}`,
    `B warnings: ${healthLine(b).replace(/^warnings: /, "")}`,
    "",
    "--- A tool sequence ---",
    ...a.calls.slice(0, limit).map((c) => `  ${c.n}. ${c.name}(${digest(c.args, 100)})`),
    "--- B tool sequence ---",
    ...b.calls.slice(0, limit).map((c) => `  ${c.n}. ${c.name}(${digest(c.args, 100)})`),
    "",
    "--- A final answer (check both answers are equally CORRECT before trusting the token delta) ---",
    cut(a.finalAnswer || "(none)", 1_200),
    "--- B final answer ---",
    cut(b.finalAnswer || "(none)", 1_200),
  ];
  return cut(lines.join("\n"), maxChars);
}

async function listTraces(params: Params, limit: number, maxChars: number): Promise<string> {
  const traceDir = defaultTraceDir(params);
  const sessionsDir = defaultSessionsDir(params);
  const filter = params.filter?.toLowerCase();

  const section = async (title: string, files: string[], parse: boolean): Promise<string[]> => {
    let list = files;
    if (filter) list = list.filter((p) => p.toLowerCase().includes(filter));
    list.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const shown = list.slice(0, limit);
    const lines = [`--- ${title} (${shown.length} of ${list.length}${filter ? ` matching '${filter}'` : ""}) ---`];
    for (const p of shown) {
      const st = statSync(p);
      let extra = "";
      if (parse) {
        try {
          const t = await parseTrace(p);
          const to = totals(t);
          extra = ` ${t.format} turns=${t.turns.length} calls=${t.calls.length} newTokens=${fmtNum(to.newTokens)} tools=${histogram(t).slice(0, 80)}`;
        } catch (e) {
          extra = ` (parse failed: ${e instanceof Error ? e.message : String(e)})`;
        }
      }
      lines.push(`${st.mtime.toISOString().slice(0, 16)}  ${fmtNum(st.size).padStart(11)}B  ${p}${extra}`);
    }
    if (!shown.length) lines.push("(none)");
    return lines;
  };

  const runFiles = listJsonl(traceDir, false);
  const sessionFiles = listJsonl(sessionsDir, true);
  // Stored runs are few and small -> parse them for real counts. Sessions can be
  // hundreds of MB in aggregate -> list metadata only (analyze one to get counts).
  const out = [
    `traceDir: ${traceDir}`,
    `sessionsDir: ${sessionsDir}`,
    "",
    ...(await section("stored runs (action=run output, parsed)", runFiles, true)),
    "",
    ...(await section("saved sessions (metadata only — analyze one for counts)", sessionFiles, false)),
    "",
    "next: pi_trace {action:'analyze', tracePath:'<path or unique filename fragment>', view:'tools'|'tokens'|'toolResults'}",
  ];
  return cut(out.join("\n"), maxChars);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_trace",
    label: "Pi Trace",
    description: `Run and analyze pi agent traces / A-B benchmarks without hand-writing a JSONL parser.

Actions:
  run      — execute \`pi --mode json -p --no-session <prompt>\` with a hard timeout (kills the whole child
             process group, so it can never hang), store the trace, and return a COMPACT summary
             (exit status, wall time, turns, tool-call sequence, token totals) — never the raw log.
  analyze  — parse one trace and render a view: summary | tools | tokens | thinking | toolResults | full.
             Works on both \`--mode json\` traces AND saved sessions in ~/.pi/agent/sessions.
  compare  — two traces side by side (A/B) with deltas for tokens, tool calls, errors and wall time.
  list     — stored runs (parsed) + recent saved session files (metadata), newest first.

A/B benchmark in three calls (replaces run-pair.sh + two node one-liners):
  {"action":"run","label":"with","prompt":"<task>","extensions":["/abs/ext/index.ts"],"thinking":"high"}
  {"action":"run","label":"without","prompt":"<task>","extensions":["/abs/ext/index.ts"],"excludeTools":["my_tool"]}
  {"action":"compare","tracePaths":["<traceA>","<traceB>"]}

Inspect what a tool actually returned, verbatim:
  {"action":"analyze","tracePath":"/tmp/pi-trace/with-....jsonl","view":"toolResults","toolFilter":"my_tool"}

Every result reports a "warnings:" line: malformed/truncated JSONL lines (a killed run truncates its last
line), non-JSON stdout noise, tool calls with no recorded result, and a missing agent_end (run did not
finish). Treat numbers from a trace with warnings as partial, not wrong-by-design. Token comparisons use
newTokens = input+output+cacheWrite; cacheRead is cheap cache reuse and is reported separately.`,
    promptSnippet: "Run pi subprocess benchmarks and parse/compare pi JSONL traces and saved sessions",
    promptGuidelines: [
      "Use pi_trace {action:'run'} instead of a bash `pi -p --mode json ... > /tmp/x.log` invocation: it enforces a timeout, kills the whole child process group (a bare bash pipeline can hang forever), stores the trace, and returns a compact summary rather than dumping the log into context.",
      "Use pi_trace {action:'analyze'} instead of writing a `node -e '...JSON.parse...'` one-liner to count tool calls, sum usage/cacheWrite, dig out thinking blocks, or print result.content[0].text — it parses both `pi --mode json` event streams and saved ~/.pi/agent/sessions files.",
      "Pick the pi_trace view deliberately: 'tools' for the call sequence, 'tokens' for per-turn input/output/cacheRead/cacheWrite deltas, 'thinking' for the model's reasoning, 'toolResults' (plus toolFilter) to read one tool's raw output verbatim, 'summary' when you only need totals. Avoid view:'full' on a large trace — it is capped and will truncate everything.",
      "Use pi_trace {action:'compare', tracePaths:[A,B]} for A/B (with-tool vs --exclude-tools) instead of diffing two logs by hand, and compare newTokens (input+output+cacheWrite), not totalTokens: cacheRead is cheap reuse and inflates naive totals.",
      "Always read the 'warnings:' line in a pi_trace result before quoting its numbers: 'last line truncated', 'no agent_end', or 'tool call(s) with no recorded result' mean the run was killed/interrupted and the counts are a lower bound.",
      "Use pi_trace {action:'list'} to find traces and historical sessions instead of `ls -t ~/.pi/agent/sessions/*/*.jsonl`; analyze accepts a unique filename fragment (e.g. a session-id prefix), so you do not need a separate glob/grep step.",
      "Do NOT use pi_trace for ordinary text search inside a trace file (grep is better for that), and do not use it to run non-pi commands — action:'run' only ever spawns pi itself.",
    ],
    parameters: schema,
    async execute(_toolCallId, params: Params, signal, onUpdate, ctx: ExtensionContext) {
      const limit = Math.max(1, Math.min(params.limit ?? 40, 500));
      const maxChars = Math.max(1_000, Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS));
      const cwd = params.cwd ? expandHome(params.cwd) : ctx.cwd;

      const fin = (text: string, details: Record<string, unknown>, isError = false) => ({
        content: [{ type: "text" as const, text }],
        details: { action: params.action, ...details },
        isError,
      });
      const bad = (msg: string, details: Record<string, unknown> = {}) => fin(`Error: ${msg}`, details, true);

      try {
        switch (params.action) {
          case "run": {
            if (!params.prompt) return bad("action=run requires 'prompt'.");
            if (!existsSync(cwd)) return bad(`cwd does not exist: ${cwd}`);
            const traceDir = defaultTraceDir(params);
            mkdirSync(traceDir, { recursive: true });
            const slug = (params.label ?? "run").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const tracePath = join(traceDir, `${slug}-${stamp}.jsonl`);

            onUpdate?.({
              content: [{ type: "text", text: `Running pi in ${cwd} (timeout ${params.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s)...` }],
              details: { tracePath },
            });

            const outcome = await runPi(params, cwd, tracePath, signal);
            if (outcome.spawnError && outcome.bytes === 0) {
              return bad(
                `failed to spawn pi: ${outcome.spawnError}. Set PI_TRACE_PI_BIN to the pi executable if it is not on PATH.`,
                { tracePath },
              );
            }

            const trace = await parseTrace(tracePath);
            const status =
              `run: exit=${outcome.exitCode ?? "null"}${outcome.signal ? ` signal=${outcome.signal}` : ""}` +
              `${outcome.timedOut ? " TIMED OUT (child process group killed)" : ""}${outcome.aborted ? " ABORTED" : ""}` +
              `  wall=${(outcome.wallMs / 1000).toFixed(1)}s  stdout=${fmtNum(outcome.bytes)}B`;
            const cmd = `cmd: pi ${outcome.argv.slice(0, -1).join(" ")} <prompt>`;
            const stderrNote =
              outcome.stderrTail.trim() && (outcome.exitCode !== 0 || outcome.timedOut)
                ? `\nstderr tail: ${cut(outcome.stderrTail.trim(), 800)}`
                : "";
            const body = renderView(trace, params.view ?? "summary", Math.min(limit, 30), Math.max(1_200, maxChars - 600), params.toolFilter);
            const to = totals(trace);
            return fin(
              `${status}\n${cmd}${stderrNote}\n\n${body}\n\ninspect further: pi_trace {action:'analyze', tracePath:'${tracePath}', view:'toolResults'|'tokens'|'thinking'}`,
              {
                tracePath,
                exitCode: outcome.exitCode,
                timedOut: outcome.timedOut,
                wallMs: outcome.wallMs,
                turns: trace.turns.length,
                toolCalls: trace.calls.length,
                newTokens: to.newTokens,
                cost: to.cost,
                malformedLines: trace.malformed,
              },
              outcome.timedOut || (outcome.exitCode !== 0 && outcome.exitCode !== null),
            );
          }

          case "analyze": {
            if (!params.tracePath) return bad("action=analyze requires 'tracePath'.");
            const r = resolveTrace(params.tracePath, params, cwd);
            if ("error" in r) return bad(r.error);
            const trace = await parseTrace(r.path);
            if (trace.format === "empty")
              return fin(
                `trace: ${r.path}\nformat: empty  size: ${fmtNum(trace.sizeBytes)}B\nThe file has no parseable JSONL lines. If this came from action=run, the child produced no output (check exit status / stderr).`,
                { tracePath: r.path, format: "empty" },
              );
            const to = totals(trace);
            return fin(renderView(trace, params.view ?? "summary", limit, maxChars, params.toolFilter), {
              tracePath: r.path,
              format: trace.format,
              turns: trace.turns.length,
              toolCalls: trace.calls.length,
              newTokens: to.newTokens,
              cost: to.cost,
              malformedLines: trace.malformed,
              view: params.view ?? "summary",
            });
          }

          case "compare": {
            const paths = params.tracePaths ?? [];
            if (paths.length !== 2) return bad("action=compare requires 'tracePaths' with exactly two entries [A, B].");
            const ra = resolveTrace(paths[0]!, params, cwd);
            if ("error" in ra) return bad(ra.error);
            const rb = resolveTrace(paths[1]!, params, cwd);
            if ("error" in rb) return bad(rb.error);
            const [a, b] = await Promise.all([parseTrace(ra.path), parseTrace(rb.path)]);
            return fin(compareTraces(a, b, Math.min(limit, 40), maxChars), {
              a: ra.path,
              b: rb.path,
              aNewTokens: totals(a).newTokens,
              bNewTokens: totals(b).newTokens,
              aCalls: a.calls.length,
              bCalls: b.calls.length,
            });
          }

          case "list":
            return fin(await listTraces(params, Math.min(limit, 60), maxChars), {
              traceDir: defaultTraceDir(params),
              sessionsDir: defaultSessionsDir(params),
            });

          default:
            return bad(`unknown action '${(params as any).action}'.`);
        }
      } catch (e) {
        return bad(e instanceof Error ? `${e.message}` : String(e));
      }
    },

    renderCall(args, theme) {
      const a = args as Params;
      let text = theme.fg("toolTitle", theme.bold("pi_trace "));
      switch (a.action) {
        case "run":
          text += theme.fg("accent", `run ${a.label ? `[${a.label}] ` : ""}${digest(a.prompt ?? "", 60)}`);
          break;
        case "analyze":
          text += theme.fg("accent", `analyze ${basename(a.tracePath ?? "")} ${a.view ?? "summary"}${a.toolFilter ? ` :${a.toolFilter}` : ""}`);
          break;
        case "compare":
          text += theme.fg("accent", `compare ${(a.tracePaths ?? []).map((p) => basename(p)).join(" vs ")}`);
          break;
        default:
          text += theme.fg("accent", `list${a.filter ? ` ${a.filter}` : ""}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running pi trace..."), 0, 0);
      const first = result.content[0];
      const content = (first && "text" in first ? first.text : undefined) ?? "";
      if (content.startsWith("Error:")) return new Text(theme.fg("error", cut(content, 1_500)), 0, 0);
      const lines = content.split("\n");
      if (!expanded && lines.length > 18) {
        return new Text(lines.slice(0, 18).join("\n") + `\n... and ${lines.length - 18} more lines`, 0, 0);
      }
      return new Text(content, 0, 0);
    },
  });
}
