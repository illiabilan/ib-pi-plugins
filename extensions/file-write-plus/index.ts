/**
 * file-write-plus — two file-mutation tools that close measured gaps in pi's
 * built-in `write`/`edit` tools:
 *
 *   append_file       replaces `cat >> file << 'EOF' ... EOF` heredoc appends.
 *                     Built-in `write` can only create/overwrite, so appending
 *                     to a log/journal file previously required a bash heredoc
 *                     (invisible to the harness, and one typo away from `>`
 *                     clobbering the whole file).
 *
 *   replace_in_file   replaces `sed -i '' 's/a/b/g' file` and the
 *                     `python3 - <<'PY' ... s.replace(...) ... PY` idiom.
 *                     Built-in `edit` requires a UNIQUE exact match, so repeated
 *                     or pattern-based replacements previously fell back to
 *                     inline shell/python rewrites.
 *
 * Safety properties (all validated empirically, see README.md):
 *   - byte-exact round-trip: the file is only changed at replacement sites.
 *     CRLF vs LF, missing final newline, BOM and unicode are all preserved.
 *   - non-UTF-8 / binary files are refused instead of being corrupted.
 *   - regex scanning runs inside a worker thread with a hard timeout, so a
 *     catastrophically-backtracking pattern can never hang the agent.
 *   - dryRun (the default for replace_in_file) never opens a file for writing.
 *   - both tools participate in pi's per-file mutation queue, so they cannot
 *     race with built-in edit/write in the same assistant turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

/** Files larger than this are refused outright (we read them fully into memory). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Hard wall-clock budget for one regex scan. Guards catastrophic backtracking. */
const REGEX_TIMEOUT_MS = 5_000;
/** Refuse (rather than truncate) more replacements than this per file when maxReplacements is unset. */
const DEFAULT_MAX_REPLACEMENTS = 200;
/** Absolute ceiling on matches collected per file, so a runaway pattern cannot OOM us. */
const MATCH_HARD_CAP = 100_000;
/** How many changed-line groups to show per file in the preview. */
const PREVIEW_GROUPS_PER_FILE = 25;
/** Clip a single previewed line to this many characters. */
const PREVIEW_LINE_CHARS = 400;
/** Overall character cap on the text returned to the LLM. */
const MAX_OUTPUT_CHARS = 40_000;
/** Bytes of existing file tail inspected for expectedTailPattern / newline state. */
const TAIL_BYTES = 8_192;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Some models prefix path arguments with '@'. Built-in tools strip it; so do we. */
function normalizePath(cwd: string, p: string): string {
  return resolve(cwd, p.replace(/^@/, ""));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Line count with the same convention as `wc -l`+1 for a file with no final
 * newline: "a\n" is 1 line, "a" is 1 line, "a\nb" is 2 lines, "" is 0 lines.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (!text.endsWith("\n")) n++;
  return n;
}

/** Streaming line count so we never have to hold a huge file in memory just to report totals. */
async function countLinesInFile(path: string): Promise<{ lines: number; bytes: number }> {
  return new Promise((res, rej) => {
    let lines = 0;
    let bytes = 0;
    let lastByte = -1;
    const s = createReadStream(path);
    s.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
      if (buf.length > 0) lastByte = buf[buf.length - 1]!;
    });
    s.on("end", () => res({ lines: bytes === 0 ? 0 : lines + (lastByte === 10 ? 0 : 1), bytes }));
    s.on("error", rej);
  });
}

/** Dominant end-of-line sequence in a chunk of text. */
function detectEol(text: string): "CRLF" | "LF" | "none" {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (crlf === 0 && lf === 0) return "none";
  return crlf > lf ? "CRLF" : "LF";
}

/**
 * Read a text file, refusing anything that would not survive a UTF-8 round-trip.
 * This is the single guarantee that keeps us from silently corrupting encodings:
 * we re-encode the decoded string and require it to be byte-identical.
 */
async function readTextFileStrict(
  path: string,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; error: string }> {
  let st;
  try {
    st = await stat(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: false, error: `file does not exist: ${path}` };
    return { ok: false, error: `cannot stat ${path}: ${e?.message ?? String(e)}` };
  }
  if (st.isDirectory()) return { ok: false, error: `path is a directory, not a file: ${path}` };
  if (st.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `file is ${formatBytes(st.size)}, above the ${formatBytes(MAX_FILE_BYTES)} limit for replace_in_file: ${path}`,
    };
  }
  const buf = await readFile(path);
  if (buf.includes(0)) {
    return { ok: false, error: `refusing to edit binary file (contains NUL bytes): ${path}` };
  }
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) {
    return {
      ok: false,
      error:
        `refusing to edit ${path}: it is not valid UTF-8, so rewriting it would corrupt the encoding. ` +
        `Convert it first (e.g. iconv) or use a byte-level tool.`,
    };
  }
  return { ok: true, text, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// guarded regex scanning
// ---------------------------------------------------------------------------

interface RawMatch {
  index: number;
  length: number;
  /** groups[0] is the whole match; groups[n] is capture n (may be undefined). */
  groups: (string | undefined)[];
  named?: Record<string, string | undefined>;
}

type ScanOutcome =
  | { ok: true; matches: RawMatch[]; scanner: "worker-guarded" | "inline-fallback"; capped: boolean }
  | { ok: false; error: string; kind: "timeout" | "empty-match" | "regex" | "internal" };

/**
 * Worker body, kept as a plain JS string so jiti never has to transpile it and so
 * the isolate can be hard-terminated (worker.terminate()) mid-regex. This is the
 * only reliable way to bound a catastrophically-backtracking RegExp in Node:
 * a single exec() call is not interruptible from the same thread.
 */
const SCAN_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
// NOTE: worker bodies are modules, so a bare top-level 'return' is a SyntaxError
// ('Illegal return statement') that turns every regex scan into an error. Keep the
// early-exit paths inside this function.
function scan() {
  const { content, source, flags, hardCap } = workerData;
  const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
  const matches = [];
  let m, capped = false;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length === 0) return { kind: 'empty-match' };
    matches.push({ index: m.index, length: m[0].length, groups: Array.prototype.slice.call(m), named: m.groups ? Object.assign({}, m.groups) : undefined });
    if (matches.length >= hardCap) { capped = true; break; }
  }
  return { kind: 'ok', matches, capped };
}
try {
  parentPort.postMessage(scan());
} catch (e) {
  parentPort.postMessage({ kind: 'regex', message: (e && e.message) || String(e) });
}
`;

async function scanRegex(
  content: string,
  source: string,
  flags: string,
  signal?: AbortSignal,
): Promise<ScanOutcome> {
  // Fail fast on an invalid pattern in-process: cheap, and gives a better message.
  try {
    new RegExp(source, flags);
  } catch (e: any) {
    return { ok: false, error: `invalid regex /${source}/${flags}: ${e?.message ?? String(e)}`, kind: "regex" };
  }

  // Test seam: lets the validation suite exercise the degraded (unguarded) path,
  // which would otherwise only run on a machine where worker threads are unavailable.
  if (process.env.FWP_FORCE_INLINE_SCAN === "1") return inlineScan(content, source, flags);

  let worker: Worker;
  try {
    worker = new Worker(SCAN_WORKER_SRC, {
      eval: true,
      workerData: { content, source, flags, hardCap: MATCH_HARD_CAP },
    });
  } catch {
    // Degraded path: no worker available. Tagged in the output so the caller knows
    // this scan was NOT protected by the backtracking timeout.
    return inlineScan(content, source, flags);
  }

  return await new Promise<ScanOutcome>((res) => {
    let settled = false;
    const finish = (outcome: ScanOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      res(outcome);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        kind: "timeout",
        error:
          `regex scan exceeded ${REGEX_TIMEOUT_MS} ms and was aborted (possible catastrophic backtracking in ` +
          `/${source}/${flags}). Simplify the pattern (avoid nested quantifiers like (a+)+), anchor it, or use mode:"literal".`,
      });
    }, REGEX_TIMEOUT_MS);
    const onAbort = () => finish({ ok: false, kind: "internal", error: "cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (msg: any) => {
      if (msg?.kind === "ok") {
        finish({ ok: true, matches: msg.matches as RawMatch[], scanner: "worker-guarded", capped: !!msg.capped });
      } else if (msg?.kind === "empty-match") {
        finish({
          ok: false,
          kind: "empty-match",
          error: `pattern /${source}/${flags} can match the empty string, which makes replacement ambiguous. Make the pattern require at least one character.`,
        });
      } else {
        finish({ ok: false, kind: "regex", error: `regex error: ${msg?.message ?? "unknown"}` });
      }
    });
    worker.on("error", (e) => finish({ ok: false, kind: "internal", error: `scan worker failed: ${e.message}` }));
    worker.on("exit", (code) => {
      if (!settled) finish({ ok: false, kind: "internal", error: `scan worker exited early (code ${code})` });
    });
  });
}

/** Unguarded in-process scan; only used when a worker cannot be created. */
function inlineScan(content: string, source: string, flags: string): ScanOutcome {
  try {
    const re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
    const matches: RawMatch[] = [];
    let m: RegExpExecArray | null;
    let capped = false;
    while ((m = re.exec(content)) !== null) {
      if (m[0].length === 0) {
        return {
          ok: false,
          kind: "empty-match",
          error: `pattern /${source}/${flags} can match the empty string, which makes replacement ambiguous.`,
        };
      }
      matches.push({ index: m.index, length: m[0].length, groups: Array.from(m), named: m.groups });
      if (matches.length >= MATCH_HARD_CAP) {
        capped = true;
        break;
      }
    }
    return { ok: true, matches, scanner: "inline-fallback", capped };
  } catch (e: any) {
    return { ok: false, kind: "regex", error: `invalid regex: ${e?.message ?? String(e)}` };
  }
}

/** Literal scan: linear, no backtracking, safe on arbitrarily large files. */
function scanLiteral(content: string, needle: string, caseSensitive: boolean): RawMatch[] {
  const matches: RawMatch[] = [];
  const hay = caseSensitive ? content : content.toLowerCase();
  const nee = caseSensitive ? needle : needle.toLowerCase();
  let from = 0;
  while (true) {
    const i = hay.indexOf(nee, from);
    if (i === -1) break;
    matches.push({ index: i, length: needle.length, groups: [content.slice(i, i + needle.length)] });
    from = i + needle.length; // non-overlapping, like sed/str.replace
    if (matches.length >= MATCH_HARD_CAP) break;
  }
  return matches;
}

/**
 * Expand $-references in a replacement string exactly like String.prototype.replace
 * with a string replacement ($$, $&, $`, $', $n, $nn, $<name>). Anything else,
 * including backslash escapes, is inserted verbatim — we never interpret "\n".
 */
function expandReplacement(replace: string, m: RawMatch, content: string): string {
  let out = "";
  for (let i = 0; i < replace.length; i++) {
    const c = replace[i];
    if (c !== "$" || i === replace.length - 1) {
      out += c;
      continue;
    }
    const n = replace[i + 1]!;
    if (n === "$") {
      out += "$";
      i++;
    } else if (n === "&") {
      out += m.groups[0] ?? "";
      i++;
    } else if (n === "`") {
      out += content.slice(0, m.index);
      i++;
    } else if (n === "'") {
      out += content.slice(m.index + m.length);
      i++;
    } else if (n === "<") {
      const close = replace.indexOf(">", i + 2);
      if (close === -1 || !m.named) {
        out += c;
      } else {
        const name = replace.slice(i + 2, close);
        out += m.named[name] ?? "";
        i = close;
      }
    } else if (n >= "0" && n <= "9") {
      const two = replace.slice(i + 1, i + 3);
      let used = 0;
      let idx = -1;
      if (/^\d\d$/.test(two) && Number(two) > 0 && Number(two) < m.groups.length) {
        idx = Number(two);
        used = 2;
      } else if (Number(n) > 0 && Number(n) < m.groups.length) {
        idx = Number(n);
        used = 1;
      }
      if (idx === -1) {
        out += c; // no such group: leave "$7" literal, like JS does
      } else {
        out += m.groups[idx] ?? "";
        i += used;
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** Byte offsets of the start of every line, for offset -> line-number mapping. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo; // 0-based
}

function clip(s: string): string {
  const oneLine = s.replace(/\r/g, "");
  return oneLine.length > PREVIEW_LINE_CHARS ? oneLine.slice(0, PREVIEW_LINE_CHARS) + " …[clipped]" : oneLine;
}

// ---------------------------------------------------------------------------
// replace_in_file
// ---------------------------------------------------------------------------

const ReplaceParams = Type.Object({
  path: Type.Optional(Type.String({ description: "File to modify (or use `paths`)." })),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Several files getting the SAME replacement in one call (replaces a `for f in ...; do sed -i` loop)." }),
  ),
  find: Type.String({ description: "Verbatim text in mode:'literal', a JS regex source in mode:'regex'." }),
  replace: Type.String({
    description: "Inserted verbatim, except that in mode:'regex' $1/$&/$<name>/$$ expand to capture groups. Backslash escapes are never interpreted (use a real newline).",
  }),
  mode: Type.Optional(StringEnum(["literal", "regex"] as const, { description: "'literal' (default, no escaping) or 'regex'." })),
  flags: Type.Optional(Type.String({ description: "Extra regex flags, e.g. 'm'/'s'. Do not pass 'g'/'i' (see caseSensitive)." })),
  replaceAll: Type.Optional(Type.Boolean({ description: "Default true; with false the call is refused if more than one occurrence exists.", default: true })),
  maxReplacements: Type.Optional(Type.Number({ description: `Per-file cap (default ${DEFAULT_MAX_REPLACEMENTS}); exceeding it writes nothing.` })),
  dryRun: Type.Optional(Type.Boolean({ description: "Default TRUE = preview only, nothing written. Pass false to apply.", default: true })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "Default true.", default: true })),
});
type ReplaceParamsT = Static<typeof ReplaceParams>;

interface FileOutcome {
  path: string;
  status: "ok" | "no-match" | "error" | "over-cap" | "ambiguous";
  message?: string;
  matchCount: number;
  eol: "CRLF" | "LF" | "none";
  endsWithNewline: boolean;
  scanner?: "worker-guarded" | "inline-fallback" | "literal";
  preview: string[];
  newText?: string;
  bytesBefore?: number;
  bytesAfter?: number;
}

/** Build the replaced text plus a grouped, line-numbered preview. */
function buildPlan(
  text: string,
  matches: RawMatch[],
  replace: string,
  mode: "literal" | "regex",
): { newText: string; preview: string[]; shown: number } {
  const starts = lineStarts(text);
  const expanded = matches.map((m) => (mode === "regex" ? expandReplacement(replace, m, text) : replace));

  // new text: single left-to-right pass
  let out = "";
  let last = 0;
  matches.forEach((m, i) => {
    out += text.slice(last, m.index) + expanded[i];
    last = m.index + m.length;
  });
  out += text.slice(last);

  // group matches that touch the same (or an overlapping) line span
  type Group = { first: number; last: number; startLine: number; endLine: number };
  const groups: Group[] = [];
  matches.forEach((m, i) => {
    const sl = lineOf(starts, m.index);
    const el = lineOf(starts, m.index + m.length - 1);
    const prev = groups[groups.length - 1];
    if (prev && sl <= prev.endLine) {
      prev.last = i;
      prev.endLine = Math.max(prev.endLine, el);
    } else {
      groups.push({ first: i, last: i, startLine: sl, endLine: el });
    }
  });

  const preview: string[] = [];
  const shown = Math.min(groups.length, PREVIEW_GROUPS_PER_FILE);
  for (let g = 0; g < shown; g++) {
    const grp = groups[g]!;
    const spanStart = starts[grp.startLine]!;
    const nextLineStart = starts[grp.endLine + 1];
    const spanEnd = nextLineStart === undefined ? text.length : nextLineStart - 1; // exclude the \n
    const before = text.slice(spanStart, spanEnd);
    let after = "";
    let cur = spanStart;
    for (let i = grp.first; i <= grp.last; i++) {
      const m = matches[i]!;
      after += text.slice(cur, m.index) + expanded[i];
      cur = m.index + m.length;
    }
    after += text.slice(cur, Math.max(cur, spanEnd));
    const label =
      grp.startLine === grp.endLine ? `L${grp.startLine + 1}` : `L${grp.startLine + 1}-${grp.endLine + 1}`;
    const n = grp.last - grp.first + 1;
    preview.push(`  ${label}${n > 1 ? ` (${n} matches on this line)` : ""}`);
    preview.push(`    - ${clip(before)}`);
    preview.push(`    + ${clip(after)}`);
  }
  if (groups.length > shown) {
    preview.push(`  … ${groups.length - shown} more changed line group(s) not shown`);
  }
  return { newText: out, preview, shown };
}

// ---------------------------------------------------------------------------
// append_file
// ---------------------------------------------------------------------------

const AppendParams = Type.Object({
  path: Type.String({ description: "File to append to." }),
  content: Type.String({ description: "Exact text to append, written verbatim (no escape processing)." }),
  ensureTrailingNewline: Type.Optional(Type.Boolean({ description: "Default true.", default: true })),
  startOnNewLine: Type.Optional(Type.Boolean({ description: "Insert a newline first if the file lacks one (default true).", default: true })),
  createIfMissing: Type.Optional(Type.Boolean({ description: "Create the file and parent dirs if missing (default true).", default: true })),
  expectedTailPattern: Type.Optional(
    Type.String({ description: 'Guard: JS regex that must match the END of the file (last 8 KB), e.g. "## Step 3\\\\s*", or the append is refused and the actual tail shown.' }),
  ),
});
type AppendParamsT = Static<typeof AppendParams>;

function capOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n… [output truncated at ${MAX_OUTPUT_CHARS} chars]`
    : text;
}

class FileWritePlusExtension {
  constructor(private pi: ExtensionAPI) {}

  init() {
    this.registerAppend();
    this.registerReplace();
  }

  // -------------------------------------------------------------------------

  private registerAppend() {
    this.pi.registerTool({
      name: "append_file",
      label: "Append File",
      description:
        "Append text to the END of a file without reading or rewriting it (cost independent of file size). Use " +
        "instead of `cat >> file << 'EOF'`, `echo >> file` or `tee -a`: no shell quoting/expansion hazards, no risk " +
        "of a mistyped `>` clobbering the file. Creates the file and parent dirs if missing, inserts a separating " +
        "newline when needed, reports the resulting line/byte count. expectedTailPattern asserts what you append to.",
      promptSnippet: "Append text to the end of a file (replaces `cat >> file <<EOF` heredocs)",
      promptGuidelines: [
        "Use append_file to add text at the end of a file (logs, journals, changelogs, notes) instead of " +
          "`cat >> file << 'EOF'`, `echo >> file`, `tee -a` or a read+write/edit round-trip. Use built-in write " +
          "instead when creating a file from scratch or replacing its whole contents.",
      ],
      parameters: AppendParams,
      execute: async (_id, rawParams, signal, _onUpdate, ctx) => {
        const p = rawParams as AppendParamsT;
        const abs = normalizePath(ctx.cwd, p.path);
        const ensureTrailingNewline = p.ensureTrailingNewline !== false;
        const startOnNewLine = p.startOnNewLine !== false;
        const createIfMissing = p.createIfMissing !== false;

        return withFileMutationQueue(abs, async () => {
          let existed = true;
          let size = 0;
          try {
            const st = await stat(abs);
            if (st.isDirectory()) throw new Error(`path is a directory, not a file: ${abs}`);
            size = st.size;
          } catch (e: any) {
            if (e?.code === "ENOENT") existed = false;
            else throw e;
          }

          if (!existed && !createIfMissing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: file does not exist and createIfMissing is false: ${abs}`,
                },
              ],
              details: { error: "ENOENT", path: abs },
            };
          }

          // Inspect the tail (never the whole file) to decide on separators and check the guard.
          let tail = "";
          if (existed && size > 0) {
            const fh = await open(abs, "r");
            try {
              const len = Math.min(TAIL_BYTES, size);
              const buf = Buffer.alloc(len);
              await fh.read(buf, 0, len, size - len);
              tail = buf.toString("utf8");
            } finally {
              await fh.close();
            }
          }

          if (p.expectedTailPattern !== undefined) {
            if (!existed || size === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Error: expectedTailPattern was given but ${abs} ` +
                      `${existed ? "is empty" : "does not exist"}, so the guard cannot hold. ` +
                      `Drop expectedTailPattern to create/seed the file.`,
                  },
                ],
                details: { error: "tail-guard-unverifiable", path: abs },
              };
            }
            // Anchor at end-of-tail; run under the same worker guard as replace_in_file.
            const anchored = `(?:${p.expectedTailPattern})$`;
            const scan = await scanRegex(tail, anchored, "", signal);
            if (!scan.ok) {
              return {
                content: [{ type: "text" as const, text: `Error: expectedTailPattern rejected: ${scan.error}` }],
                details: { error: scan.kind, path: abs },
              };
            }
            if (scan.matches.length === 0) {
              const showed = tail.slice(-400);
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Error: expectedTailPattern /${p.expectedTailPattern}/ does not match the end of ${abs}. ` +
                      `Nothing was appended.\nActual tail (last ${showed.length} chars):\n---\n${showed}\n---`,
                  },
                ],
                details: { error: "tail-guard-failed", path: abs, tail: showed },
              };
            }
          }

          const eol = detectEol(tail) === "CRLF" ? "\r\n" : "\n";
          const tailEndsWithNewline = tail.length === 0 ? true : /\n$/.test(tail);

          let payload = p.content;
          const notes: string[] = [];
          if (existed && size > 0 && !tailEndsWithNewline && startOnNewLine) {
            payload = eol + payload;
            notes.push("inserted a leading newline (the file did not end with one)");
          }
          if (ensureTrailingNewline && payload.length > 0 && !payload.endsWith("\n")) {
            payload += eol;
            notes.push(`added a trailing ${eol === "\r\n" ? "CRLF" : "LF"} newline`);
          }

          if (!existed) await mkdir(dirname(abs), { recursive: true });

          const payloadBuf = Buffer.from(payload, "utf8");
          // O_APPEND + a single write() keeps concurrent appends from interleaving or
          // clobbering each other (this is exactly what `>>` gives us, minus the risk
          // of a mistyped `>`), and never rewrites bytes that already exist.
          const fh = await open(abs, "a");
          try {
            await fh.write(payloadBuf);
          } finally {
            await fh.close();
          }

          const totals = await countLinesInFile(abs);
          // Count the caller's own lines, not the payload: a separator newline we inserted
          // ourselves would otherwise be reported as an extra appended line.
          const appendedLines = countLines(p.content);
          const text =
            `Appended ${appendedLines} line(s) / ${formatBytes(payloadBuf.length)} to ${abs}` +
            `${existed ? "" : " (created)"}\n` +
            `  file now: ${totals.lines} lines, ${formatBytes(totals.bytes)} (was ${formatBytes(size)})\n` +
            `  EOL=${detectEol(tail) === "none" ? (payload.includes("\r\n") ? "CRLF" : "LF") : detectEol(tail)}, ends with newline: ${
              payload.endsWith("\n") || (payload.length === 0 && tailEndsWithNewline) ? "yes" : "no"
            }` +
            (notes.length ? `\n  ${notes.join("; ")}` : "");

          return {
            content: [{ type: "text" as const, text }],
            details: {
              path: abs,
              created: !existed,
              appendedBytes: payloadBuf.length,
              appendedLines,
              totalLines: totals.lines,
              totalBytes: totals.bytes,
              previousBytes: size,
              notes,
            },
          };
        });
      },
      renderCall: (args, theme) => {
        const a = args as AppendParamsT;
        const bytes = a.content ? Buffer.byteLength(a.content, "utf8") : 0;
        return new Text(
          theme.fg("toolTitle", theme.bold("append_file ")) +
            theme.fg("accent", String(a.path ?? "")) +
            theme.fg("dim", ` +${formatBytes(bytes)}`),
          0,
          0,
        );
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", "Appending…"), 0, 0);
        const first = result.content[0];
        const content = (first && "text" in first ? first.text : "") ?? "";
        if (content.startsWith("Error:")) return new Text(theme.fg("error", content), 0, 0);
        const lines = content.split("\n");
        return new Text(expanded ? content : (lines[0] ?? ""), 0, 0);
      },
    });
  }

  // -------------------------------------------------------------------------

  private registerReplace() {
    this.pi.registerTool({
      name: "replace_in_file",
      label: "Replace In File",
      description:
        "Find-and-replace across one or more files for REPEATED or PATTERN-based changes — instead of `sed -i` or an " +
        "inline `python3 ... s.replace(...)` rewrite. mode:'literal' (default) needs no escaping; mode:'regex' " +
        "supports $1 references. Returns a line-numbered before/after preview of every replacement, and refuses the " +
        "whole operation on 0 matches, on more matches than maxReplacements, or on a binary/non-UTF-8 file. CRLF vs " +
        "LF, missing final newline, BOM and unicode are preserved byte-exactly. dryRun defaults to TRUE (preview " +
        "only, nothing opened for writing).\n" +
        'Ex (rename in 3 files, one call): {paths:["a.kt","b.kt","c.kt"], find:"oldName", replace:"newName", dryRun:false}.\n' +
        "Prefer built-in `edit` for ONE unique precise change; use replace_in_file when the same text occurs several " +
        "times, spans several files, or the target is a pattern.",
      promptSnippet:
        "Multi-occurrence / regex find-and-replace across files with a preview (replaces `sed -i` and inline python rewrites)",
      promptGuidelines: [
        "Use replace_in_file for repeated or pattern-based replacements — the same string in many places or across " +
          "several files, all passed in ONE call via `paths` — instead of `sed -i`, `perl -pi -e` or an inline " +
          "`python3` rewrite; prefer built-in edit for a single unique change.",
        "replace_in_file defaults to dryRun:true (preview only). Pass dryRun:false to apply directly when confident: " +
          "the result still lists every replacement with line numbers, so no separate preview call is needed and its " +
          "per-file counts can be trusted without re-grepping. `scanner=inline-fallback` in a result means the regex " +
          "ran WITHOUT the backtracking timeout guard — treat it as lower confidence and prefer mode:'literal' on retry.",
      ],
      parameters: ReplaceParams,
      execute: async (_id, rawParams, signal, onUpdate, ctx) => {
        const p = rawParams as ReplaceParamsT;
        const mode: "literal" | "regex" = p.mode === "regex" ? "regex" : "literal";
        const dryRun = p.dryRun !== false;
        const replaceAll = p.replaceAll !== false;
        const caseSensitive = p.caseSensitive !== false;
        const maxReplacements =
          p.maxReplacements !== undefined && p.maxReplacements > 0
            ? Math.floor(p.maxReplacements)
            : DEFAULT_MAX_REPLACEMENTS;

        const rawPaths = [...(p.path ? [p.path] : []), ...(p.paths ?? [])];
        if (rawPaths.length === 0) {
          return err("Error: give `path` or `paths` (at least one file).", { error: "no-path" });
        }
        if (p.find.length === 0) {
          return err("Error: `find` must not be empty.", { error: "empty-find" });
        }
        if (mode === "literal" && p.find === p.replace) {
          return err("Error: `find` and `replace` are identical — this would be a no-op.", { error: "no-op" });
        }
        if (p.flags && /[gy]/.test(p.flags)) {
          return err(
            "Error: do not pass 'g' or 'y' in `flags` — replace_in_file always scans globally and controls " +
              "stickiness itself. Use replaceAll/maxReplacements instead.",
            { error: "bad-flags" },
          );
        }

        // de-dupe absolute paths (same file listed twice would double-apply)
        const seen = new Set<string>();
        const absPaths: string[] = [];
        for (const rp of rawPaths) {
          const abs = normalizePath(ctx.cwd, rp);
          if (!seen.has(abs)) {
            seen.add(abs);
            absPaths.push(abs);
          }
        }

        const flags = (p.flags ?? "") + (caseSensitive ? "" : "i");
        const outcomes: FileOutcome[] = [];

        for (const abs of absPaths) {
          onUpdate?.({
            content: [{ type: "text", text: `Scanning ${abs}…` }],
            details: { phase: "scan", path: abs },
          });
          // Read + scan + write all inside the per-file mutation queue, so nothing
          // else (built-in edit/write, or another replace_in_file) can slip in between.
          const outcome = await withFileMutationQueue(abs, async (): Promise<FileOutcome> => {
            const read = await readTextFileStrict(abs);
            if (!read.ok) {
              return {
                path: abs,
                status: "error",
                message: read.error,
                matchCount: 0,
                eol: "none",
                endsWithNewline: false,
                preview: [],
              };
            }
            const { text, bytes } = read;
            const eol = detectEol(text);
            const endsWithNewline = text.endsWith("\n");

            let matches: RawMatch[];
            let scanner: FileOutcome["scanner"];
            if (mode === "literal") {
              matches = scanLiteral(text, p.find, caseSensitive);
              scanner = "literal";
            } else {
              const scan = await scanRegex(text, p.find, flags, signal);
              if (!scan.ok) {
                return {
                  path: abs,
                  status: "error",
                  message: scan.error,
                  matchCount: 0,
                  eol,
                  endsWithNewline,
                  preview: [],
                };
              }
              matches = scan.matches;
              scanner = scan.scanner;
            }

            if (matches.length === 0) {
              const hints: string[] = [];
              if (eol === "CRLF" && p.find.includes("\n") && !p.find.includes("\r\n")) {
                hints.push("this file uses CRLF line endings, but `find` contains a bare \\n");
              }
              if (caseSensitive && scanLiteral(text, p.find, false).length > 0 && mode === "literal") {
                hints.push("a case-insensitive match exists (set caseSensitive:false)");
              }
              return {
                path: abs,
                status: "no-match",
                message: hints.length ? hints.join("; ") : undefined,
                matchCount: 0,
                eol,
                endsWithNewline,
                scanner,
                preview: [],
              };
            }

            if (!replaceAll && matches.length > 1) {
              return {
                path: abs,
                status: "ambiguous",
                message:
                  `${matches.length} matches but replaceAll is false — refusing to change only the first. ` +
                  "Either set replaceAll:true, or make `find` unique and use built-in edit.",
                matchCount: matches.length,
                eol,
                endsWithNewline,
                scanner,
                preview: [],
              };
            }

            const effective = replaceAll ? matches : matches.slice(0, 1);
            if (effective.length > maxReplacements) {
              return {
                path: abs,
                status: "over-cap",
                message:
                  `${effective.length} matches exceeds maxReplacements=${maxReplacements}; nothing written. ` +
                  "Narrow `find` or raise maxReplacements if this many replacements is really intended.",
                matchCount: effective.length,
                eol,
                endsWithNewline,
                scanner,
                preview: [],
              };
            }

            const plan = buildPlan(text, effective, p.replace, mode);
            if (plan.newText === text) {
              return {
                path: abs,
                status: "no-match",
                message: "matched, but the replacement is identical to the matched text (no-op)",
                matchCount: effective.length,
                eol,
                endsWithNewline,
                scanner,
                preview: [],
              };
            }

            if (!dryRun) {
              // utf8 write of a string derived from a verified-UTF-8 read: byte-exact
              // outside the replacement sites (CRLF, BOM, final-newline state intact).
              try {
                await writeFile(abs, Buffer.from(plan.newText, "utf8"));
              } catch (e: any) {
                // Report as a per-file failure rather than throwing: in a multi-file call an
                // exception here would hide which files HAD already been written.
                return {
                  path: abs,
                  status: "error",
                  message: `write failed: ${e?.message ?? String(e)}`,
                  matchCount: effective.length,
                  eol,
                  endsWithNewline,
                  scanner,
                  preview: [],
                };
              }
            }

            return {
              path: abs,
              status: "ok",
              matchCount: effective.length,
              eol,
              endsWithNewline,
              scanner,
              preview: plan.preview,
              bytesBefore: bytes,
              bytesAfter: Buffer.byteLength(plan.newText, "utf8"),
            };
          });
          outcomes.push(outcome);
        }

        const applied = outcomes.filter((o) => o.status === "ok");
        const hardErrors = outcomes.filter(
          (o) => o.status === "error" || o.status === "over-cap" || o.status === "ambiguous",
        );
        const totalReplacements = applied.reduce((n, o) => n + o.matchCount, 0);

        const lines: string[] = [];
        const header =
          applied.length === 0
            ? "NO CHANGES"
            : dryRun
              ? `DRY RUN — nothing written (${totalReplacements} replacement(s) in ${applied.length} file(s) would be applied)`
              : `APPLIED — ${totalReplacements} replacement(s) in ${applied.length} file(s)`;
        // Only claim "written" when something actually was — saying it on a NO CHANGES
        // result reads as if files were touched when nothing was opened for writing.
        lines.push(`${header}  [mode=${mode}${!dryRun && applied.length > 0 ? ", written" : ""}]`);

        for (const o of outcomes) {
          if (o.status === "ok") {
            lines.push("");
            lines.push(
              `=== ${o.path} — ${o.matchCount} replacement(s) ` +
                `(${o.eol}, final newline: ${o.endsWithNewline ? "yes" : "no"}` +
                `${o.scanner && o.scanner !== "literal" ? `, scanner=${o.scanner}` : ""}) ===`,
            );
            lines.push(...o.preview);
            if (o.bytesBefore !== undefined && o.bytesAfter !== undefined) {
              lines.push(`  size: ${formatBytes(o.bytesBefore)} -> ${formatBytes(o.bytesAfter)}`);
            }
          }
        }

        const notes = outcomes.filter((o) => o.status !== "ok");
        if (notes.length) {
          lines.push("");
          lines.push("Problems:");
          for (const o of notes) {
            const label =
              o.status === "no-match"
                ? "0 matches"
                : o.status === "error"
                  ? "error"
                  : o.status === "over-cap"
                    ? "over cap"
                    : "ambiguous";
            lines.push(`  [${label}] ${o.path}${o.message ? ` — ${o.message}` : ""}`);
          }
        }

        if (applied.length === 0) {
          lines.push("");
          lines.push(
            hardErrors.length
              ? "Nothing was changed. Fix the problems above and retry."
              : `Nothing was changed: no file contained ${mode === "regex" ? `/${p.find}/${flags}` : JSON.stringify(p.find)}. ` +
                "Verify the exact text with grep/read before retrying (watch for whitespace, case, and line endings).",
          );
        } else if (dryRun) {
          lines.push("");
          lines.push("Re-issue the same call with dryRun:false to apply these changes.");
        }

        const anyFallback = outcomes.some((o) => o.scanner === "inline-fallback");
        if (anyFallback) {
          lines.push("");
          lines.push(
            "NOTE: scanner=inline-fallback — a worker thread was unavailable, so this regex ran without the " +
              "backtracking timeout guard. Result is still correct but was not time-bounded.",
          );
        }

        return {
          content: [{ type: "text" as const, text: capOutput(lines.join("\n")) }],
          details: {
            mode,
            dryRun,
            totalReplacements,
            filesChanged: applied.map((o) => o.path),
            files: outcomes.map((o) => ({
              path: o.path,
              status: o.status,
              matches: o.matchCount,
              eol: o.eol,
              scanner: o.scanner,
              message: o.message,
            })),
          },
        };
      },
      renderCall: (args, theme) => {
        const a = args as ReplaceParamsT;
        const n = (a.path ? 1 : 0) + (a.paths?.length ?? 0);
        return new Text(
          theme.fg("toolTitle", theme.bold("replace_in_file ")) +
            theme.fg("accent", `${JSON.stringify(a.find ?? "")} -> ${JSON.stringify(a.replace ?? "")}`) +
            theme.fg("dim", ` in ${n} file(s)${a.dryRun === false ? "" : " [dry run]"}`),
          0,
          0,
        );
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", "Scanning…"), 0, 0);
        const first = result.content[0];
        const content = (first && "text" in first ? first.text : "") ?? "";
        if (content.startsWith("Error:")) return new Text(theme.fg("error", content), 0, 0);
        const lines = content.split("\n");
        if (!expanded && lines.length > 16) {
          return new Text(lines.slice(0, 16).join("\n") + `\n… and ${lines.length - 16} more lines`, 0, 0);
        }
        return new Text(content, 0, 0);
      },
    });
  }
}

function err(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function (pi: ExtensionAPI) {
  new FileWritePlusExtension(pi).init();
}
