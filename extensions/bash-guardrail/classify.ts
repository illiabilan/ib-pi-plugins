/**
 * bash-guardrail classifier.
 *
 * Maps a bash command to one of three outcomes:
 *   block  - single-intent command with an EXACT tool equivalent (we can print
 *            the replacement call with concrete arguments)
 *   nudge  - composite command that still has a partial equivalent
 *   allow  - real shell work, or anything we do not fully understand
 *
 * Precision rule enforced everywhere below: an unrecognised flag, an extra
 * positional, a glob we cannot express, a pipe we cannot fold away, or any
 * parse bail flag downgrades block -> nudge -> allow. Never the other way.
 */

import { isSimpleEnough, parseCommand, type Parsed, type Segment, type Word } from "./parse.ts";

export type Intent =
  | "read"
  | "list"
  | "search"
  | "git"
  | "mutate"
  | "measure"
  | "diff"
  | "npm"
  | "gradle"
  | "archive"
  | "env"
  | "background"
  | "writefile"
  | "pi";

export type Call = { tool: string; args: Record<string, unknown> };

export type Decision =
  | { kind: "allow"; why: string }
  | { kind: "nudge"; intent: Intent; tool: string; note: string; call?: Call }
  | { kind: "block"; intent: Intent; tool: string; call: Call; why: string; notes: string[] };

export type PathKind = "file" | "dir" | "missing" | "unknown";

export type ClassifyEnv = {
  cwd: string;
  home?: string;
  /** Optional filesystem probe; defaults to "unknown" (which is handled conservatively). */
  statPath?: (absPath: string) => PathKind;
};

const allow = (why: string): Decision => ({ kind: "allow", why });

/* --------------------------------------------------------------- utilities */

function expand(p: string, dir: string, home: string): string {
  let s = p;
  if (s === "~") s = home;
  else if (s.startsWith("~/")) s = home + s.slice(1);
  if (s.startsWith("/")) return normalize(s);
  if (s === ".") return normalize(dir);
  return normalize(dir.replace(/\/$/, "") + "/" + s);
}

function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** A word is a glob only if it was written unquoted. */
const isGlob = (w: Word): boolean => !w.q && /[*?[]/.test(w.v);
/** Is this word a command-line flag (leading `-` written unquoted)? */
const isFlag = (w: Word): boolean => !w.qs && w.v.startsWith("-") && w.v.length > 1;
const hasGlob = (ws: Word[]): boolean => ws.some(isGlob);

const bin = (w: string): string => w.replace(/^.*\//, "");

function renderCall(c: Call): string {
  return `${c.tool} ${JSON.stringify(c.args)}`;
}

export function renderBlock(d: Extract<Decision, { kind: "block" }>): string {
  const lines = [
    `BLOCKED by bash-guardrail: single-intent ${d.intent} command with an exact tool equivalent — nothing was executed.`,
    `Call this instead:`,
    `  ${renderCall(d.call)}`,
    `Why: ${d.why}`,
  ];
  for (const n of d.notes) lines.push(`Note: ${n}`);
  lines.push(
    `If you genuinely need the shell for this (verbatim user instruction, semantics the tool cannot express), re-send the SAME command with \` # guardrail:allow\` appended and it will run unmodified. Do not retry it unchanged.`,
  );
  return lines.join("\n");
}

export function renderNudge(d: Extract<Decision, { kind: "nudge" }>): string {
  const call = d.call ? `  ${renderCall(d.call)}` : "";
  return `[bash-guardrail] ${d.note}${call}`;
}

/* ------------------------------------------------------------ nudge catalog */

const NUDGE: Record<Intent, { tool: string; note: string }> = {
  read: {
    tool: "read",
    note: "read/multi_file_read take offset+limit (and report line counts), so a cat/sed/head line-range step is usually unnecessary.",
  },
  list: {
    tool: "list_files",
    note: "list_files does this shape in one call (globs, excludeGlobs, type, maxDepth, sortBy:'mtime', countOnly) instead of a find/ls + grep -v pipeline.",
  },
  search: {
    tool: "grep",
    note: "the grep tool covers this pipeline directly: include/exclude, notPattern (instead of `| grep -v`), outputMode:'count'|'filesOnly'|'exists', aggregateMatches (instead of `| sort | uniq -c`), limit (instead of `| head`).",
  },
  git: { tool: "git", note: "the git tool returns parsed status/diff/log for the git part of this command." },
  mutate: { tool: "file_ops", note: "file_ops previews mkdir/copy/move/remove/chmod before touching anything." },
  measure: { tool: "path_stats", note: "path_stats returns lines/bytes/sha256/mtime and du-style totals for several paths in one call." },
  diff: { tool: "diff", note: "the diff tool caps its own output and flags CRLF/trailing-newline differences explicitly." },
  npm: { tool: "node_project", note: "node_project runs install/typecheck/test/build and returns only the diagnostics, no `| tail -N` needed." },
  gradle: {
    tool: "gradle_build",
    note: "gradle_build already parses BUILD FAILED, compile diagnostics, failed tests and lint violations — no `2>&1 | tail -30` needed.",
  },
  archive: { tool: "archive_inspect", note: "archive_inspect lists/greps/javaps jar+aar contents without unzipping to a temp dir." },
  env: { tool: "env_info", note: "env_info reports installed tools, env vars (secrets redacted) and runtime facts without a shell." },
  background: {
    tool: "process",
    note: "process start/wait/poll/tail/kill manages long jobs (and kills the whole process group) instead of `&` + sleep + kill.",
  },
  writefile: { tool: "write", note: "write (whole file) and append_file (append) avoid heredoc quoting entirely." },
  pi: { tool: "pi_trace", note: "pi_trace run/analyze wraps `pi --mode json` with a hard timeout and parses the trace for you." },
};

const nudge = (intent: Intent, extra?: string, call?: Call): Decision => ({
  kind: "nudge",
  intent,
  tool: NUDGE[intent].tool,
  note: extra ? `${extra} ${NUDGE[intent].note}` : NUDGE[intent].note,
  call,
});

/* -------------------------------------------------------- coarse intent map */

const INTENT_BY_BIN: Record<string, Intent> = {
  cat: "read",
  head: "read",
  tail: "read",
  sed: "read",
  ls: "list",
  find: "list",
  fd: "list",
  tree: "list",
  grep: "search",
  egrep: "search",
  fgrep: "search",
  rg: "search",
  ack: "search",
  git: "git",
  rm: "mutate",
  mkdir: "mutate",
  cp: "mutate",
  mv: "mutate",
  ln: "mutate",
  chmod: "mutate",
  touch: "mutate",
  wc: "measure",
  du: "measure",
  stat: "measure",
  shasum: "measure",
  sha256sum: "measure",
  md5sum: "measure",
  diff: "diff",
  npm: "npm",
  npx: "npm",
  tsc: "npm",
  gradlew: "gradle",
  gradle: "gradle",
  unzip: "archive",
  jar: "archive",
  javap: "archive",
  tar: "archive",
  which: "env",
  printenv: "env",
  env: "env",
  kill: "background",
  pkill: "background",
  pi: "pi",
};

/** Binaries that mean "this is a real script", never a tool-replaceable one-liner. */
const SCRIPT_BINS = new Set([
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "awk",
  "jq",
  "bash",
  "sh",
  "zsh",
  "tsx",
  "deno",
  "bun",
  "xxd",
  "base64",
  "tee",
  "sort",
  "uniq",
  "cut",
  "tr",
  "curl",
]);

/** git subcommands the git tool can actually express. */
const GIT_TOOL_SUBS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "branch",
  "stash",
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "checkout",
  "switch",
  "reset",
  "merge-base",
  "rev-parse",
]);

function intentOf(seg: Segment): Intent | null {
  const words = seg.words;
  const b = bin(words[0]?.v ?? "");
  if (b === "gradlew" || b === "gradle") {
    // `./gradlew --stop` / `--status` are daemon control, not a build.
    return words.slice(1).some((w) => !w.v.startsWith("-")) ? "gradle" : null;
  }
  if (SCRIPT_BINS.has(b)) return null;
  // `find ... -exec/-delete` does real work; suggesting list_files would be wrong.
  if (b === "find" && words.some((w) => /^-(exec|execdir|delete|ok|prune)$/.test(w.v))) return null;
  if (b === "sed" && words.some((w) => w.v === "-i" && !w.qs)) return null; // in-place edit, not a read
  if (b === "git") {
    const sub = words[1]?.v ?? "";
    if (!GIT_TOOL_SUBS.has(sub)) return null; // remote, config, rebase, cherry-pick, ...
    if (sub === "branch" && words.slice(2).some((w) => /^-(m|M|d|D|c|C|u|-move|-delete|-copy)$/.test(w.v))) return null;
    if (sub === "stash" && words[2]?.v !== "list") return null;
    return "git";
  }
  if (b === "pi") {
    // Only a `pi` *run* has a pi_trace equivalent; --help/--version/--list-models do not.
    return words.slice(1).some((w) => w.v === "-p" || w.v === "--mode" || w.v === "--print") ? "pi" : null;
  }
  return INTENT_BY_BIN[b] ?? null;
}

/** Scanning `/`, `/Users`, `/opt`, or $HOME is not something to redirect into list_files. */
function isBroadRoot(p: string, home: string): boolean {
  if (p === "/" || p === home) return true;
  return p.startsWith("/") && p.split("/").filter(Boolean).length <= 1;
}

/* ------------------------------------------------------------- main entry */

export function classify(command: string, env: ClassifyEnv): Decision {
  const home = env.home ?? process.env.HOME ?? "/root";
  const stat = env.statPath ?? (() => "unknown" as PathKind);
  const trimmed = command.trim();
  if (!trimmed) return allow("empty");

  // Security-relevant special cases that are worth intercepting even though
  // they are pipelines: they would print secret values into the transcript.
  const envLeak = matchEnvLeak(trimmed);
  if (envLeak) return envLeak;

  const p = parseCommand(command);

  if (!isSimpleEnough(p)) {
    // Two shapes are still worth a (non-blocking) nudge — but loops/subshells/
    // assignments outrank both: those are genuinely shell work.
    if (p.flags.shellwork) return allow("loop/subshell/assignment: real shell work");
    if (p.flags.heredoc && /^\s*cat\s+>>?\s*\S+\s*<</.test(trimmed)) return nudge("writefile");
    if (p.flags.background) return nudge("background");
    return allow("shell work / not fully parseable");
  }
  if (!p.segments.length) return allow("no command");
  if (p.segments.length > 8) return allow("too many statements");

  // ---- strip a leading `cd DIR &&` prefix -------------------------------
  let segments = p.segments;
  let dir = env.cwd;
  const first = segments[0];
  if (bin(first.words[0].v) === "cd") {
    if (segments.length === 1) return allow("bare cd");
    if (first.words.length !== 2) return allow("unusual cd");
    if (isGlob(first.words[1])) return allow("cd with glob");
    if (first.words[1].v === "-") return allow("cd -");
    const nextSep = segments[1].sep;
    if (nextSep === "|" || nextSep === "&") return allow("cd piped");
    dir = expand(first.words[1].v, env.cwd, home);
    segments = segments.slice(1);
  }
  if (segments.some((s) => bin(s.words[0].v) === "cd")) return allow("multiple cd");

  const ctx: Ctx = { dir, home, stat };

  // ---- single statement -> candidate for BLOCK --------------------------
  const pipeCount = segments.filter((s) => s.sep === "|").length;
  if (segments.length === 1) {
    const r = recognize(segments[0].words, ctx);
    if (r) return r;
    const it = intentOf(segments[0]);
    return it ? nudge(it, "Not blocked (flags/arguments outside what the tool covers), but note:") : allow("unrecognised single command");
  }

  // ---- a producer + one trivial consumer we can fold into a parameter ---
  if (segments.length === 2 && pipeCount === 1) {
    const folded = foldTrivialPipe(segments[0], segments[1], ctx);
    if (folded) return folded;
  }

  // ---- composite -> NUDGE at most ---------------------------------------
  // Conditional shell logic (`a || fallback`) is real shell work.
  if (segments.some((s) => s.sep === "||")) return allow("composite with || fallback");
  // Anything that runs a script/data-processing binary anywhere is real shell work.
  for (const s of segments) {
    const sb = bin(s.words[0].v);
    if (SCRIPT_BINS.has(sb)) return allow("pipeline feeds a script/processing binary");
    if (sb === "sed" && s.words.some((w) => w.v === "-i" && !w.qs)) return allow("in-place sed edit");
  }
  // The FIRST statement decides: if the producer is not a tool-replaceable
  // command, later `rm`/`grep` cleanup steps must not drag a nudge in.
  const primary = intentOf(segments[0]);
  if (!primary) return allow("composite, producer not tool-replaceable");
  const intents = segments.map(intentOf).filter((x): x is Intent => x !== null);
  const multiSearch = intents.filter((i) => i === "search").length > 1;
  // If the producer alone would have been blockable, show that concrete call:
  // the agent then knows exactly what to run, without us blocking a pipeline.
  let approx: Call | undefined;
  const solo = recognize(segments[0].words, ctx);
  if (solo && solo.kind === "block" && solo.intent === primary) approx = solo.call;
  const extra = multiSearch
    ? "Several searches in one command: the grep tool's `queries` array runs them in ONE call."
    : approx
      ? "The first stage alone maps to a tool call (the later pipeline stages map to other parameters of the same call):"
      : undefined;
  return nudge(primary, extra, approx);
}

type Ctx = { dir: string; home: string; stat: (p: string) => PathKind };

/* ------------------------------------------------------- pipe folding */

/**
 * Only two consumers can be folded into a tool parameter without changing the
 * answer: `| head -N` (grep limit) and `| wc -l` (grep outputMode:'count').
 * Everything else stays a nudge.
 */
function foldTrivialPipe(producer: Segment, consumer: Segment, ctx: Ctx): Decision | null {
  const pb = bin(producer.words[0].v);
  if (!/^(grep|egrep|rg)$/.test(pb)) return null;
  const cb = bin(consumer.words[0].v);
  const cw = consumer.words.slice(1);

  if (cb === "head") {
    const nArg = headCount(cw);
    if (nArg === null) return null;
    const r = recognizeGrep(producer.words, ctx, { limit: nArg });
    return r;
  }
  if (cb === "wc") {
    if (cw.length !== 1 || cw[0].v !== "-l") return null;
    const r = recognizeGrep(producer.words, ctx, { countMode: true });
    return r;
  }
  return null;
}

function headCount(ws: Word[]): number | null {
  if (!ws.length) return 10;
  if (ws.length === 1) {
    const m = /^-(?:n)?(\d+)$/.exec(ws[0].v);
    if (m) return Number(m[1]);
    return null;
  }
  if (ws.length === 2 && ws[0].v === "-n" && /^\d+$/.test(ws[1].v)) return Number(ws[1].v);
  return null;
}

/* ---------------------------------------------------------- recognizers */

function recognize(words: Word[], ctx: Ctx): Decision | null {
  const b = bin(words[0].v);
  switch (b) {
    case "cat":
      return recognizeCat(words, ctx);
    case "head":
      return recognizeHead(words, ctx);
    case "tail":
      return recognizeTail(words, ctx);
    case "sed":
      return recognizeSed(words, ctx);
    case "ls":
      return recognizeLs(words, ctx);
    case "find":
      return recognizeFind(words, ctx);
    case "grep":
    case "egrep":
    case "rg":
      return recognizeGrep(words, ctx, {});
    case "git":
      return recognizeGit(words, ctx);
    case "rm":
    case "mkdir":
    case "cp":
    case "mv":
    case "ln":
    case "chmod":
    case "touch":
      return recognizeMutate(b, words, ctx);
    case "wc":
    case "du":
    case "stat":
    case "shasum":
    case "sha256sum":
      return recognizeMeasure(b, words, ctx);
    case "diff":
      return recognizeDiff(words, ctx);
    case "npm":
    case "npx":
      return recognizeNpm(b, words, ctx);
    case "gradlew":
    case "gradle":
      return recognizeGradle(words, ctx);
    case "unzip":
    case "jar":
      return recognizeArchive(b, words, ctx);
    case "which":
      return recognizeWhich(words);
    case "printenv":
      return {
        kind: "block",
        intent: "env",
        tool: "env_info",
        call: { tool: "env_info", args: { action: "env", envVars: words.slice(1).map((w) => w.v) } },
        why: "printenv writes secret values verbatim into the transcript; env_info reports set/unset + length and redacts credential-like values.",
        notes: [],
      };
    default:
      return null;
  }
}

/* ----- read ---------------------------------------------------------- */

function recognizeCat(words: Word[], ctx: Ctx): Decision | null {
  const args = words.slice(1);
  if (!args.length) return null;
  if (args.some((w) => w.v.startsWith("-"))) return null;
  if (hasGlob(args)) return null;
  const paths = args.map((w) => expand(w.v, ctx.dir, ctx.home));
  if (paths.some((p) => ctx.stat(p) === "dir")) return null;
  if (paths.length === 1) {
    return {
      kind: "block",
      intent: "read",
      tool: "read",
      call: { tool: "read", args: { path: paths[0] } },
      why: "`cat FILE` is exactly what read does, with line numbers and a size-aware cap.",
      notes: [],
    };
  }
  if (paths.length > 10) return null;
  return {
    kind: "block",
    intent: "read",
    tool: "multi_file_read",
    call: { tool: "multi_file_read", args: { files: paths.map((path) => ({ path })) } },
    why: "multiple files in one call, each with its own header and line numbers, instead of one concatenated blob.",
    notes: [],
  };
}

function recognizeHead(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const files: Word[] = [];
  let limit = 10;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (!isFlag(w)) {
      files.push(w);
      continue;
    }
    const m = /^-(?:n)?(\d+)$/.exec(w.v);
    if (m) {
      limit = Number(m[1]);
      continue;
    }
    if (w.v === "-n" && /^\d+$/.test(rest[i + 1]?.v ?? "")) {
      limit = Number(rest[i + 1].v);
      i++;
      continue;
    }
    return null; // -c, -q, negative counts, unknown flags
  }
  if (files.length !== 1 || hasGlob(files)) return null;
  const path = expand(files[0].v, ctx.dir, ctx.home);
  if (ctx.stat(path) === "dir") return null;
  return {
    kind: "block",
    intent: "read",
    tool: "read",
    call: { tool: "read", args: { path, limit } },
    why: "`head -N FILE` is read with limit:N.",
    notes: [],
  };
}

function recognizeTail(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  if (rest.some((w) => w.v === "-f" || w.v === "-F")) return nudge("background", "`tail -f` follows a file:");
  const files = rest.filter((w) => !w.v.startsWith("-"));
  if (files.length !== 1) return null;
  // read has no "last N lines" mode: path_stats first, then read with offset.
  const path = expand(files[0].v, ctx.dir, ctx.home);
  return nudge(
    "measure",
    `\`tail\` has no exact tool equivalent: path_stats {"paths":["${path}"]} gives the line count, then read with offset. Blocking nothing here —`,
  );
}

function recognizeSed(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  if (!rest.length) return null;
  let quiet = false;
  const nonFlag: Word[] = [];
  for (const w of rest) {
    if (w.v === "-n" && !w.qs) {
      quiet = true;
      continue;
    }
    if (isFlag(w)) return null; // -i, -E, -e ... real sed work
    nonFlag.push(w);
  }
  if (!quiet || nonFlag.length !== 2) return null;
  const script = nonFlag[0].v;
  const path = expand(nonFlag[1].v, ctx.dir, ctx.home);
  if (isGlob(nonFlag[1]) || ctx.stat(path) === "dir") return null;
  let offset: number | null = null;
  let limit: number | null = null;
  let m = /^(\d+),(\d+)p$/.exec(script);
  if (m) {
    offset = Number(m[1]);
    limit = Number(m[2]) - Number(m[1]) + 1;
  } else if ((m = /^(\d+),\$p$/.exec(script))) {
    offset = Number(m[1]);
  } else if ((m = /^(\d+)p$/.exec(script))) {
    offset = Number(m[1]);
    limit = 1;
  } else return null;
  if (offset < 1 || (limit !== null && limit < 1)) return null;
  const args: Record<string, unknown> = { path, offset };
  if (limit !== null) args.limit = limit;
  return {
    kind: "block",
    intent: "read",
    tool: "read",
    call: { tool: "read", args },
    why: `\`sed -n '${script}'\` is exactly read's offset/limit, and read's output is line-numbered so the range stays citable.`,
    notes: [],
  };
}

/* ----- list ---------------------------------------------------------- */

const LS_OK = new Set(["l", "a", "A", "h", "1", "t", "S", "R", "F", "p", "G", "s"]);

function recognizeLs(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const paths: Word[] = [];
  const set = new Set<string>();
  for (const w of rest) {
    if (w.v.startsWith("--")) {
      if (/^--(color|group-directories-first)(=.*)?$/.test(w.v)) continue;
      return null;
    }
    if (isFlag(w)) {
      for (const ch of w.v.slice(1)) {
        if (!LS_OK.has(ch)) return null; // -r (reverse), -d, -i, ...
        set.add(ch);
      }
      continue;
    }
    paths.push(w);
  }
  const args: Record<string, unknown> = {};
  const globs: string[] = [];
  const roots: string[] = [];
  for (const w of paths) {
    if (isGlob(w)) {
      const idx = w.v.lastIndexOf("/");
      const dirPart = idx >= 0 ? w.v.slice(0, idx) : ".";
      const globPart = idx >= 0 ? w.v.slice(idx + 1) : w.v;
      if (/[*?[]/.test(dirPart)) return null;
      roots.push(expand(dirPart, ctx.dir, ctx.home));
      globs.push(globPart);
      continue;
    }
    roots.push(expand(w.v, ctx.dir, ctx.home));
  }
  if (globs.length && roots.length !== globs.length) return null;
  if (!roots.length) roots.push(ctx.dir);
  if (roots.length > 4) return null;
  if (roots.some((r) => isBroadRoot(r, ctx.home))) return null;
  args.paths = [...new Set(roots)];
  if (globs.length) args.globs = [...new Set(globs)];
  if (!set.has("R")) args.maxDepth = 1;
  if (set.has("l")) args.withMeta = true;
  if (set.has("t")) args.sortBy = "mtime";
  else if (set.has("S")) args.sortBy = "size";
  const notes: string[] = [];
  if (set.has("R")) notes.push("list_files prunes .git/build/node_modules/.gradle/dist/.idea/.venv by default — pass includeIgnored:true if you need those too.");
  return {
    kind: "block",
    intent: "list",
    tool: "list_files",
    call: { tool: "list_files", args },
    why: "`ls` is a directory listing; list_files returns it with the same metadata (and can sort/filter/count in the same call).",
    notes,
  };
}

const FIND_PRUNE_HINT =
  "list_files prunes .git/build/node_modules/.gradle/dist/.idea/.venv by default (find does not) — pass includeIgnored:true if the answer must include them.";

function recognizeFind(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const roots: string[] = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const w = rest[i];
    if (w.v.startsWith("-") || w.v === "!" || w.v === "(") break;
    if (isGlob(w)) return null;
    roots.push(expand(w.v, ctx.dir, ctx.home));
  }
  if (!roots.length) roots.push(ctx.dir);
  if (roots.length > 4) return null;
  // `find / ...` / `find ~ ...` is a whole-machine scan: list_files is not a
  // drop-in there (it prunes, caps, and sorts), so never block it.
  if (roots.some((r) => isBroadRoot(r, ctx.home))) return null;

  const globs: string[] = [];
  const excludeGlobs: string[] = [];
  let type: string | undefined;
  let maxDepth: number | undefined;
  let modifiedAfter: string | undefined;
  let countOnly = false;
  let negate = false;
  let sawOr = false;

  for (; i < rest.length; i++) {
    const t = rest[i].v;
    const next = rest[i + 1];
    const take = (): string | null => {
      if (!next) return null;
      i++;
      return next.v;
    };
    if (t === "!" || t === "-not") {
      negate = true;
      continue;
    }
    if (t === "-o" || t === "-or") {
      sawOr = true;
      negate = false;
      continue;
    }
    if (t === "-a" || t === "-and") continue;
    if (t === "-print") continue;
    if (t === "-name" || t === "-iname") {
      const g = take();
      if (g === null) return null;
      (negate ? excludeGlobs : globs).push(g);
      negate = false;
      continue;
    }
    if (t === "-path" || t === "-ipath" || t === "-wholename") {
      const g = take();
      if (g === null) return null;
      if (!negate) return null; // positive path filters have no direct equivalent
      excludeGlobs.push(g.replace(/^\.\//, "**/"));
      negate = false;
      continue;
    }
    if (t === "-type") {
      const v = take();
      if (v === "f") type = "file";
      else if (v === "d") type = "dir";
      else return null;
      if (negate) return null;
      continue;
    }
    if (t === "-maxdepth") {
      const v = take();
      if (v === null || !/^\d+$/.test(v)) return null;
      maxDepth = Number(v);
      continue;
    }
    if (t === "-mmin" || t === "-mtime") {
      const v = take();
      if (v === null) return null;
      const m = /^-(\d+)$/.exec(v);
      if (!m) return null; // +N (older than) has no equivalent
      modifiedAfter = t === "-mmin" ? `${m[1]}m` : `${m[1]}d`;
      continue;
    }
    if (t === "-newermt") {
      const v = take();
      if (v === null) return null;
      modifiedAfter = v;
      continue;
    }
    return null; // -exec, -delete, -size, -perm, -empty, -prune, -depth, ...
  }
  if (negate) return null;
  if (sawOr && excludeGlobs.length) return null;

  const args: Record<string, unknown> = { paths: roots };
  if (globs.length) args.globs = globs;
  if (excludeGlobs.length) args.excludeGlobs = excludeGlobs;
  if (type) args.type = type;
  if (maxDepth !== undefined) args.maxDepth = maxDepth;
  if (modifiedAfter) args.modifiedAfter = modifiedAfter;
  if (countOnly) args.countOnly = true;
  return {
    kind: "block",
    intent: "list",
    tool: "list_files",
    call: { tool: "list_files", args },
    why: "`find` by name/type/depth/mtime is exactly what list_files does, without shell quoting or a 2>/dev/null filter.",
    notes: [FIND_PRUNE_HINT],
  };
}

/* ----- search -------------------------------------------------------- */

const GREP_BOOL = new Set([
  "r",
  "R",
  "n",
  "i",
  "l",
  "L",
  "c",
  "q",
  "w",
  "v",
  "o",
  "E",
  "F",
  "s",
  "I",
]);

/**
 * `grep`/`egrep` default to POSIX BRE, where `\|` is alternation and a bare `|`
 * is a LITERAL pipe - the exact opposite of the ERE/Rust regex the grep tool
 * uses. Translating is the difference between an exact substitute and a
 * silently different search, so it is done explicitly here (or we bail).
 * Returns null when the pattern cannot be translated with confidence.
 */
export function breToEre(p: string): string | null {
  let out = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "\\") {
      const nx = p[i + 1];
      if (nx === undefined) return null;
      if ("|(){}+?".includes(nx)) out += nx; // BRE escape == ERE metachar
      else if (/[1-9]/.test(nx)) return null; // backreference: no equivalent
      else out += "\\" + nx; // \. \* \[ \\ \b \d \w \s ... same meaning
      i += 2;
      continue;
    }
    if (c === "[") {
      // Copy the bracket expression verbatim (everything inside is literal).
      let j = i + 1;
      if (p[j] === "^") j++;
      if (p[j] === "]") j++;
      while (j < p.length && p[j] !== "]") j++;
      if (j >= p.length) return null; // unbalanced
      out += p.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ("|(){}+?".includes(c)) out += "\\" + c; // literal in BRE, metachar in ERE
    else out += c;
    i++;
  }
  return out;
}

/**
 * Measured on a real repo: `grep -rn X --include=*.java features/subscriptions`
 * returned 647 lines, while the grep tool (ripgrep) returned 0 for the same
 * arguments, because every match lived in the gitignored `build/` subtree.
 * ripgrep DOES search an ignored directory when it is the explicit root, so the
 * divergence is not statically decidable - hence a loud, actionable caveat, and
 * no block at all when the command's whole point is an exact count.
 */
const RG_GITIGNORE_NOTE =
  "CAVEAT: the grep tool uses ripgrep, which skips .gitignore'd files (build/, generated output, node_modules) while plain `grep -r` searches them. Measured case: 647 matching lines in bash vs 0 through the tool, because the matches lived in a gitignored build/ subtree. If the tool's result is empty or much smaller than you expect, re-send the original command with ` # guardrail:allow`.";

function recognizeGrep(words: Word[], ctx: Ctx, extra: { limit?: number; countMode?: boolean }): Decision | null {
  const prog = bin(words[0].v);
  const rest = words.slice(1);
  const on = new Set<string>();
  const include: string[] = [];
  const exclude: string[] = [];
  let pattern: string | null = null;
  let patternFromE = false;
  let context: number | undefined;
  const positionals: Word[] = [];

  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const v = w.v;
    const takeVal = (inline: string | undefined): string | null => {
      if (inline !== undefined && inline !== "") return inline;
      const nx = rest[i + 1];
      if (!nx) return null;
      i++;
      return nx.v;
    };
    if (!isFlag(w)) {
      positionals.push(w);
      continue;
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const name = eq < 0 ? v.slice(2) : v.slice(2, eq);
      const inline = eq < 0 ? undefined : v.slice(eq + 1);
      switch (name) {
        case "include": {
          const g = takeVal(inline);
          if (g === null) return null;
          include.push(g);
          continue;
        }
        case "exclude": {
          const g = takeVal(inline);
          if (g === null) return null;
          exclude.push(g);
          continue;
        }
        case "exclude-dir": {
          const g = takeVal(inline);
          if (g === null) return null;
          exclude.push(g.includes("/") ? g : `**/${g.replace(/\/$/, "")}/**`);
          continue;
        }
        case "recursive":
          on.add("r");
          continue;
        case "line-number":
          on.add("n");
          continue;
        case "ignore-case":
          on.add("i");
          continue;
        case "files-with-matches":
          on.add("l");
          continue;
        case "files-without-match":
          on.add("L");
          continue;
        case "count":
          on.add("c");
          continue;
        case "quiet":
        case "silent":
          on.add("q");
          continue;
        case "word-regexp":
          on.add("w");
          continue;
        case "invert-match":
          on.add("v");
          continue;
        case "only-matching":
          on.add("o");
          continue;
        case "extended-regexp":
          on.add("E");
          continue;
        case "fixed-strings":
          on.add("F");
          continue;
        case "no-messages":
          continue;
        case "color":
        case "colour":
          continue;
        case "regexp": {
          const pv = takeVal(inline);
          if (pv === null || pattern !== null) return null;
          pattern = pv;
          patternFromE = true;
          continue;
        }
        default:
          return null; // -P, --type, --glob, -m, --null, ...
      }
    }
    // short flag cluster
    let j = 1;
    while (j < v.length) {
      const ch = v[j];
      if (GREP_BOOL.has(ch)) {
        on.add(ch);
        j++;
        continue;
      }
      if (ch === "e") {
        const pv = takeVal(v.slice(j + 1));
        if (pv === null || pattern !== null) return null;
        pattern = pv;
        patternFromE = true;
        j = v.length;
        continue;
      }
      if (ch === "A" || ch === "B" || ch === "C") {
        const pv = takeVal(v.slice(j + 1));
        if (pv === null || !/^\d+$/.test(pv)) return null;
        const num = Number(pv);
        if (context !== undefined && context !== num) return null;
        context = num;
        j = v.length;
        continue;
      }
      return null; // unknown/unsupported short flag
    }
  }

  if (pattern === null) {
    if (!positionals.length) return null;
    pattern = positionals.shift()!.v;
  }
  if (!pattern) return null;
  if (patternFromE && positionals.length === 0 && prog !== "rg") return null;

  // Conflicting output modes -> we cannot express it faithfully.
  const modes = ["l", "L", "c", "q"].filter((f) => on.has(f));
  if (modes.length > 1) return null;
  if (on.has("L") && !on.has("l") && !on.has("r") && prog !== "rg") {
    /* grep -L on explicit files is fine */
  }
  if (extra.countMode && modes.length) return null;
  if (extra.limit !== undefined && modes.includes("c")) return null;

  const args: Record<string, unknown> = { pattern };
  const notes: string[] = [];

  // BRE -> ERE translation for plain `grep`/`fgrep` without -E/-F.
  const basicRegex = prog !== "rg" && prog !== "egrep" && !on.has("E") && !on.has("F");
  if (basicRegex && /[\\|(){}+?]/.test(pattern)) {
    const translated = breToEre(pattern);
    if (translated === null) return null;
    if (translated !== pattern) {
      args.pattern = translated;
      notes.push(
        `pattern rewritten from POSIX BRE to the grep tool's ERE dialect (\`${pattern}\` -> \`${translated}\`); it matches the same text.`,
      );
    }
  }

  // paths
  if (positionals.length > 1) return null;
  const recursive = on.has("r") || on.has("R") || prog === "rg";
  if (positionals.length === 1) {
    const w = positionals[0];
    if (isGlob(w)) return null; // `grep x *.ts` is a shell-expanded file list, not a recursive filter
    const abs = expand(w.v, ctx.dir, ctx.home);
    const kind = ctx.stat(abs);
    if (kind === "dir") args.directory = abs;
    else if (kind === "file") args.file = abs;
    else if (kind === "missing") return null;
    else if (recursive) args.directory = abs;
    else args.file = abs;
  } else if (recursive) {
    args.directory = ctx.dir;
  } else {
    return null; // reading stdin
  }

  if (on.has("i")) args.caseSensitive = false;
  if (on.has("F")) args.regex = false;
  if (on.has("w")) args.wordBoundary = true;
  if (on.has("v")) args.invertMatch = true;
  if (on.has("o")) args.onlyMatching = true;
  if (on.has("l")) args.outputMode = "filesOnly";
  if (on.has("L")) {
    args.outputMode = "filesOnly";
    args.withoutMatch = true;
  }
  if (on.has("c")) args.outputMode = "count";
  if (on.has("q")) args.outputMode = "exists";
  if (extra.countMode) args.outputMode = "count";
  if (include.length) args.include = include.length === 1 ? include[0] : include;
  if (exclude.length) args.exclude = exclude.length === 1 ? exclude[0] : exclude;
  if (context !== undefined) args.context = context;
  if (extra.limit !== undefined) args.limit = extra.limit;

  const wantsExactCount = extra.countMode || on.has("c");
  if (recursive && wantsExactCount) {
    // An exact number is precisely where silently skipping ignored files is
    // most damaging, so this shape is never blocked - only nudged.
    return nudge(
      "search",
      `Not blocked: this asks for an exact COUNT over a directory tree, and the grep tool (ripgrep) skips .gitignore'd files, so its number can differ from \`grep -r\` (measured: 647 vs 0). If ignored files do not matter, the equivalent call is:`,
      { tool: "grep", args: { ...args, outputMode: "count" } },
    );
  }
  if (recursive || args.directory) notes.push(RG_GITIGNORE_NOTE);

  const shape = extra.limit !== undefined ? " | head" : extra.countMode ? " | wc -l" : "";
  return {
    kind: "block",
    intent: "search",
    tool: "grep",
    call: { tool: "grep", args },
    why: `\`${prog}${shape}\` maps 1:1 onto the grep tool's parameters here${
      extra.limit !== undefined ? " (`| head -N` is `limit`)" : extra.countMode ? " (`| wc -l` is outputMode:'count')" : ""
    }.`,
    notes,
  };
}

/* ----- git ----------------------------------------------------------- */

function recognizeGit(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  if (!rest.length) return null;
  if (rest.some((w) => w.v === "-C" || w.v.startsWith("--git-dir"))) return null;
  const sub = rest[0].v;
  const rem = rest.slice(1);
  const flags = rem.filter((w) => w.v.startsWith("-")).map((w) => w.v);
  const pos = rem.filter((w) => !w.v.startsWith("-")).map((w) => w.v);
  const mk = (args: Record<string, unknown>, why: string): Decision => ({
    kind: "block",
    intent: "git",
    tool: "git",
    call: { tool: "git", args },
    why,
    notes: [],
  });

  switch (sub) {
    case "status": {
      if (pos.length) return null;
      if (flags.some((f) => !/^(-s|--short|--porcelain|-uall|--untracked-files(=.*)?|-b|--branch)$/.test(f))) return null;
      return mk({ action: "status" }, "the git tool's status shows branch, upstream ahead/behind and grouped staged/unstaged/untracked files in one parsed block.");
    }
    case "log": {
      if (flags.some((f) => !/^(--oneline|--no-merges|-n|-\d+|--stat|--graph|--decorate|--pretty=oneline)$/.test(f))) return null;
      if (flags.includes("--graph") || flags.includes("--stat")) return null;
      let limit: number | undefined;
      for (let i = 0; i < rem.length; i++) {
        const m = /^-(\d+)$/.exec(rem[i].v);
        if (m) limit = Number(m[1]);
        if (rem[i].v === "-n" && /^\d+$/.test(rem[i + 1]?.v ?? "")) limit = Number(rem[i + 1].v);
      }
      const nonNumericPos = pos.filter((p) => !/^\d+$/.test(p));
      if (nonNumericPos.length) return null;
      const args: Record<string, unknown> = { action: "log" };
      if (limit !== undefined) args.limit = limit;
      return mk(args, "the git tool's log returns `hash | date | author | subject` rows directly.");
    }
    case "diff": {
      const args: Record<string, unknown> = { action: "diff" };
      const gflags: string[] = [];
      const paths: string[] = [];
      let base: string | undefined;
      let sawDashDash = false;
      for (const w of rem) {
        if (w.v === "--") {
          sawDashDash = true;
          continue;
        }
        if (w.v.startsWith("-")) {
          if (w.v === "--stat") gflags.push("stat-only");
          else if (w.v === "--staged" || w.v === "--cached") gflags.push("staged");
          else return null;
          continue;
        }
        if (sawDashDash || w.v.includes("/") || w.v.includes(".")) paths.push(w.v);
        else if (base === undefined) base = w.v;
        else return null;
      }
      if (base) args.base = base;
      if (paths.length) args.paths = paths;
      if (gflags.length) args.flags = gflags;
      return mk(args, "the git tool's diff returns a per-file +/- summary plus a capped patch instead of thousands of raw lines.");
    }
    case "show": {
      if (flags.length || pos.length !== 1) return null;
      return mk({ action: "show", ref: pos[0] }, "the git tool's show is the same read, with a capped patch.");
    }
    case "blame": {
      if (pos.length !== 1) return null;
      if (flags.some((f) => !/^-L$/.test(f))) return null;
      if (flags.length) return null;
      return mk({ action: "blame", paths: [pos[0]] }, "the git tool's blame takes an optional line range and caps its output.");
    }
    case "branch": {
      if (pos.length) return null;
      if (flags.some((f) => !/^(-a|-r|-l|--list|-v|-vv)$/.test(f))) return null;
      return mk({ action: "branch" }, "the git tool's branch action lists branches (with a name filter) and marks the current one.");
    }
    case "stash": {
      if (pos.length === 1 && pos[0] === "list" && !flags.length) return mk({ action: "stash_list" }, "the git tool exposes stash_list directly.");
      return null;
    }
    case "add": {
      if (flags.some((f) => !/^(-A|--all|-u)$/.test(f))) return null;
      const args: Record<string, unknown> = { action: "add" };
      if (flags.length) args.flags = ["all"];
      if (pos.length) args.paths = pos;
      if (!pos.length && !flags.length) return null;
      return mk(args, "staging through the git tool shows the exact command and needs one explicit confirmation, so nothing is staged by accident.");
    }
    case "commit": {
      let message: string | undefined;
      const gflags: string[] = [];
      for (let i = 0; i < rem.length; i++) {
        const v = rem[i].v;
        if (v === "-m" || v === "--message") {
          const nx = rem[i + 1];
          if (!nx) return null;
          message = nx.v;
          i++;
          continue;
        }
        if (v.startsWith("-m") && v.length > 2) {
          message = v.slice(2);
          continue;
        }
        if (v === "--amend") {
          gflags.push("amend");
          continue;
        }
        if (v === "-a" || v === "--all") {
          gflags.push("all");
          continue;
        }
        if (v === "--no-verify") {
          gflags.push("no-verify");
          continue;
        }
        return null;
      }
      if (!message && !gflags.includes("amend")) return null;
      const args: Record<string, unknown> = { action: "commit" };
      if (message) args.message = message;
      if (gflags.length) args.flags = gflags;
      return mk(
        args,
        "the git tool takes a plain multi-line message (no heredoc/quoting) and shows a preview the user must approve before the commit runs.",
      );
    }
    case "push": {
      const gflags: string[] = [];
      const args: Record<string, unknown> = { action: "push" };
      for (const w of rem) {
        if (w.v === "-u" || w.v === "--set-upstream") gflags.push("set-upstream");
        else if (w.v === "-f" || w.v === "--force") gflags.push("force");
        else if (w.v === "--force-with-lease") gflags.push("force-with-lease");
        else if (w.v.startsWith("-")) return null;
      }
      if (pos.length === 1) args.remote = pos[0];
      else if (pos.length === 2) {
        args.remote = pos[0];
        args.branch = pos[1];
      } else if (pos.length > 2) return null;
      if (gflags.length) args.flags = gflags;
      return mk(args, "pushing through the git tool previews the exact command (including DANGER notes for force) and requires approval.");
    }
    default:
      return null;
  }
}

/* ----- mutations ----------------------------------------------------- */

function recognizeMutate(b: string, words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const flags: string[] = [];
  const pos: Word[] = [];
  for (const w of rest) {
    if (isFlag(w)) flags.push(w.v);
    else pos.push(w);
  }
  const abs = (w: Word) => expand(w.v, ctx.dir, ctx.home);
  const mk = (args: Record<string, unknown>, why: string): Decision => ({
    kind: "block",
    intent: "mutate",
    tool: "file_ops",
    call: { tool: "file_ops", args },
    why,
    notes: ["file_ops never mutates on the first call: it returns a plan preview plus an approval token, which is the point of routing mutations through it."],
  });

  const charFlags = new Set<string>();
  for (const f of flags) {
    if (f.startsWith("--")) return null;
    for (const ch of f.slice(1)) charFlags.add(ch);
  }

  switch (b) {
    case "rm": {
      if (!pos.length) return null;
      for (const ch of charFlags) if (!"rRfdv".includes(ch)) return null;
      const args: Record<string, unknown> = { action: "remove", paths: pos.map(abs) };
      if (charFlags.has("r") || charFlags.has("R")) args.recursive = true;
      if (charFlags.has("f")) args.force = true;
      return mk(args, "`rm` is irreversible; file_ops shows the resolved paths, entry counts and byte totals first.");
    }
    case "mkdir": {
      if (!pos.length) return null;
      for (const ch of charFlags) if (!"pv".includes(ch)) return null;
      return mk({ action: "mkdir", paths: pos.map(abs) }, "file_ops mkdir is always -p and reports exactly what it created.");
    }
    case "cp": {
      if (pos.length !== 2) return null;
      for (const ch of charFlags) if (!"rRpav".includes(ch)) return null;
      const args: Record<string, unknown> = { action: "copy", from: abs(pos[0]), to: abs(pos[1]), overwrite: "always" };
      if (charFlags.has("r") || charFlags.has("R") || charFlags.has("a")) args.recursive = true;
      return mk(args, "file_ops copy previews the resolved destination and overwrite behaviour (cp silently overwrites).");
    }
    case "mv": {
      if (pos.length !== 2) return null;
      for (const ch of charFlags) if (!"fv".includes(ch)) return null;
      return mk({ action: "move", from: abs(pos[0]), to: abs(pos[1]), overwrite: charFlags.has("f") ? "always" : "never" }, "file_ops move shows the final resolved destination before moving anything.");
    }
    case "ln": {
      if (pos.length !== 2 || !charFlags.has("s")) return null;
      for (const ch of charFlags) if (!"sfn".includes(ch)) return null;
      const args: Record<string, unknown> = { action: "symlink", from: pos[0].v, to: abs(pos[1]) };
      if (charFlags.has("f")) args.force = true;
      return mk(args, "file_ops symlink takes the target as `from` and the link as `to`, with the same relative/absolute semantics.");
    }
    case "chmod": {
      if (pos.length < 2) return null;
      for (const ch of charFlags) if (!"Rv".includes(ch)) return null;
      const mode = pos[0].v;
      if (!/^([0-7]{3,4}|[+-][rwxX]+|[ugoa]*[+-=][rwxX]+)$/.test(mode)) return null;
      const args: Record<string, unknown> = { action: "chmod", paths: pos.slice(1).map(abs), mode };
      if (charFlags.has("R")) args.recursive = true;
      return mk(args, "file_ops chmod takes the same octal/symbolic mode and previews the affected paths.");
    }
    case "touch": {
      if (!pos.length) return null;
      if (charFlags.size) return null;
      return mk({ action: "touch", paths: pos.map(abs) }, "file_ops touch creates the file (and parents with recursive:true) with a preview.");
    }
    default:
      return null;
  }
}

/* ----- measurement --------------------------------------------------- */

function recognizeMeasure(b: string, words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const flags = rest.filter(isFlag).map((w) => w.v);
  const pos = rest.filter((w) => !isFlag(w));
  if (!pos.length || hasGlob(pos)) return null;
  if (pos.length > 8) return null;
  const paths = pos.map((w) => expand(w.v, ctx.dir, ctx.home));
  const mk = (args: Record<string, unknown>, why: string): Decision => ({
    kind: "block",
    intent: "measure",
    tool: "path_stats",
    call: { tool: "path_stats", args },
    why,
    notes: [],
  });
  switch (b) {
    case "wc": {
      const metrics: string[] = [];
      for (const f of flags) {
        for (const ch of f.replace(/^-+/, "")) {
          if (ch === "l") metrics.push("lines");
          else if (ch === "c") metrics.push("bytes");
          else if (ch === "w") metrics.push("words");
          else if (ch === "m") metrics.push("bytes");
          else return null;
        }
      }
      if (!metrics.length) metrics.push("lines", "words", "bytes");
      return mk({ paths, metrics: [...new Set(metrics)] }, "path_stats' `lines` is exactly `wc -l` (newline count) and takes every path in one call.");
    }
    case "du": {
      const f = flags.join("");
      if (!/^-?[sh]*$/.test(f.replace(/-/g, "-").replace(/[^a-zA-Z-]/g, ""))) return null;
      for (const ch of f.replace(/-/g, "")) if (!"sh".includes(ch)) return null;
      return mk({ paths, recursive: true }, "path_stats with recursive:true gives du-style totals plus the largest files and a per-extension breakdown.");
    }
    case "stat": {
      if (flags.length) return null;
      return mk({ paths, metrics: ["bytes", "mtime", "type"] }, "path_stats reports size/mtime/type for several paths at once.");
    }
    case "shasum": {
      if (flags.length && !(flags.length === 1 && /^-a$/.test(flags[0]))) return null;
      const idx = rest.findIndex((w) => w.v === "-a");
      if (idx >= 0 && rest[idx + 1]?.v !== "256") return null;
      const real = paths.filter((p) => p !== "256");
      if (!real.length) return null;
      return mk({ paths: real, metrics: ["sha256"] }, "path_stats computes sha256 for several paths in one call.");
    }
    case "sha256sum":
      if (flags.length) return null;
      return mk({ paths, metrics: ["sha256"] }, "path_stats computes sha256 for several paths in one call.");
    default:
      return null;
  }
}

function recognizeDiff(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const flags: string[] = [];
  for (const w of rest) {
    if (!isFlag(w)) continue;
    if (w.v.startsWith("--")) flags.push(w.v);
    // split clusters like -rq / -ru into individual flags
    else for (const ch of w.v.slice(1)) flags.push(`-${ch}`);
  }
  const pos = rest.filter((w) => !isFlag(w));
  if (pos.length !== 2 || hasGlob(pos)) return null;
  const args: Record<string, unknown> = {
    action: "files",
    a: expand(pos[0].v, ctx.dir, ctx.home),
    b: expand(pos[1].v, ctx.dir, ctx.home),
  };
  for (const f of flags) {
    if (/^-+u(nified)?$/.test(f) || f === "-N") continue;
    if (f === "-r" || f === "--recursive") {
      args.action = "dirs";
      continue;
    }
    if (f === "-q" || f === "--brief") {
      args.outputMode = "namesOnly";
      continue;
    }
    if (f === "-w" || f === "--ignore-all-space") {
      args.ignoreWhitespace = true;
      continue;
    }
    if (f === "-B") {
      args.ignoreBlankLines = true;
      continue;
    }
    return null;
  }
  const kinds = [ctx.stat(args.a as string), ctx.stat(args.b as string)];
  if (kinds.every((k) => k === "dir")) args.action = "dirs";
  if (kinds.includes("missing")) return null;
  return {
    kind: "block",
    intent: "diff",
    tool: "diff",
    call: { tool: "diff", args },
    why: "the diff tool caps its own output, detects identical files without dumping a patch, and reports CRLF/trailing-newline differences explicitly.",
    notes: [],
  };
}

/* ----- npm / gradle / archive / env ---------------------------------- */

function recognizeNpm(b: string, words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1).map((w) => w.v);
  const mk = (args: Record<string, unknown>, why: string): Decision => ({
    kind: "block",
    intent: "npm",
    tool: "node_project",
    call: { tool: "node_project", args },
    why,
    notes: [],
  });
  if (b === "npx") {
    const args = rest.filter((a) => a !== "--yes" && a !== "-y");
    if (!args.length) return null;
    if (!/^tsc$/.test(bin(args[0])) && !/^typescript@/.test(args[0])) return null;
    const files: string[] = [];
    for (const a of args.slice(1)) {
      if (a.startsWith("-")) {
        if (/^--(noEmit|skipLibCheck|esModuleInterop|allowImportingTsExtensions|target|module|moduleResolution|strict|project|p)$/.test(a)) continue;
        if (/^--(target|module|moduleResolution|project)=/.test(a)) continue;
        return null;
      }
      if (/^(es\d+|esnext|bundler|node|node16|nodenext|commonjs|node_modules|classic)$/i.test(a)) continue; // flag values
      files.push(a);
    }
    const args2: Record<string, unknown> = { action: "typecheck" };
    if (files.length) args2.files = files;
    return mk(
      args2,
      "node_project typecheck already passes the right tsc flags, resolves a local tsc (plain `npx tsc` resolves a deprecated stub), and returns only diagnostics.",
    );
  }
  // npm
  if (!rest.length) return null;
  const sub = rest[0];
  const args = rest.slice(1);
  if (sub === "install" || sub === "i" || sub === "add") {
    const pkgs: string[] = [];
    let dev = false;
    let noSave = false;
    for (const a of args) {
      if (a === "--save-dev" || a === "-D") dev = true;
      else if (a === "--no-save") noSave = true;
      else if (a === "--silent" || a === "--omit=dev") continue;
      else if (a.startsWith("-")) return null;
      else pkgs.push(a);
    }
    const o: Record<string, unknown> = { action: "install" };
    if (pkgs.length) o.packages = pkgs;
    if (dev) o.dev = true;
    if (noSave) o.noSave = true;
    return mk(o, "node_project install returns just the resolution summary instead of npm's full output.");
  }
  if (sub === "test" && !args.length) return mk({ action: "test" }, "node_project test surfaces the failures first instead of the whole npm log.");
  if (sub === "outdated" && !args.length) return mk({ action: "outdated" }, "node_project outdated is the same query, parsed.");
  if (sub === "run" && args.length === 1) {
    if (args[0] === "build") return mk({ action: "build" }, "node_project build runs the package.json script and returns failures first.");
    if (args[0] === "test") return mk({ action: "test" }, "node_project test runs the package.json script and returns failures first.");
    return mk({ action: "test", script: args[0] }, "node_project runs a named package.json script and parses its output.");
  }
  return null;
}

function recognizeGradle(words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1).map((w) => w.v);
  if (!rest.length) return null;
  const tasks = rest.filter((a) => !a.startsWith("-"));
  const flags = rest.filter((a) => a.startsWith("-"));
  if (!tasks.length) return null;
  for (const f of flags) {
    if (!/^--(offline|continue|rerun-tasks|console=\S+|stacktrace|info|quiet|no-daemon|warning-mode=\S+|parallel|no-build-cache)$/.test(f) && !/^-P\S+=\S*$/.test(f)) {
      return null;
    }
  }
  const extraArgs = rest.slice();
  return {
    kind: "block",
    intent: "gradle",
    tool: "gradle_build",
    call: { tool: "gradle_build", args: { action: "raw", extraArgs } },
    why: "gradle_build runs the same tasks but returns BUILD status plus parsed compile diagnostics / failed tests / lint violations instead of the `> Task ... UP-TO-DATE` firehose.",
    notes: [
      "For a plain compile/test/lint run prefer the parsed form, e.g. gradle_build {\"action\":\"compile\",\"modules\":[\":app\"],\"variant\":\"Debug\"}.",
    ],
  };
}

function recognizeArchive(b: string, words: Word[], ctx: Ctx): Decision | null {
  const rest = words.slice(1);
  const flags = rest.filter((w) => w.v.startsWith("-")).map((w) => w.v);
  const pos = rest.filter((w) => !w.v.startsWith("-"));
  const mk = (args: Record<string, unknown>): Decision => ({
    kind: "block",
    intent: "archive",
    tool: "archive_inspect",
    call: { tool: "archive_inspect", args },
    why: "archive_inspect lists archive entries in-process (no temp dir, output capped, entry count reported in the header).",
    notes: [],
  });
  if (b === "unzip") {
    if (flags.length !== 1 || flags[0] !== "-l" || pos.length !== 1) return null;
    return mk({ action: "list", archive: expand(pos[0].v, ctx.dir, ctx.home) });
  }
  if (b === "jar") {
    if (pos.length !== 2) return null;
    if (!/^-?tf?$|^-?tvf$/.test(pos[0].v) && !/^tf$|^tvf$/.test(pos[0].v)) return null;
    return mk({ action: "list", archive: expand(pos[1].v, ctx.dir, ctx.home) });
  }
  return null;
}

function recognizeWhich(words: Word[]): Decision | null {
  const rest = words.slice(1).map((w) => w.v);
  if (!rest.length || rest.some((a) => a.startsWith("-") || a.includes("/"))) return null;
  return {
    kind: "block",
    intent: "env",
    tool: "env_info",
    call: { tool: "env_info", args: { action: "tools", tools: rest } },
    why: "env_info reports path + version for several tools in one call, and distinguishes ABSENT from installed-but-version-unknown.",
    notes: [],
  };
}

/**
 * `env | grep TOKEN`, `printenv X`, `echo $SECRET` — these print credential
 * values into the transcript and the session log. Intercepted even though they
 * are pipelines, because the whole point of env_info is that it redacts.
 */
function matchEnvLeak(cmd: string): Decision | null {
  const single = cmd.replace(/\s+/g, " ").trim();
  let m = /^(?:env|printenv)\s*\|\s*grep\s+(?:-\w+\s+)*['"]?([A-Za-z0-9_|.*^$]+)['"]?$/.exec(single);
  if (m) {
    return {
      kind: "block",
      intent: "env",
      tool: "env_info",
      call: { tool: "env_info", args: { action: "env", envPattern: m[1].replace(/[.*^$]/g, "") } },
      why: "`env | grep` writes secret VALUES verbatim into the transcript and session log; env_info reports set/unset + length and fingerprints credential-like values instead.",
      notes: [],
    };
  }
  m = /^echo\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(single);
  if (m) {
    return {
      kind: "block",
      intent: "env",
      tool: "env_info",
      call: { tool: "env_info", args: { action: "env", envVars: [m[1]] } },
      why: "echoing an environment variable prints its raw value into the transcript; env_info reports whether it is set (and its length) without revealing a credential.",
      notes: [],
    };
  }
  return null;
}
