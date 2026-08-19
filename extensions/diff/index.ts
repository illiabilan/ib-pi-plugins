/**
 * Diff extension for pi.
 *
 * Replaces the `diff`/`cmp` bash escape hatches with one bounded tool call:
 *   - `diff -u a b | head -50`                  -> {action:'files', a, b}                (auto-capped)
 *   - `diff -u a b | wc -l` / `diffstat`        -> {action:'files', a, b, outputMode:'stat'}
 *   - `diff -rq dirA dirB | head`               -> {action:'dirs', a, b}
 *   - `diff -r --exclude=... dirA dirB`         -> {action:'dirs', a, b, ignore:[...]}
 *   - `cmp -s a b && echo same`                 -> {action:'files', a, b, outputMode:'namesOnly'}
 *   - `diff <(echo "$x") <(echo "$y")`          -> {action:'text', a, b}
 *   - `diff -y a b`                             -> {action:'files', a, b, outputMode:'sideBySide'}
 *   - `diff -w`/`-B`/`-U n`                     -> ignoreWhitespace / ignoreBlankLines / contextLines
 *
 * Everything is implemented in-process (Myers diff, byte compare, stream hash) so behavior does
 * not vary between GNU and BSD `diff`, and so output is always capped with an explicit marker.
 *
 * NOT for git-tracked changes (`git diff`/`git show`) — that belongs to the git tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readlink, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/* ------------------------------------------------------------------ tunables */

/** Default unified-diff context lines (mirrors `diff -U3`). */
const DEFAULT_CONTEXT = 3;
/** Default cap on diff body lines emitted for a single file. */
const DEFAULT_MAX_LINES_PER_FILE = 300;
/** Default cap on diff body lines emitted for the whole call. */
const DEFAULT_MAX_TOTAL_LINES = 1200;
/** Hard ceiling on the caps a caller may request. */
const MAX_LINES_CEILING = 20_000;
/** Files larger than this are never line-diffed (size/hash report instead). */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
/** Bytes inspected for NUL when deciding "binary". */
const BINARY_SNIFF_BYTES = 8000;
/** After trimming the common prefix/suffix, more than this many lines -> coarse fallback. */
const MAX_MIDDLE_LINES = 20_000;
/** Myers edit-distance budget; exceeding it -> coarse fallback. */
const MAX_EDIT_DISTANCE = 4000;
/** Max files walked per tree in dirs mode. */
const MAX_WALK_FILES = 20_000;
/** Max differing files for which per-file +n/-n is computed in dirs mode. */
const DIR_DETAIL_LIMIT = 200;
/** Max entries listed per dirs-mode section (only-in-a / only-in-b / differ). */
const DIR_LIST_LIMIT = 200;
/** Side-by-side column width. */
const SBS_COL = 55;

const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  "build",
  "dist",
  "out",
  "target",
  ".gradle",
  ".idea",
  "__pycache__",
  ".venv",
];

/* ------------------------------------------------------------------- schema */

const actionEnum = ["files", "dirs", "text"] as const;
const outputModeEnum = ["unified", "stat", "namesOnly", "sideBySide"] as const;

const schema = Type.Object({
  action: Type.Union([Type.Literal("files"), Type.Literal("dirs"), Type.Literal("text")], {
    description: "files=two file paths; dirs=two directory trees (recursive); text=two inline strings.",
  }),
  a: Type.String({ description: "First side (OLD/expected): a file path, directory path, or the literal string. Relative paths allowed." }),
  b: Type.String({ description: "Second side (NEW/actual), same kind as `a`." }),
  labelA: Type.Optional(Type.String({ description: "Display label for side a." })),
  labelB: Type.Optional(Type.String({ description: "Display label for side b." })),
  outputMode: Type.Optional(
    Type.Union([Type.Literal("unified"), Type.Literal("stat"), Type.Literal("namesOnly"), Type.Literal("sideBySide")], {
      description:
        "unified=patch hunks (default for files/text); stat=only the +n/-n summary (default for dirs); namesOnly=which files differ, no content; sideBySide=two columns. For dirs, unified/sideBySide add a per-file patch.",
    }),
  ),
  contextLines: Type.Optional(Type.Number({ description: `Context lines per hunk (default ${DEFAULT_CONTEXT}, like diff -U).` })),
  ignoreWhitespace: Type.Optional(
    Type.Boolean({
      description: "Ignore in-line whitespace when matching lines (diff -w). Line-ending/trailing-newline differences are still reported as notes.",
      default: false,
    }),
  ),
  ignoreBlankLines: Type.Optional(Type.Boolean({ description: "Ignore blank lines (diff -B).", default: false })),
  maxLinesPerFile: Type.Optional(Type.Number({ description: `Diff body lines per file (default ${DEFAULT_MAX_LINES_PER_FILE}).` })),
  maxTotalLines: Type.Optional(Type.Number({ description: `Diff body lines for the whole call (default ${DEFAULT_MAX_TOTAL_LINES}).` })),
  ignore: Type.Optional(
    Type.Array(Type.String(), {
      description: `dirs only: globs to skip, replacing the default list (${DEFAULT_IGNORE.join(", ")}). Matched on basename and on the path relative to the tree root.`,
    }),
  ),
});
type ParamsT = Static<typeof schema>;

/* ------------------------------------------------------------------ helpers */

/** Some models prefix paths with '@'; built-in tools strip it, so do we. */
function cleanPath(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

function abs(p: string, cwd: string): string {
  const c = cleanPath(p);
  return isAbsolute(c) ? c : resolve(cwd, c);
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Streaming byte compare. Returns the first differing offset, or -1 when byte-identical. */
async function firstByteDiff(pathA: string, pathB: string): Promise<number> {
  const fa = await open(pathA, "r");
  const fb = await open(pathB, "r");
  try {
    const size = 256 * 1024;
    const ba = Buffer.allocUnsafe(size);
    const bb = Buffer.allocUnsafe(size);
    let offset = 0;
    for (;;) {
      const [ra, rb] = await Promise.all([fa.read(ba, 0, size, offset), fb.read(bb, 0, size, offset)]);
      const n = Math.min(ra.bytesRead, rb.bytesRead);
      for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return offset + i;
      if (ra.bytesRead !== rb.bytesRead) return offset + n;
      if (n === 0) return -1;
      offset += n;
    }
  } finally {
    await fa.close();
    await fb.close();
  }
}

/** Stream a file to collect sha256 + newline count without holding it in memory. */
async function streamStats(path: string): Promise<{ sha256: string; newlines: number; endsWithNewline: boolean }> {
  const hash = createHash("sha256");
  let newlines = 0;
  let last = 0;
  await new Promise<void>((res, rej) => {
    const s = createReadStream(path);
    s.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlines++;
      if (buf.length) last = buf[buf.length - 1]!;
    });
    s.on("end", () => res());
    s.on("error", rej);
  });
  return { sha256: hash.digest("hex").slice(0, 16), newlines, endsWithNewline: last === 0x0a };
}

async function isBinaryFile(path: string, size: number): Promise<boolean> {
  if (size === 0) return false;
  const fh = await open(path, "r");
  try {
    const n = Math.min(BINARY_SNIFF_BYTES, size);
    const buf = Buffer.allocUnsafe(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    await fh.close();
  }
}

/* --------------------------------------------------------------- line model */

interface Prepared {
  /** Lines with any trailing \r stripped (so CRLF vs LF is not treated as content). */
  lines: string[];
  /** Original 1-based line numbers of `lines` (identical to index+1 unless blank lines were filtered). */
  numbers: number[];
  crlf: number;
  lf: number;
  /** True when the file does not end with a newline character. */
  noFinalNewline: boolean;
  blanksFiltered: number;
  totalLines: number;
}

function prepare(content: string, ignoreBlankLines: boolean): Prepared {
  if (content === "")
    return { lines: [], numbers: [], crlf: 0, lf: 0, noFinalNewline: false, blanksFiltered: 0, totalLines: 0 };

  const raw = content.split("\n");
  let noFinalNewline = true;
  if (raw[raw.length - 1] === "") {
    raw.pop();
    noFinalNewline = false;
  }

  const lines: string[] = [];
  const numbers: number[] = [];
  let crlf = 0;
  let lf = 0;
  let blanksFiltered = 0;

  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]!;
    const isLast = i === raw.length - 1;
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
      if (!(isLast && noFinalNewline)) crlf++;
    } else if (!(isLast && noFinalNewline)) lf++;

    if (ignoreBlankLines && line.trim() === "") {
      blanksFiltered++;
      continue;
    }
    lines.push(line);
    numbers.push(i + 1);
  }

  return { lines, numbers, crlf, lf, noFinalNewline, blanksFiltered, totalLines: raw.length };
}

function eolName(p: Prepared): string {
  if (p.crlf > 0 && p.lf > 0) return `mixed (${p.crlf} CRLF / ${p.lf} LF)`;
  if (p.crlf > 0) return "CRLF";
  if (p.lf > 0) return "LF";
  return "none";
}

/* ---------------------------------------------------------- Myers line diff */

type Op = { t: "="; ai: number; bi: number } | { t: "-"; ai: number } | { t: "+"; bi: number };

/**
 * Classic Myers O(ND) diff (forward search + backward walk in one function, so the final (N,M)
 * endpoint is available to the backtrack). Returns null when the edit distance exceeds `maxD`,
 * which the caller turns into a coarse fallback rather than hanging.
 */
function myersDiff(a: string[], b: string[], maxD: number): Op[] | null {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  const MAX = Math.min(maxD, N + M);
  const off = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  const trace: Int32Array[] = [];
  let found = false;

  for (let d = 0; d <= MAX && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;

  const rev: Op[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ t: "=", ai: x, bi: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        rev.push({ t: "+", bi: y });
      } else {
        x--;
        rev.push({ t: "-", ai: x });
      }
    }
    x = prevX;
    y = prevY;
  }
  rev.reverse();
  return rev;
}

/* ------------------------------------------------------------- diff results */

type DiffSource = "myers" | "anchored" | "coarse-fallback" | "size-only" | "binary" | "identical";

/**
 * Unique-common-line anchoring (patience-diff style), used only when plain Myers would blow its
 * time/memory budget. Lines that occur exactly once on BOTH sides are almost certainly the same
 * line, so they can be fixed as anchors and each gap between them diffed independently with Myers.
 * This turns "large file with many scattered changes" (where Myers' O(D^2) trace is unaffordable)
 * from a useless whole-file replacement into a near-minimal diff.
 *
 * Result is near-minimal, not provably minimal — callers tag it source: "anchored".
 */
function anchoredDiff(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  out: Op[],
  state: { coarseSegments: number },
  depth: number,
): void {
  // Trim equal ends of this range first.
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    out.push({ t: "=", ai: a0++, bi: b0++ });
  }
  const tail: Op[] = [];
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    tail.push({ t: "=", ai: --a1, bi: --b1 });
  }
  tail.reverse();

  const emitTail = (): void => {
    out.push(...tail);
  };
  const na = a1 - a0;
  const nb = b1 - b0;

  if (na === 0 && nb === 0) return emitTail();
  if (na === 0) {
    for (let i = b0; i < b1; i++) out.push({ t: "+", bi: i });
    return emitTail();
  }
  if (nb === 0) {
    for (let i = a0; i < a1; i++) out.push({ t: "-", ai: i });
    return emitTail();
  }

  // Small enough for exact Myers? Use it.
  if (na + nb <= 4000 || depth >= 32) {
    const sub = myersDiff(a.slice(a0, a1), b.slice(b0, b1), MAX_EDIT_DISTANCE);
    if (sub) {
      for (const o of sub) {
        if (o.t === "=") out.push({ t: "=", ai: o.ai + a0, bi: o.bi + b0 });
        else if (o.t === "-") out.push({ t: "-", ai: o.ai + a0 });
        else out.push({ t: "+", bi: o.bi + b0 });
      }
      return emitTail();
    }
  }

  // Find lines unique on both sides within this range.
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (let i = a0; i < a1; i++) countA.set(a[i]!, (countA.get(a[i]!) ?? 0) + 1);
  for (let i = b0; i < b1; i++) countB.set(b[i]!, (countB.get(b[i]!) ?? 0) + 1);
  const bPos = new Map<string, number>();
  for (let i = b0; i < b1; i++) if (countB.get(b[i]!) === 1) bPos.set(b[i]!, i);

  const pairs: Array<[number, number]> = [];
  for (let i = a0; i < a1; i++) {
    const k = a[i]!;
    if (countA.get(k) !== 1) continue;
    const j = bPos.get(k);
    if (j !== undefined) pairs.push([i, j]);
  }

  // Longest increasing subsequence on the b positions -> a consistent set of anchors.
  const anchors: Array<[number, number]> = [];
  if (pairs.length) {
    const tails: number[] = [];
    const tailIdx: number[] = [];
    const prev = new Int32Array(pairs.length).fill(-1);
    for (let p = 0; p < pairs.length; p++) {
      const val = pairs[p]![1];
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid]! < val) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = val;
      tailIdx[lo] = p;
      prev[p] = lo > 0 ? tailIdx[lo - 1]! : -1;
    }
    let cur = tailIdx[tails.length - 1]!;
    while (cur !== -1) {
      anchors.push(pairs[cur]!);
      cur = prev[cur]!;
    }
    anchors.reverse();
  }

  if (anchors.length === 0) {
    // No usable anchors: this segment gets the coarse treatment (bounded to the segment, not the file).
    state.coarseSegments++;
    for (let i = a0; i < a1; i++) out.push({ t: "-", ai: i });
    for (let i = b0; i < b1; i++) out.push({ t: "+", bi: i });
    return emitTail();
  }

  let ca = a0;
  let cb = b0;
  for (const [ai, bi] of anchors) {
    anchoredDiff(a, b, ca, ai, cb, bi, out, state, depth + 1);
    out.push({ t: "=", ai, bi });
    ca = ai + 1;
    cb = bi + 1;
  }
  anchoredDiff(a, b, ca, a1, cb, b1, out, state, depth + 1);
  emitTail();
}

interface TextDiffResult {
  /** Equal under the active normalization (ignoreWhitespace / ignoreBlankLines / CR stripping). */
  contentEqual: boolean;
  added: number;
  removed: number;
  hunks: number;
  ops: Op[];
  aPrep: Prepared;
  bPrep: Prepared;
  source: DiffSource;
  notes: string[];
}

interface Opts {
  contextLines: number;
  ignoreWhitespace: boolean;
  ignoreBlankLines: boolean;
}

function keyOf(line: string, ignoreWhitespace: boolean): string {
  return ignoreWhitespace ? line.replace(/\s+/g, "") : line;
}

function diffContent(aContent: string, bContent: string, opts: Opts): TextDiffResult {
  const aPrep = prepare(aContent, opts.ignoreBlankLines);
  const bPrep = prepare(bContent, opts.ignoreBlankLines);
  const notes: string[] = [];

  const aKeys = aPrep.lines.map((l) => keyOf(l, opts.ignoreWhitespace));
  const bKeys = bPrep.lines.map((l) => keyOf(l, opts.ignoreWhitespace));

  // "Ends without a newline" is a property of the LAST line, so an unterminated last line is a
  // different token from the same text followed by a newline. GNU diff/patch work this way, and
  // ignoring it produces a patch that silently loses (or invents) the final newline. Mark each side
  // independently — not only when the two sides disagree — because a deletion can move which line
  // is last.
  const NO_EOL_KEY = "\u0000<no-final-newline>";
  if (aPrep.noFinalNewline && aKeys.length) aKeys[aKeys.length - 1] += NO_EOL_KEY;
  if (bPrep.noFinalNewline && bKeys.length) bKeys[bKeys.length - 1] += NO_EOL_KEY;

  // Trim common prefix/suffix so a small change in a huge file stays cheap.
  let pre = 0;
  while (pre < aKeys.length && pre < bKeys.length && aKeys[pre] === bKeys[pre]) pre++;
  let suf = 0;
  while (
    suf < aKeys.length - pre &&
    suf < bKeys.length - pre &&
    aKeys[aKeys.length - 1 - suf] === bKeys[bKeys.length - 1 - suf]
  )
    suf++;

  const midA = aKeys.slice(pre, aKeys.length - suf);
  const midB = bKeys.slice(pre, bKeys.length - suf);

  let ops: Op[] | null = null;
  let source: DiffSource = "myers";

  if (midA.length === 0 && midB.length === 0) {
    ops = [];
  } else if (midA.length > MAX_MIDDLE_LINES || midB.length > MAX_MIDDLE_LINES) {
    ops = null;
  } else {
    ops = myersDiff(midA, midB, MAX_EDIT_DISTANCE);
  }

  if (ops === null) {
    // Myers is unaffordable here (region too large, or edit distance over budget). Fall back to
    // unique-line anchoring, which stays cheap and near-minimal; only anchor-less segments inside
    // it degrade to a wholesale replacement.
    const state = { coarseSegments: 0 };
    const collected: Op[] = [];
    anchoredDiff(midA, midB, 0, midA.length, 0, midB.length, collected, state, 0);
    ops = collected;
    if (state.coarseSegments > 0) {
      source = "coarse-fallback";
      notes.push(
        `source: coarse-fallback — the changed region is too large for an exact minimal diff ` +
          `(${midA.length} vs ${midB.length} lines after trimming common prefix/suffix; limits: ` +
          `${MAX_MIDDLE_LINES} lines / edit distance ${MAX_EDIT_DISTANCE}). Unique-line anchoring was used, ` +
          `but ${state.coarseSegments} segment(s) had no unique common lines and are shown as a wholesale ` +
          `removal+insertion, so +n/-n are UPPER BOUNDS there, not minimal edits.`,
      );
    } else {
      source = "anchored";
      notes.push(
        `source: anchored — too large for an exact minimal diff (${midA.length} vs ${midB.length} changed-region ` +
          `lines), so unique common lines were used as anchors and each gap diffed separately. The diff is correct ` +
          `but may not be the smallest possible; +n/-n can be slightly higher than a minimal diff's.`,
      );
    }
    ops = ops.map((o) =>
      o.t === "="
        ? { t: "=", ai: o.ai + pre, bi: o.bi + pre }
        : o.t === "-"
          ? { t: "-", ai: o.ai + pre }
          : { t: "+", bi: o.bi + pre },
    );
  } else {
    // Shift middle-relative indices back to absolute.
    ops = ops.map((o) =>
      o.t === "=" ? { t: "=", ai: o.ai + pre, bi: o.bi + pre } : o.t === "-" ? { t: "-", ai: o.ai + pre } : { t: "+", bi: o.bi + pre },
    );
  }

  // Re-attach the trimmed prefix/suffix as equal ops so hunk context can use them.
  const full: Op[] = [];
  for (let i = 0; i < pre; i++) full.push({ t: "=", ai: i, bi: i });
  full.push(...ops);
  for (let i = 0; i < suf; i++)
    full.push({ t: "=", ai: aKeys.length - suf + i, bi: bKeys.length - suf + i });

  let added = 0;
  let removed = 0;
  for (const o of full) {
    if (o.t === "+") added++;
    else if (o.t === "-") removed++;
  }

  const contentEqual = added === 0 && removed === 0;

  // Differences the line diff deliberately hides — surface them instead of silently claiming equality.
  const aEol = eolName(aPrep);
  const bEol = eolName(bPrep);
  // An empty (or single unterminated line) file has no line endings at all; reporting that as an
  // "endings differ" caveat is noise, not information.
  if (aEol !== bEol && aEol !== "none" && bEol !== "none") notes.push(`line endings differ: a=${aEol}, b=${bEol}`);
  if (aPrep.noFinalNewline !== bPrep.noFinalNewline)
    notes.push(
      `trailing newline differs: ${aPrep.noFinalNewline ? "a has none" : "a has one"}, ${bPrep.noFinalNewline ? "b has none" : "b has one"}`,
    );
  if (opts.ignoreBlankLines && (aPrep.blanksFiltered || bPrep.blanksFiltered))
    notes.push(`ignoreBlankLines: skipped ${aPrep.blanksFiltered} blank line(s) in a, ${bPrep.blanksFiltered} in b`);
  if (opts.ignoreWhitespace) notes.push("ignoreWhitespace: in-line whitespace ignored when matching lines (diff -w)");

  return { contentEqual, added, removed, hunks: 0, ops: full, aPrep, bPrep, source, notes };
}

/* ------------------------------------------------------------- rendering */

interface Hunk {
  ops: Op[];
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
}

function buildHunks(ops: Op[], context: number, aPrep: Prepared, bPrep: Prepared): Hunk[] {
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i]!.t !== "=") changed.push(i);
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length - 1, changed[0]! + context);
  for (const idx of changed.slice(1)) {
    if (idx - context <= end + 1) end = Math.min(ops.length - 1, idx + context);
    else {
      ranges.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  ranges.push([start, end]);

  return ranges.map(([s, e]) => {
    const slice = ops.slice(s, e + 1);
    let aStart = 0;
    let bStart = 0;
    let aCount = 0;
    let bCount = 0;
    for (const o of slice) {
      if (o.t === "=" || o.t === "-") {
        const n = aPrep.numbers[o.ai] ?? 0;
        if (aCount === 0) aStart = n;
        aCount++;
      }
      if (o.t === "=" || o.t === "+") {
        const n = bPrep.numbers[o.bi] ?? 0;
        if (bCount === 0) bStart = n;
        bCount++;
      }
    }
    // A hunk with no lines on one side (pure insertion/deletion at contextLines:0) must still carry a
    // usable anchor line number, like GNU diff's "@@ -5,0 +6,2 @@" — use the preceding line on that side.
    if (aCount === 0) {
      let n = 0;
      for (let i = s - 1; i >= 0; i--) {
        const o = ops[i]!;
        if (o.t === "=" || o.t === "-") {
          n = aPrep.numbers[o.ai] ?? 0;
          break;
        }
      }
      aStart = n;
    }
    if (bCount === 0) {
      let n = 0;
      for (let i = s - 1; i >= 0; i--) {
        const o = ops[i]!;
        if (o.t === "=" || o.t === "+") {
          n = bPrep.numbers[o.bi] ?? 0;
          break;
        }
      }
      bStart = n;
    }
    return { ops: slice, aStart, aCount, bStart, bCount };
  });
}

const NO_EOL = "\\ No newline at end of file";

function renderUnified(
  res: TextDiffResult,
  labelA: string,
  labelB: string,
  opts: Opts,
  budget: { left: number },
): { text: string; truncated: boolean; hunks: number } {
  const hunks = buildHunks(res.ops, opts.contextLines, res.aPrep, res.bPrep);
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let emitted = 0;
  let truncated = false;
  let shown = 0;

  const lastA = res.aPrep.lines.length - 1;
  const lastB = res.bPrep.lines.length - 1;

  for (const h of hunks) {
    if (emitted >= budget.left) {
      truncated = true;
      break;
    }
    out.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`);
    emitted++;
    shown++;
    for (const o of h.ops) {
      if (emitted >= budget.left) {
        truncated = true;
        break;
      }
      if (o.t === "=") {
        out.push(` ${res.aPrep.lines[o.ai]}`);
        // Both sides end here without a newline: the marker belongs on the context line too, or a
        // patch built from this diff would re-add the missing newline.
        if (o.ai === lastA && o.bi === lastB && res.aPrep.noFinalNewline && res.bPrep.noFinalNewline)
          out.push(NO_EOL);
      } else if (o.t === "-") {
        out.push(`-${res.aPrep.lines[o.ai]}`);
        if (o.ai === lastA && res.aPrep.noFinalNewline) out.push(NO_EOL);
      } else {
        out.push(`+${res.bPrep.lines[o.bi]}`);
        if (o.bi === lastB && res.bPrep.noFinalNewline) out.push(NO_EOL);
      }
      emitted++;
    }
    if (truncated) break;
  }

  budget.left -= emitted;
  if (truncated)
    out.push(
      `... [diff output truncated: ${shown} of ${hunks.length} hunks shown, ${emitted} lines emitted. ` +
        `Full change is +${res.added} -${res.removed}. Raise maxLinesPerFile/maxTotalLines, or diff a narrower scope.]`,
    );
  return { text: out.join("\n"), truncated, hunks: hunks.length };
}

function pad(s: string, w: number): string {
  const t = s.length > w ? s.slice(0, w - 1) + "\u2026" : s;
  return t + " ".repeat(Math.max(0, w - t.length));
}

function renderSideBySide(
  res: TextDiffResult,
  labelA: string,
  labelB: string,
  opts: Opts,
  budget: { left: number },
): { text: string; truncated: boolean; hunks: number } {
  const hunks = buildHunks(res.ops, opts.contextLines, res.aPrep, res.bPrep);
  const out: string[] = [`${pad(labelA, SBS_COL)}   ${labelB}`];
  let emitted = 0;
  let truncated = false;
  let shown = 0;

  for (const h of hunks) {
    if (emitted >= budget.left) {
      truncated = true;
      break;
    }
    out.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`);
    emitted++;
    shown++;
    // Pair consecutive -/+ runs so changed lines sit next to each other.
    let i = 0;
    while (i < h.ops.length) {
      if (emitted >= budget.left) {
        truncated = true;
        break;
      }
      const o = h.ops[i]!;
      if (o.t === "=") {
        out.push(`${pad(res.aPrep.lines[o.ai]!, SBS_COL)}   ${res.bPrep.lines[o.bi]}`);
        emitted++;
        i++;
        continue;
      }
      const dels: number[] = [];
      const adds: number[] = [];
      while (i < h.ops.length && h.ops[i]!.t === "-") dels.push((h.ops[i++] as { ai: number }).ai);
      while (i < h.ops.length && h.ops[i]!.t === "+") adds.push((h.ops[i++] as { bi: number }).bi);
      const n = Math.max(dels.length, adds.length);
      for (let j = 0; j < n && emitted < budget.left; j++) {
        const l = dels[j] !== undefined ? res.aPrep.lines[dels[j]!]! : "";
        const r = adds[j] !== undefined ? res.bPrep.lines[adds[j]!]! : "";
        const marker = dels[j] === undefined ? ">" : adds[j] === undefined ? "<" : "|";
        out.push(`${pad(l, SBS_COL)} ${marker} ${r}`);
        emitted++;
      }
      if (emitted >= budget.left && i < h.ops.length) truncated = true;
    }
    if (truncated) break;
  }

  budget.left -= emitted;
  if (truncated)
    out.push(
      `... [side-by-side output truncated: ${shown} of ${hunks.length} hunks shown. Full change is +${res.added} -${res.removed}.]`,
    );
  return { text: out.join("\n"), truncated, hunks: hunks.length };
}

/* ----------------------------------------------------------- files action */

interface FileFacts {
  path: string;
  size: number;
  binary: boolean;
}

async function fileFacts(path: string): Promise<FileFacts | { error: string }> {
  try {
    const st = await lstat(path);
    if (st.isDirectory()) return { error: `${path} is a directory (use action='dirs' to compare directory trees)` };
    if (st.isSymbolicLink()) {
      const target = await readlink(path);
      return { error: `${path} is a symlink -> ${target}; diff files expects regular files` };
    }
    if (!st.isFile()) return { error: `${path} is not a regular file` };
    return { path, size: st.size, binary: await isBinaryFile(path, st.size) };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { error: `${path}: no such file or directory` };
    if (e?.code === "EACCES") return { error: `${path}: permission denied` };
    return { error: `${path}: ${e?.message ?? String(e)}` };
  }
}

interface ActionResult {
  text: string;
  details: Record<string, unknown>;
}

async function diffFiles(params: ParamsT, cwd: string, opts: Opts, budget: { left: number }): Promise<ActionResult> {
  const pathA = abs(params.a, cwd);
  const pathB = abs(params.b, cwd);
  const labelA = params.labelA ?? params.a;
  const labelB = params.labelB ?? params.b;
  const mode = params.outputMode ?? "unified";

  const [fa, fb] = await Promise.all([fileFacts(pathA), fileFacts(pathB)]);
  const errs = [fa, fb].filter((f): f is { error: string } => "error" in f).map((f) => f.error);
  if (errs.length)
    return { text: `Error: ${errs.join("\n       ")}`, details: { action: "files", error: errs.join("; ") } };

  const A = fa as FileFacts;
  const B = fb as FileFacts;

  // Fast identical shortcut: equal size + streaming byte compare (no full read, no hashing).
  if (A.size === B.size) {
    const off = await firstByteDiff(pathA, pathB);
    if (off === -1)
      return {
        text: `identical: ${labelA} and ${labelB} are byte-for-byte identical (${human(A.size)}).\nsource: identical (byte compare)`,
        details: { action: "files", identical: true, source: "identical", bytes: A.size },
      };
  }

  if (A.binary || B.binary) {
    const [sa, sb] = await Promise.all([streamStats(pathA), streamStats(pathB)]);
    const which = A.binary && B.binary ? "both files are binary" : `${A.binary ? labelA : labelB} is binary`;
    const same = sa.sha256 === sb.sha256 && A.size === B.size;
    return {
      text:
        `binary: ${which}; not dumping bytes.\n` +
        `  ${labelA}: ${human(A.size)}, sha256:${sa.sha256}\n` +
        `  ${labelB}: ${human(B.size)}, sha256:${sb.sha256}\n` +
        `  ${same ? "contents are identical" : "contents DIFFER"}\n` +
        `source: binary (size+hash only; no line diff possible)`,
      details: {
        action: "files",
        binary: true,
        identical: same,
        source: "binary",
        aBytes: A.size,
        bBytes: B.size,
        aSha: sa.sha256,
        bSha: sb.sha256,
      },
    };
  }

  if (A.size > MAX_DIFF_BYTES || B.size > MAX_DIFF_BYTES) {
    const [sa, sb, off] = await Promise.all([
      streamStats(pathA),
      streamStats(pathB),
      A.size === B.size ? firstByteDiff(pathA, pathB) : Promise.resolve(-2),
    ]);
    const same = sa.sha256 === sb.sha256 && A.size === B.size;
    return {
      text:
        `too large for line diff (cap ${human(MAX_DIFF_BYTES)} per file):\n` +
        `  ${labelA}: ${human(A.size)}, ${sa.newlines + (sa.endsWithNewline ? 0 : 1)} lines, sha256:${sa.sha256}\n` +
        `  ${labelB}: ${human(B.size)}, ${sb.newlines + (sb.endsWithNewline ? 0 : 1)} lines, sha256:${sb.sha256}\n` +
        `  ${same ? "contents are identical" : "contents DIFFER"}` +
        (off >= 0 ? ` (first differing byte at offset ${off})` : "") +
        `\nsource: size-only (file exceeds the line-diff cap; no +n/-n computed — extract the region of interest, e.g. with read/grep, and diff that)`,
      details: {
        action: "files",
        identical: same,
        source: "size-only",
        aBytes: A.size,
        bBytes: B.size,
        aLines: sa.newlines,
        bLines: sb.newlines,
        firstDiffOffset: off >= 0 ? off : undefined,
      },
    };
  }

  const [aContent, bContent] = await Promise.all([readFile(pathA, "utf8"), readFile(pathB, "utf8")]);
  return renderTextDiff(aContent, bContent, labelA, labelB, opts, mode, budget, "files", {
    aBytes: A.size,
    bBytes: B.size,
  });
}

/** Shared rendering path for action=files (already read) and action=text. */
function renderTextDiff(
  aContent: string,
  bContent: string,
  labelA: string,
  labelB: string,
  opts: Opts,
  mode: (typeof outputModeEnum)[number],
  budget: { left: number },
  action: string,
  extraDetails: Record<string, unknown>,
): ActionResult {
  const res = diffContent(aContent, bContent, opts);
  const summary =
    `${labelA} -> ${labelB}: +${res.added} -${res.removed} lines` +
    ` (${res.aPrep.totalLines} -> ${res.bPrep.totalLines} lines total)`;

  const notes = res.notes.length ? `\n${res.notes.map((n) => `note: ${n}`).join("\n")}` : "";

  if (res.contentEqual) {
    const onlyEol = res.notes.some((n) => n.startsWith("line endings differ"));
    const onlyNl = res.notes.some((n) => n.startsWith("trailing newline differs"));
    let head: string;
    if (onlyEol || onlyNl)
      head =
        `NOT identical: content lines match, but the files differ in ` +
        `${[onlyEol ? "line endings" : null, onlyNl ? "trailing newline" : null].filter(Boolean).join(" and ")}.`;
    else if (opts.ignoreWhitespace || opts.ignoreBlankLines)
      head = `equal under the requested normalization (ignoreWhitespace=${opts.ignoreWhitespace}, ignoreBlankLines=${opts.ignoreBlankLines}); raw bytes may still differ.`;
    else head = `identical: no line differences.`;
    const normalized = opts.ignoreWhitespace || opts.ignoreBlankLines;
    return {
      text: `${head}\n${summary}${notes}`,
      details: {
        action,
        // identical means "same content with no caveats"; normalization or an EOL/newline-only
        // difference makes the files NOT identical even though the line diff is empty.
        identical: !onlyEol && !onlyNl && !normalized,
        normalizedEqual: normalized ? true : undefined,
        added: 0,
        removed: 0,
        source: res.source,
        eolDiffOnly: onlyEol,
        ...extraDetails,
      },
    };
  }

  if (mode === "stat" || mode === "namesOnly") {
    const hunkCount = buildHunks(res.ops, opts.contextLines, res.aPrep, res.bPrep).length;
    const text =
      mode === "namesOnly"
        ? `differ: ${labelA} ${labelB} (+${res.added} -${res.removed})${notes}`
        : `${summary} in ${hunkCount} hunk(s)${notes}${res.source !== "myers" ? "" : ""}`;
    return {
      text,
      details: { action, identical: false, added: res.added, removed: res.removed, hunks: hunkCount, source: res.source, ...extraDetails },
    };
  }

  const rendered =
    mode === "sideBySide"
      ? renderSideBySide(res, labelA, labelB, opts, budget)
      : renderUnified(res, labelA, labelB, opts, budget);

  return {
    text: `${summary} in ${rendered.hunks} hunk(s)${notes}\n${rendered.text}`,
    details: {
      action,
      identical: false,
      added: res.added,
      removed: res.removed,
      hunks: rendered.hunks,
      truncated: rendered.truncated,
      source: res.source,
      ...extraDetails,
    },
  };
}

/* ------------------------------------------------------------ dirs action */

type EntryKind = "file" | "symlink" | "other";
interface WalkEntry {
  kind: EntryKind;
  size: number;
  target?: string;
}

async function walkTree(
  root: string,
  ignores: RegExp[],
  ignoreGlobs: string[],
  signal: AbortSignal | undefined,
): Promise<{ entries: Map<string, WalkEntry>; truncated: boolean; dirs: number; skipped: Map<string, number> }> {
  const entries = new Map<string, WalkEntry>();
  const skipped = new Map<string, number>();
  let truncated = false;
  let dirs = 0;
  const stack: string[] = [""];

  while (stack.length) {
    if (signal?.aborted) break;
    const rel = stack.pop()!;
    let list;
    try {
      list = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    dirs++;
    // Deterministic (lexicographic) traversal so that if the entry cap is hit, both trees are cut at
    // the same place — otherwise truncation invents bogus "only in a/b" entries from different subsets.
    list.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const d of list) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const hit = ignores.findIndex((r) => r.test(d.name) || r.test(childRel));
      if (hit >= 0) {
        // Track what the ignore list actually suppressed, so the caller does not have to go
        // verify separately whether the defaults hid anything relevant.
        const g = ignoreGlobs[hit] ?? "?";
        skipped.set(g, (skipped.get(g) ?? 0) + 1);
        continue;
      }
      if (entries.size >= MAX_WALK_FILES) {
        truncated = true;
        continue;
      }
      if (d.isSymbolicLink()) {
        let target = "?";
        try {
          target = await readlink(join(root, childRel));
        } catch {
          /* dangling link */
        }
        entries.set(childRel, { kind: "symlink", size: 0, target });
      } else if (d.isDirectory()) {
        subdirs.push(childRel);
      } else if (d.isFile()) {
        let size = 0;
        try {
          size = (await lstat(join(root, childRel))).size;
        } catch {
          /* vanished */
        }
        entries.set(childRel, { kind: "file", size });
      } else {
        entries.set(childRel, { kind: "other", size: 0 });
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  return { entries, truncated, dirs, skipped };
}

async function diffDirs(
  params: ParamsT,
  cwd: string,
  opts: Opts,
  budget: { left: number },
  signal: AbortSignal | undefined,
): Promise<ActionResult> {
  const rootA = abs(params.a, cwd);
  const rootB = abs(params.b, cwd);
  const labelA = params.labelA ?? params.a;
  const labelB = params.labelB ?? params.b;
  const mode = params.outputMode ?? "stat";
  const withPatches = mode === "unified" || mode === "sideBySide";

  for (const [p, label] of [
    [rootA, labelA],
    [rootB, labelB],
  ] as const) {
    try {
      const st = await lstat(p);
      if (!st.isDirectory())
        return { text: `Error: ${label} is not a directory (use action='files')`, details: { action: "dirs", error: "not a directory" } };
    } catch (e: any) {
      return {
        text: `Error: ${label}: ${e?.code === "ENOENT" ? "no such directory" : (e?.message ?? String(e))}`,
        details: { action: "dirs", error: "missing" },
      };
    }
  }

  const ignoreGlobs = params.ignore ?? DEFAULT_IGNORE;
  const ignores = ignoreGlobs.map(globToRegExp);
  const [ta, tb] = await Promise.all([
    walkTree(rootA, ignores, ignoreGlobs, signal),
    walkTree(rootB, ignores, ignoreGlobs, signal),
  ]);

  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const typeMismatch: string[] = [];
  const linkDiff: string[] = [];
  const differ: Array<{ rel: string; added: number; removed: number; note?: string; source: DiffSource }> = [];
  let identicalCount = 0;
  let detailBudget = DIR_DETAIL_LIMIT;

  for (const [rel, ea] of ta.entries) {
    const eb = tb.entries.get(rel);
    if (!eb) {
      onlyA.push(ea.kind === "symlink" ? `${rel} (symlink -> ${ea.target})` : rel);
      continue;
    }
    if (ea.kind !== eb.kind) {
      typeMismatch.push(`${rel} (${labelA}: ${ea.kind}, ${labelB}: ${eb.kind})`);
      continue;
    }
    if (ea.kind === "symlink") {
      if (ea.target !== eb.target) linkDiff.push(`${rel} (a -> ${ea.target}, b -> ${eb.target})`);
      else identicalCount++;
      continue;
    }
    if (ea.kind !== "file") {
      identicalCount++;
      continue;
    }
    if (signal?.aborted) break;

    const pa = join(rootA, rel);
    const pb = join(rootB, rel);
    if (ea.size === eb.size) {
      const off = await firstByteDiff(pa, pb).catch(() => 0);
      if (off === -1) {
        identicalCount++;
        continue;
      }
    }
    // They differ byte-wise; decide how much detail to compute.
    if (!detailBudget) {
      differ.push({ rel, added: 0, removed: 0, note: "counts not computed (detail cap reached)", source: "size-only" });
      continue;
    }
    if (ea.size > MAX_DIFF_BYTES || eb.size > MAX_DIFF_BYTES) {
      differ.push({
        rel,
        added: 0,
        removed: 0,
        note: `too large for line diff (${human(ea.size)} vs ${human(eb.size)})`,
        source: "size-only",
      });
      continue;
    }
    const [ba, bb] = await Promise.all([isBinaryFile(pa, ea.size), isBinaryFile(pb, eb.size)]);
    if (ba || bb) {
      differ.push({ rel, added: 0, removed: 0, note: `binary (${human(ea.size)} vs ${human(eb.size)})`, source: "binary" });
      continue;
    }
    const [ca, cb] = await Promise.all([readFile(pa, "utf8"), readFile(pb, "utf8")]);
    const res = diffContent(ca, cb, opts);
    detailBudget--;
    if (res.contentEqual) {
      const why = res.notes.filter((n) => !n.startsWith("ignore")).join("; ") || "normalized-equal (bytes differ)";
      differ.push({ rel, added: 0, removed: 0, note: why, source: res.source });
      continue;
    }
    differ.push({
      rel,
      added: res.added,
      removed: res.removed,
      source: res.source,
      note: res.source === "coarse-fallback" ? "coarse-fallback: counts are upper bounds" : undefined,
    });
  }

  for (const rel of tb.entries.keys())
    if (!ta.entries.has(rel)) {
      const eb = tb.entries.get(rel)!;
      onlyB.push(eb.kind === "symlink" ? `${rel} (symlink -> ${eb.target})` : rel);
    }

  onlyA.sort();
  onlyB.sort();
  differ.sort((x, y) => x.rel.localeCompare(y.rel));

  const out: string[] = [];
  out.push(`dirs: ${labelA} vs ${labelB}`);
  const skips = new Map<string, number>();
  for (const m of [ta.skipped, tb.skipped]) for (const [g, n] of m) skips.set(g, (skips.get(g) ?? 0) + n);
  const skipText =
    skips.size === 0
      ? `none of the ignore globs (${ignoreGlobs.join(", ")}) matched anything, so nothing was skipped`
      : `skipped by ignore globs: ${[...skips].map(([g, n]) => `${g} (${n} path${n === 1 ? "" : "s"})`).join(", ")}`;
  out.push(
    `scanned ${ta.entries.size} entries in a, ${tb.entries.size} in b; ${skipText}; ` +
      `${identicalCount} identical, ${differ.length} differ, ${onlyA.length} only in a, ${onlyB.length} only in b` +
      (typeMismatch.length ? `, ${typeMismatch.length} type mismatch` : "") +
      (linkDiff.length ? `, ${linkDiff.length} symlink target diff` : ""),
  );
  if (ta.truncated || tb.truncated)
    out.push(
      `WARNING: walk truncated at ${MAX_WALK_FILES} entries per tree — results are INCOMPLETE and the ` +
        `"only in" lists are UNRELIABLE near the cut-off (the trees were scanned only up to that point, ` +
        `in lexicographic order). Narrow with 'ignore' or compare a subdirectory instead.`,
    );

  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    out.push(`\n${title} (${items.length}):`);
    for (const it of items.slice(0, DIR_LIST_LIMIT)) out.push(`  ${it}`);
    if (items.length > DIR_LIST_LIMIT) out.push(`  ... and ${items.length - DIR_LIST_LIMIT} more (list capped at ${DIR_LIST_LIMIT})`);
  };

  section(`only in ${labelA}`, onlyA);
  section(`only in ${labelB}`, onlyB);
  section("type mismatch", typeMismatch);
  section("symlink targets differ", linkDiff);

  if (differ.length) {
    out.push(`\ndiffer (${differ.length}):`);
    for (const d of differ.slice(0, DIR_LIST_LIMIT)) {
      if (mode === "namesOnly") out.push(`  ${d.rel}`);
      else
        out.push(
          `  ${d.rel}  ${d.note ? `[${d.note}]` : `+${d.added} -${d.removed}`}` +
            (d.note && (d.added || d.removed) ? ` +${d.added} -${d.removed}` : ""),
        );
    }
    if (differ.length > DIR_LIST_LIMIT)
      out.push(`  ... and ${differ.length - DIR_LIST_LIMIT} more (list capped at ${DIR_LIST_LIMIT})`);
    if (detailBudget === 0)
      out.push(`  note: per-file +n/-n computed for the first ${DIR_DETAIL_LIMIT} differing files only.`);
  }

  if (withPatches && differ.length) {
    out.push(`\npatches:`);
    for (const d of differ) {
      if (budget.left <= 0) {
        out.push(`... [patch output budget exhausted; remaining differing files listed above without patches]`);
        break;
      }
      if (d.source === "binary" || d.source === "size-only") {
        // Explain the absence rather than silently skipping the file: a missing patch would otherwise
        // look like "no content difference".
        out.push(`${labelA}/${d.rel}: no patch — ${d.note ?? "not line-diffable"}`);
        continue;
      }
      if (!d.added && !d.removed) {
        out.push(`${labelA}/${d.rel}: no line differences — ${d.note ?? "bytes differ only"}`);
        continue;
      }
      const pa = join(rootA, d.rel);
      const pb = join(rootB, d.rel);
      const [ca, cb] = await Promise.all([readFile(pa, "utf8"), readFile(pb, "utf8")]);
      const sub = renderTextDiff(ca, cb, `${labelA}/${d.rel}`, `${labelB}/${d.rel}`, opts, mode, budget, "files", {});
      out.push(sub.text);
    }
  }

  return {
    text: out.join("\n"),
    details: {
      action: "dirs",
      onlyInA: onlyA.length,
      onlyInB: onlyB.length,
      differing: differ.length,
      identical: identicalCount,
      typeMismatch: typeMismatch.length,
      symlinkTargetDiff: linkDiff.length,
      walkTruncated: ta.truncated || tb.truncated,
      onlyInListsReliable: !(ta.truncated || tb.truncated),
      ignoredPaths: [...skips].reduce((n, [, v]) => n + v, 0),
      scannedA: ta.entries.size,
      scannedB: tb.entries.size,
    },
  };
}

/* ------------------------------------------------------------------- tool */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "diff",
    label: "Diff",
    description: `Compare two files, two directory trees, or two inline strings. Output is always BOUNDED with an explicit truncation marker.

Use instead of bash \`diff -u a b | head\`, \`diff -rq\`, \`cmp\`, \`diff <(...) <(...)\`: identical files short-circuit on a streaming byte compare, binary files report size+hash instead of raw bytes, and CRLF / missing-trailing-newline differences are named instead of being invisible. For git-tracked changes use the git tool instead.

Ex: {"action":"files","a":"src/Foo.kt","b":"/tmp/Foo.kt.bak"} -> unified patch + "+n -n" (add outputMode:"stat" for the summary alone) | {"action":"dirs","a":"out/before","b":"out/after"} -> only-in-a / only-in-b / differing files with per-file +n/-n | {"action":"text","a":"expected...","b":"actual..."} -> two strings, no temp files.

Reading a result: line 1 is the verdict ("identical", "NOT identical: ...", or "<a> -> <b>: +n -m lines in k hunk(s)"). "source:" is the confidence: myers/identical = exact minimal diff, coarse-fallback = +n/-n are UPPER BOUNDS, size-only/binary = no line diff computed. Invisible differences (CRLF vs LF, missing trailing newline, whitespace/blank-line normalization) ALWAYS appear as "note:" lines.`,
    promptSnippet:
      "Compare two files / two directory trees / two strings with capped, structured diff output (replaces bash diff/cmp)",
    promptGuidelines: [
      "Use diff instead of bash `diff -u a b | head`, `diff -rq dirA dirB`, `cmp` or `diff <(cmd1) <(cmd2)` — it caps its own output and marks truncation. {action:'files'} for a file vs a backup/second copy or what an edit/codegen step changed, {action:'dirs'} for two output/build trees, {action:'text'} for expected-vs-actual strings without writing temp files.",
      "Do NOT use diff for git-tracked changes (working tree vs HEAD, commit vs commit, branch diffs) — use the git tool. diff is for arbitrary paths not tied to git history.",
      "When you only need WHETHER or BY HOW MUCH two things differ, use outputMode:'stat' ('namesOnly' for dirs) instead of pulling the whole patch into context; if a result reports truncation, narrow the scope rather than raising maxLinesPerFile.",
      "Trust diff's own markers instead of re-checking in bash: absence of a 'note:' line means there is NO CRLF/trailing-newline/normalization difference, so never follow a diff with `cat -A`/`xxd`; and read 'source:' before quoting counts (myers/identical exact, coarse-fallback = upper bound, size-only/binary = no line diff).",
    ],
    parameters: schema,
    async execute(_toolCallId, params: ParamsT, signal, _onUpdate, ctx: ExtensionContext) {
      const opts: Opts = {
        contextLines: Math.max(0, Math.min(params.contextLines ?? DEFAULT_CONTEXT, 20)),
        ignoreWhitespace: params.ignoreWhitespace === true,
        ignoreBlankLines: params.ignoreBlankLines === true,
      };
      // The whole-call cap wins over the per-file cap: clamp perFile DOWN to it rather than raising
      // total up to perFile, so an explicitly small maxTotalLines is never silently ignored.
      const total = Math.max(5, Math.min(params.maxTotalLines ?? DEFAULT_MAX_TOTAL_LINES, MAX_LINES_CEILING));
      const perFile = Math.min(
        total,
        Math.max(5, Math.min(params.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE, MAX_LINES_CEILING)),
      );
      const cwd = ctx.cwd;

      try {
        if (params.action === "text") {
          const budget = { left: perFile };
          const r = renderTextDiff(
            params.a,
            params.b,
            params.labelA ?? "a",
            params.labelB ?? "b",
            opts,
            params.outputMode ?? "unified",
            budget,
            "text",
            {},
          );
          return { content: [{ type: "text", text: r.text }], details: r.details };
        }
        if (params.action === "files") {
          const budget = { left: perFile };
          const r = await diffFiles(params, cwd, opts, budget);
          return { content: [{ type: "text", text: r.text }], details: r.details };
        }
        if (params.action === "dirs") {
          const budget = { left: total };
          const r = await diffDirs(params, cwd, opts, budget, signal);
          return { content: [{ type: "text", text: r.text }], details: r.details };
        }
        return {
          content: [{ type: "text", text: `Error: unknown action '${(params as any).action}'. Valid: ${actionEnum.join(", ")}` }],
          details: { error: "unknown action" },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: diff failed: ${e?.message ?? String(e)}` }],
          details: { action: params.action, error: String(e?.message ?? e) },
        };
      }
    },
    renderCall(args: ParamsT, theme) {
      const short = (s: string) => (s.length > 40 ? `${s.slice(0, 18)}…${s.slice(-18)}` : s);
      const sides = args.action === "text" ? "two strings" : `${short(args.a ?? "")} ↔ ${short(args.b ?? "")}`;
      const mode = args.outputMode && args.outputMode !== "unified" ? ` ${args.outputMode}` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("diff "))}${theme.fg("accent", args.action ?? "")}${theme.fg("dim", mode)} ${sides}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Diffing..."), 0, 0);
      const first = result.content[0];
      const text = (first && "text" in first ? first.text : "") ?? "";
      if (text.startsWith("Error:")) return new Text(theme.fg("error", text), 0, 0);
      const lines = text.split("\n");
      if (!expanded && lines.length > 20)
        return new Text(`${lines.slice(0, 20).join("\n")}\n... and ${lines.length - 20} more lines`, 0, 0);
      return new Text(text, 0, 0);
    },
  });
}
