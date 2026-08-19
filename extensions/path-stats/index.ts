/**
 * path_stats — the pre-flight "how big is this thing?" probe for Pi.
 *
 * Replaces the size/shape bash probes that show up constantly in real sessions:
 *   wc -l file                 -> path_stats {paths:["file"]}                (lines column)
 *   wc -c file / wc -w file    -> metrics:["bytes"] / metrics:["words"]
 *   stat -f %z / %m file       -> metrics:["bytes","mtime"]
 *   ls -la dir | awk sizes     -> paths:["dir"] (entry count) or recursive:true
 *   du -sh dir                 -> paths:["dir"], recursive:true (total bytes + top files + by ext)
 *   shasum -a 256 file         -> metrics:["sha256"]
 *
 * It deliberately does NOT do listing/globbing (that's `list_files`) — it measures
 * paths you already know and aggregates directories.
 *
 * Install: copy/symlink this directory into ~/.pi/agent/extensions/path-stats
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/** Max paths accepted in one call; extra paths are reported, not silently dropped. */
const MAX_PATHS = 200;
/**
 * Default cap on files walked per recursive directory. Deliberately high (a 150k-file tree walks in
 * ~6s) because a too-low default just makes the agent escalate through several redundant calls before
 * getting a complete number — measured behaviour, see README "validation". The time budget below is the
 * real safety net.
 */
const DEFAULT_WALK_LIMIT = 200_000;
/** Hard ceiling on files walked per recursive directory, even if `limit` asks for more. */
const MAX_WALK_LIMIT = 500_000;
/** Wall-clock budget for one recursive directory walk before it reports PARTIAL. */
const WALK_TIME_BUDGET_MS = 12_000;
/** Default number of largest files listed for a recursive directory. */
const DEFAULT_TOP = 5;
/** Extensions listed in a directory breakdown before collapsing into "+N more". */
const MAX_EXT_ROWS = 10;
/** Bytes sniffed for NUL before declaring a file binary (line/word counts are then skipped). */
const BINARY_SNIFF_BYTES = 64 * 1024;
/** Read chunk size for the streaming content pass. */
const CHUNK_BYTES = 1024 * 1024;
/** Concurrency for stat()ing files during a directory walk. */
const STAT_CONCURRENCY = 64;
/** How many directories are read concurrently during a walk (wide trees are latency-bound). */
const DIR_BATCH = 24;
/** Aggregate line/word counts are only computed for small trees (they require reading everything). */
const AGGREGATE_CONTENT_MAX_FILES = 2_000;
const AGGREGATE_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
/** Hard cap on emitted characters. */
const MAX_CHARS = 20_000;

const METRICS = ["lines", "bytes", "words", "mtime", "type", "sha256"] as const;
type Metric = (typeof METRICS)[number];

const Params = Type.Object({
  paths: Type.Array(Type.String(), {
    description: "Files/dirs to measure (relative to cwd, absolute, or ~/...). A bad path becomes an ERROR row, not a failed call.",
  }),
  metrics: Type.Optional(
    Type.Array(StringEnum(METRICS), {
      description: "Default bytes+lines. bytes/mtime/type are free (stat); lines/words/sha256 stream the file. lines == `wc -l`.",
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: "Directories: walk the tree for du-style totals, largest files and per-extension breakdown (default false: entry count only).",
      default: false,
    }),
  ),
  followSymlinks: Type.Optional(
    Type.Boolean({ description: "Follow symlinked dirs while walking (cycle-safe). Default false; symlinks named in `paths` are always resolved.", default: false }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max files walked per directory (default ${DEFAULT_WALK_LIMIT}); hitting it, or the ${Math.round(WALK_TIME_BUDGET_MS / 1000)}s time budget, marks the aggregate PARTIAL.`,
      default: DEFAULT_WALK_LIMIT,
    }),
  ),
  top: Type.Optional(Type.Number({ description: `Largest files listed per directory (default ${DEFAULT_TOP}).`, default: DEFAULT_TOP })),
});
type ParamsT = Static<typeof Params>;

type EntryKind = "file" | "dir" | "symlink" | "fifo" | "socket" | "char" | "block" | "unknown";

interface ContentStats {
  /** Newline count — identical to `wc -l`. */
  lines: number;
  /** Whitespace-delimited token count — identical to `LC_ALL=C wc -w`. */
  words: number;
  sha256?: string;
  noFinalNewline: boolean;
  crlf: boolean;
  mixedEol: boolean;
  binary: boolean;
  /** True when the content pass was skipped/aborted (binary short-circuit). */
  skipped: boolean;
}

interface DirAggregate {
  files: number;
  dirs: number;
  symlinks: number;
  other: number;
  totalBytes: number;
  largest: Array<{ path: string; bytes: number }>;
  byExt: Array<{ ext: string; files: number; bytes: number }>;
  extCount: number;
  unreadableDirs: number;
  firstUnreadable?: string;
  partial: boolean;
  partialReason?: string;
  /** Directories still queued when the walk stopped — a floor on how much is missing. */
  dirsUnscanned?: number;
  /** "limit" (deterministic) vs "time" (depends on machine load, so totals can vary between calls). */
  partialKind?: "limit" | "time";
  lines?: number;
  words?: number;
  contentSkipReason?: string;
  elapsedMs: number;
}

interface Row {
  input: string;
  abs: string;
  kind: EntryKind;
  error?: string;
  bytes?: number;
  mtimeMs?: number;
  entries?: number;
  symlinkTarget?: string;
  content?: ContentStats;
  aggregate?: DirAggregate;
  notes: string[];
}

/** Normalize a model-supplied path: strip a stray leading "@", expand "~", resolve against cwd. */
function normalizePath(input: string, cwd: string): string {
  let p = input.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Escape control characters in any value that goes into the aligned table.
 * A filename may legally contain \n or \t, which would otherwise break column alignment and
 * even let a crafted filename forge an extra output row.
 */
function safeCell(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, (ch) =>
    ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}` : `${bytes} (${human(bytes)})`;
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function kindOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean }): EntryKind {
  if (s.isFile()) return "file";
  if (s.isDirectory()) return "dir";
  if (s.isSymbolicLink()) return "symlink";
  if (s.isFIFO()) return "fifo";
  if (s.isSocket()) return "socket";
  if (s.isCharacterDevice()) return "char";
  if (s.isBlockDevice()) return "block";
  return "unknown";
}

function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code && err?.message) return `${err.code}: ${err.message.replace(/^[A-Z]+:\s*/, "").replace(/,\s*\w+ '.*'$/, "").trim() || err.code}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Single streaming pass over a regular file computing every requested content metric at once.
 *
 * Exactness matters here — these numbers exist to be trusted instead of a `wc` round-trip:
 *   - `lines` counts 0x0A bytes, which is exactly what `wc -l` reports (so a file whose last line
 *     lacks a newline reports N, not N+1; the `no-final-newline` note flags that case).
 *   - `words` counts transitions into a run of non-ASCII-whitespace bytes, matching `LC_ALL=C wc -w`.
 *     Because it is byte-based, multibyte UTF-8 sequences are never mistaken for separators.
 *   - Binary files short-circuit: a pre-flight probe must not stream 100MB of a .bin just to
 *     produce a meaningless line count. `binary` is reported and lines/words are omitted.
 */
async function scanContent(
  abs: string,
  size: number,
  need: { lines: boolean; words: boolean; sha256: boolean },
  signal?: AbortSignal,
): Promise<ContentStats> {
  const out: ContentStats = {
    lines: 0,
    words: 0,
    noFinalNewline: false,
    crlf: false,
    mixedEol: false,
    binary: false,
    skipped: false,
  };
  if (size === 0 && !need.sha256) return out;

  const hash = need.sha256 ? createHash("sha256") : undefined;
  const countText = need.lines || need.words;
  let inWord = false;
  let sniffed = 0;
  let crlfCount = 0;
  let prevByte = -1;
  let stopCounting = false;

  const stream = createReadStream(abs, { highWaterMark: CHUNK_BYTES });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (signal?.aborted) {
        stream.destroy();
        throw new Error("aborted");
      }
      hash?.update(chunk);

      if (!out.binary && sniffed < BINARY_SNIFF_BYTES) {
        const window = chunk.subarray(0, Math.min(chunk.length, BINARY_SNIFF_BYTES - sniffed));
        if (window.indexOf(0) !== -1) {
          out.binary = true;
          stopCounting = true;
          out.skipped = countText;
          out.lines = 0;
          out.words = 0;
          if (!hash) {
            stream.destroy();
            prevByte = -1;
            break;
          }
        }
        sniffed += chunk.length;
      }

      if (countText && !stopCounting) {
        const len = chunk.length;
        for (let i = 0; i < len; i++) {
          const b = chunk[i]!;
          if (b === 0x0a) {
            out.lines++;
            if ((i > 0 ? chunk[i - 1]! : prevByte) === 0x0d) crlfCount++;
            if (inWord) inWord = false;
          } else if (b === 0x20 || b === 0x09 || b === 0x0b || b === 0x0c || b === 0x0d) {
            if (inWord) inWord = false;
          } else if (!inWord) {
            inWord = true;
            out.words++;
          }
        }
        prevByte = chunk[len - 1]!;
      } else if (!countText) {
        prevByte = chunk[chunk.length - 1]!;
      }
    }
  } catch (e) {
    stream.destroy();
    throw e;
  }

  if (hash) out.sha256 = hash.digest("hex");
  if (countText && !stopCounting) {
    out.noFinalNewline = size > 0 && prevByte !== 0x0a;
    if (crlfCount > 0) {
      out.crlf = true;
      out.mixedEol = crlfCount < out.lines;
    }
  }
  return out;
}

/** Bounded-concurrency map, so a 50k-file tree doesn't open 50k file handles at once. */
async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Breadth-first directory walk producing a `du`-style aggregate.
 *
 * Uses readdir(withFileTypes) so directory recursion costs no extra syscalls, and only stat()s
 * regular files (for their size). Bounded by both a file-count limit and a wall-clock budget;
 * hitting either marks the aggregate PARTIAL rather than silently reporting a low total.
 */
async function walkDir(
  root: string,
  opts: { limit: number; top: number; followSymlinks: boolean; wantLines: boolean; wantWords: boolean },
  signal?: AbortSignal,
  onProgress?: (files: number, bytes: number) => void,
): Promise<DirAggregate> {
  const started = Date.now();
  let lastProgress = started;
  const agg: DirAggregate = {
    files: 0,
    dirs: 0,
    symlinks: 0,
    other: 0,
    totalBytes: 0,
    largest: [],
    byExt: [],
    extCount: 0,
    unreadableDirs: 0,
    partial: false,
    elapsedMs: 0,
  };
  const extMap = new Map<string, { files: number; bytes: number }>();
  const largest: Array<{ path: string; bytes: number }> = [];
  const filePaths: string[] = [];
  const seenDirs = new Set<string>();
  // Index-cursor queue instead of Array.shift(): a real tree has tens of thousands of directories, and
  // shift() on an array that large is an O(n) memmove per pop (measurably worse inside a memory-heavy
  // host process than in a standalone script).
  const queue: string[] = [root];
  let head = 0;
  const remaining = () => queue.length - head;

  while (remaining() > 0) {
    if (signal?.aborted) throw new Error("aborted");
    if (agg.files >= opts.limit) {
      agg.partial = true;
      agg.partialKind = "limit";
      agg.partialReason = `file limit ${opts.limit} reached`;
      agg.dirsUnscanned = remaining();
      break;
    }
    if (Date.now() - started > WALK_TIME_BUDGET_MS) {
      agg.partial = true;
      agg.partialKind = "time";
      agg.partialReason = `time budget ${WALK_TIME_BUDGET_MS}ms exceeded after ${agg.files} files`;
      agg.dirsUnscanned = remaining();
      break;
    }

    if (onProgress && Date.now() - lastProgress > 2_000) {
      lastProgress = Date.now();
      onProgress(agg.files, agg.totalBytes);
    }

    // Read a BATCH of directories concurrently. Real trees are wide and shallow-per-node (tens of
    // thousands of directories holding a handful of files each), so walking one directory at a time is
    // latency-bound: measured ~4x slower than batching on a 294k-file repo.
    const batch: string[] = [];
    while (batch.length < DIR_BATCH && remaining() > 0) batch.push(queue[head++]!);

    const perDir = await Promise.all(
      batch.map(async (dir) => {
        const files: string[] = [];
        const childDirs: string[] = [];
        let symlinks = 0;
        let other = 0;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (e) {
          return { dir, files, childDirs, symlinks, other, error: errText(e) };
        }
        for (const ent of entries) {
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            childDirs.push(full);
          } else if (ent.isSymbolicLink()) {
            symlinks++;
            if (opts.followSymlinks) {
              try {
                const st = await stat(full);
                if (st.isDirectory()) childDirs.push(full);
                else if (st.isFile()) files.push(full);
              } catch {
                /* broken symlink: counted as a symlink, nothing to measure */
              }
            }
          } else if (ent.isFile()) {
            files.push(full);
          } else {
            other++;
          }
        }
        return { dir, files, childDirs, symlinks, other, error: undefined as string | undefined };
      }),
    );

    const files: string[] = [];
    for (const r of perDir) {
      if (r.error) {
        agg.unreadableDirs++;
        if (!agg.firstUnreadable) agg.firstUnreadable = `${relative(root, r.dir) || "."} — ${r.error}`;
        continue;
      }
      agg.symlinks += r.symlinks;
      agg.other += r.other;
      for (const child of r.childDirs) {
        // Cycle guard only matters when following symlinks; realpath() per directory would otherwise
        // double the syscalls on every plain directory for no benefit.
        if (opts.followSymlinks) {
          let real: string;
          try {
            real = await realpath(child);
          } catch {
            continue;
          }
          if (seenDirs.has(real)) continue;
          seenDirs.add(real);
        }
        agg.dirs++;
        queue.push(child);
      }
      files.push(...r.files);
    }

    const sizes = await pool(files, STAT_CONCURRENCY, async (f) => {
      try {
        const st = await stat(f);
        return st.isFile() ? st.size : null;
      } catch {
        return null;
      }
    });

    for (let i = 0; i < files.length; i++) {
      const size = sizes[i];
      if (size === null || size === undefined) continue;
      const f = files[i]!;
      agg.files++;
      agg.totalBytes += size;
      if (opts.wantLines || opts.wantWords) filePaths.push(f);
      const ext = extname(f).toLowerCase() || "(none)";
      const cur = extMap.get(ext);
      if (cur) {
        cur.files++;
        cur.bytes += size;
      } else {
        extMap.set(ext, { files: 1, bytes: size });
      }
      if (opts.top > 0) {
        largest.push({ path: relative(root, f) || f, bytes: size });
        if (largest.length > opts.top * 8) {
          largest.sort((a, b) => b.bytes - a.bytes);
          largest.length = opts.top;
        }
      }
      if (agg.files >= opts.limit) break;
    }
  }

  largest.sort((a, b) => b.bytes - a.bytes);
  agg.largest = largest.slice(0, Math.max(0, opts.top));
  agg.extCount = extMap.size;
  agg.byExt = [...extMap.entries()]
    .map(([ext, v]) => ({ ext, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, MAX_EXT_ROWS);

  if (opts.wantLines || opts.wantWords) {
    if (agg.files > AGGREGATE_CONTENT_MAX_FILES) {
      agg.contentSkipReason = `>${AGGREGATE_CONTENT_MAX_FILES} files`;
    } else if (agg.totalBytes > AGGREGATE_CONTENT_MAX_BYTES) {
      agg.contentSkipReason = `>${human(AGGREGATE_CONTENT_MAX_BYTES)} total`;
    } else {
      let lines = 0;
      let words = 0;
      const counted = await pool(filePaths, 16, async (f) => {
        try {
          const st = await stat(f);
          return await scanContent(f, st.size, { lines: opts.wantLines, words: opts.wantWords, sha256: false }, signal);
        } catch {
          return null;
        }
      });
      for (const c of counted) {
        if (!c || c.binary) continue;
        lines += c.lines;
        words += c.words;
      }
      if (opts.wantLines) agg.lines = lines;
      if (opts.wantWords) agg.words = words;
    }
  }

  agg.elapsedMs = Date.now() - started;
  return agg;
}

async function measure(
  input: string,
  cwd: string,
  params: ParamsT,
  metrics: Set<Metric>,
  signal?: AbortSignal,
  onProgress?: (files: number, bytes: number) => void,
): Promise<Row> {
  const abs = normalizePath(input, cwd);
  const row: Row = { input, abs, kind: "unknown", notes: [] };

  let st;
  try {
    st = await stat(abs);
  } catch (e) {
    // stat() follows symlinks, so a broken symlink lands here. Distinguish it from a missing path:
    // "broken symlink" is actionable, "ENOENT" alone is misleading when the link itself exists.
    try {
      const ls = await lstat(abs);
      if (ls.isSymbolicLink()) {
        row.kind = "symlink";
        row.symlinkTarget = await readlink(abs).catch(() => "?");
        row.error = `broken symlink -> ${row.symlinkTarget} (${errText(e)})`;
        return row;
      }
      st = ls;
    } catch {
      row.error = errText(e);
      return row;
    }
  }

  try {
    const ls = await lstat(abs);
    if (ls.isSymbolicLink()) {
      row.symlinkTarget = await readlink(abs).catch(() => undefined);
      row.notes.push(`symlink -> ${row.symlinkTarget ?? "?"}`);
    }
  } catch {
    /* non-fatal */
  }

  row.kind = kindOf(st);
  row.bytes = st.size;
  row.mtimeMs = st.mtimeMs;

  if (row.kind === "dir") {
    if (params.recursive) {
      row.aggregate = await walkDir(
        abs,
        {
          limit: Math.min(Math.max(1, Math.floor(params.limit ?? DEFAULT_WALK_LIMIT)), MAX_WALK_LIMIT),
          top: Math.max(0, Math.floor(params.top ?? DEFAULT_TOP)),
          followSymlinks: !!params.followSymlinks,
          wantLines: metrics.has("lines"),
          wantWords: metrics.has("words"),
        },
        signal,
        onProgress,
      );
    } else {
      try {
        row.entries = (await readdir(abs)).length;
      } catch (e) {
        row.error = errText(e);
      }
    }
    return row;
  }

  if (row.kind !== "file") {
    // FIFOs/sockets/devices: never open them — reading a FIFO blocks forever, and /dev/zero is infinite.
    if (metrics.has("lines") || metrics.has("words") || metrics.has("sha256")) {
      row.notes.push(`content metrics skipped (${row.kind}, not a regular file)`);
    }
    return row;
  }

  const need = { lines: metrics.has("lines"), words: metrics.has("words"), sha256: metrics.has("sha256") };
  if (need.lines || need.words || need.sha256) {
    try {
      row.content = await scanContent(abs, st.size, need, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      row.notes.push(`content read failed: ${errText(e)}`);
    }
  }
  return row;
}

function renderRows(rows: Row[], metrics: Set<Metric>, params: ParamsT): string {
  const showBytes = metrics.has("bytes");
  const showLines = metrics.has("lines");
  const showWords = metrics.has("words");
  const showMtime = metrics.has("mtime");
  const showSha = metrics.has("sha256");

  const header: string[] = ["PATH", "TYPE"];
  if (showBytes) header.push("BYTES");
  if (showLines) header.push("LINES");
  if (showWords) header.push("WORDS");
  if (showMtime) header.push("MTIME");
  if (showSha) header.push("SHA256");
  header.push("NOTES");

  const body: string[][] = [];
  const aggregates: string[] = [];

  for (const row of rows) {
    const cells: string[] = [safeCell(row.input)];
    if (row.error && !row.bytes && row.kind !== "dir") {
      cells.push("ERROR");
      const pad = header.length - 3;
      for (let i = 0; i < pad; i++) cells.push("-");
      cells.push(row.error);
      body.push(cells);
      continue;
    }

    cells.push(row.kind);
    const c = row.content;
    const isRegular = row.kind === "file";
    // For a recursive directory the useful number is the tree total (the `du -sh` answer), not the
    // directory inode's own size — show the total here and say so in NOTES so the two can't be confused.
    if (showBytes) {
      cells.push(
        row.aggregate
          ? formatBytes(row.aggregate.totalBytes)
          : row.bytes === undefined
            ? "-"
            : formatBytes(row.bytes),
      );
    }
    if (showLines) {
      cells.push(
        c && !c.skipped && isRegular
          ? String(c.lines) + (c.noFinalNewline ? "*" : "")
          : row.kind === "dir"
            ? row.aggregate?.lines !== undefined
              ? String(row.aggregate.lines)
              : "-"
            : "-",
      );
    }
    if (showWords) {
      cells.push(
        c && !c.skipped && isRegular
          ? String(c.words)
          : row.kind === "dir" && row.aggregate?.words !== undefined
            ? String(row.aggregate.words)
            : "-",
      );
    }
    if (showMtime) cells.push(row.mtimeMs === undefined ? "-" : formatMtime(row.mtimeMs));
    // Never truncate a checksum: a partial hash can't be pasted or compared against a published one.
    if (showSha) cells.push(c?.sha256 ?? "-");

    const notes = [...row.notes];
    if (row.aggregate) {
      notes.push(`bytes = recursive tree total (dir inode itself is ${row.bytes ?? "?"} B)`);
    }
    if (row.kind === "dir" && !params.recursive && !row.error) {
      notes.push(`${row.entries ?? "?"} entries (pass recursive:true for total size)`);
    }
    if (c?.binary) notes.push("binary (NUL byte) — lines/words not counted");
    if (c?.noFinalNewline) notes.push("no-final-newline (* = wc -l count; +1 unterminated line)");
    if (c?.crlf) notes.push(c.mixedEol ? "mixed CRLF/LF" : "CRLF");
    if (row.bytes === 0 && isRegular) notes.push("empty");
    if (row.error) notes.push(row.error);
    cells.push(safeCell(notes.join("; ")));
    body.push(cells);

    if (row.aggregate) aggregates.push(renderAggregate(row, row.aggregate, metrics));
  }

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();

  const table = [line(header), ...body.map(line)].join("\n");
  return aggregates.length > 0 ? `${table}\n\n${aggregates.join("\n\n")}` : table;
}

function renderAggregate(row: Row, agg: DirAggregate, metrics: Set<Metric>): string {
  const out: string[] = [];
  out.push(`=== ${safeCell(row.input)} (recursive aggregate${agg.partial ? ", PARTIAL" : ""}) ===`);
  out.push(
    `files ${agg.files}  dirs ${agg.dirs}  symlinks ${agg.symlinks}${agg.other ? `  other ${agg.other}` : ""}  ` +
      `total ${formatBytes(agg.totalBytes)}  [sum of regular-file sizes, apparent; excludes dir inodes, so it is ` +
      `slightly below \`du -sh\`]`,
  );
  if (agg.lines !== undefined) out.push(`total lines ${agg.lines}${agg.words !== undefined ? `  total words ${agg.words}` : ""}`);
  else if (agg.words !== undefined) out.push(`total words ${agg.words}`);
  else if (agg.contentSkipReason) out.push(`line/word totals skipped: ${agg.contentSkipReason} — measure specific files instead`);
  if (metrics.has("sha256")) out.push("sha256 is per-file only; not aggregated for directories");
  if (agg.partial) {
    const missing = agg.dirsUnscanned ? ` ≥${agg.dirsUnscanned} directories were never scanned.` : "";
    out.push(
      agg.partialKind === "time"
        ? `PARTIAL: ${agg.partialReason}.${missing} Totals are LOWER BOUNDS and a time-bounded scan can return a ` +
            `different number each call, so do NOT retry with a bigger 'limit' — this tree is too large/slow to ` +
            `measure here: aggregate specific subdirectories instead, or accept \`du -sh\` (disk blocks, not apparent bytes).`
        : `PARTIAL: ${agg.partialReason}.${missing} Totals are LOWER BOUNDS — raise 'limit' (one retry only; if the ` +
            `next call reports a time-budget stop, switch to per-subdirectory aggregates or \`du -sh\`).`,
    );
  }
  if (agg.unreadableDirs > 0) {
    out.push(`unreadable dirs: ${agg.unreadableDirs} (first: ${agg.firstUnreadable}) — totals exclude their contents`);
  }
  if (agg.largest.length > 0) {
    out.push("largest files:");
    for (const l of agg.largest) out.push(`  ${formatBytes(l.bytes).padEnd(18)} ${safeCell(l.path)}`);
  }
  if (agg.byExt.length > 0) {
    out.push("by extension:");
    for (const e of agg.byExt) out.push(`  ${e.ext.padEnd(10)} ${String(e.files).padStart(6)} files  ${human(e.bytes)}`);
    if (agg.extCount > agg.byExt.length) out.push(`  ... +${agg.extCount - agg.byExt.length} more extensions`);
  }
  out.push(`scanned in ${agg.elapsedMs}ms`);
  return out.join("\n");
}

class PathStatsExtension {
  constructor(private pi: ExtensionAPI) {}

  init() {
    this.pi.registerTool({
      name: "path_stats",
      label: "Path Stats",
      description:
        "Measure how big paths are BEFORE reading them: bytes, lines (`wc -l`-exact), words, mtime, type, sha256, " +
        "plus `du`-style recursive directory totals (largest files, per-extension breakdown). Replaces `wc -l|-c|-w`, " +
        "`stat`, `du -sh`, `shasum -a 256` and `ls -la`-for-sizes — one call, many paths, exact numbers (no " +
        "`find|wc` pipelines that double-count).\n" +
        "Ex: path_stats {paths:['server.log','src/'],recursive:true}. Does NOT list or glob — use list_files/grep " +
        "for discovery, path_stats to measure known paths.",
      promptSnippet: "Measure size/shape of files and dirs (lines, bytes, mtime, sha256, du-style dir totals)",
      promptGuidelines: [
        "Call path_stats before read/multi_file_read/`tail` on any file that might be large or unfamiliar (logs, data " +
          "dumps, generated/minified files) to decide whether to read it whole, read a range, or grep it.",
        "Use path_stats instead of bash `wc -l|-c|-w`/`stat`/`du -sh`/`shasum`/`ls -la`-for-sizes, and pass every " +
          "path in ONE call rather than one bash round-trip per path.",
        "path_stats `lines` == `wc -l` (newline count): a `*` plus `no-final-newline` note means N+1 lines of text. " +
          "`recursive:true` for directory totals; without it a directory reports only its entry count.",
        "Treat PARTIAL, `binary`, `unreadable dirs` or `content metrics skipped` as an incomplete measurement (lower " +
          "bound or absent), not an exact number.",
      ],
      parameters: Params,
      execute: async (_toolCallId, rawParams, signal, onUpdate, ctx: ExtensionContext) => {
        const params = rawParams as ParamsT;
        const inputs = Array.isArray(params.paths) ? params.paths.filter((p) => typeof p === "string") : [];
        if (inputs.length === 0) {
          throw new Error("path_stats: 'paths' must contain at least one path");
        }
        const metricList: Metric[] =
          params.metrics && params.metrics.length > 0 ? (params.metrics as Metric[]) : ["bytes", "lines", "type"];
        const metrics = new Set<Metric>(metricList);
        metrics.add("type");
        if (!metrics.has("bytes") && !metrics.has("lines") && !metrics.has("words") && !metrics.has("sha256")) {
          metrics.add("bytes");
        }

        if (signal?.aborted) throw new Error("path_stats: cancelled");
        const accepted = inputs.slice(0, MAX_PATHS);
        const dropped = inputs.length - accepted.length;

        onUpdate?.({
          content: [{ type: "text", text: `Measuring ${accepted.length} path(s)...` }],
          details: { pending: true },
        });

        const rows: Row[] = [];
        // Sequential over paths so a recursive walk's progress and the time budget stay predictable;
        // the expensive inner loops (stat/read) are already parallel.
        for (const input of accepted) {
          try {
            rows.push(
              await measure(input, ctx.cwd, params, metrics, signal, (files, bytes) => {
                // Long directory walks are the only slow path; show liveness instead of a silent stall.
                onUpdate?.({
                  content: [{ type: "text", text: `${input}: ${files} files, ${human(bytes)} so far...` }],
                  details: { pending: true },
                });
              }),
            );
          } catch (e) {
            if (signal?.aborted) throw new Error("path_stats: cancelled");
            rows.push({ input, abs: input, kind: "unknown", error: errText(e), notes: [] });
          }
        }

        let text = renderRows(rows, metrics, params);
        if (dropped > 0) {
          text += `\n\n[${dropped} additional path(s) not measured: max ${MAX_PATHS} per call — split into multiple calls]`;
        }
        if (text.length > MAX_CHARS) {
          text = text.slice(0, MAX_CHARS) + `\n... [output truncated at ${MAX_CHARS} chars — measure fewer paths per call]`;
        }

        return {
          content: [{ type: "text", text }],
          details: {
            metrics: [...metrics],
            recursive: !!params.recursive,
            rows: rows.map((r) => ({
              path: r.input,
              type: r.kind,
              bytes: r.bytes,
              lines: r.content && !r.content.skipped ? r.content.lines : undefined,
              words: r.content && !r.content.skipped ? r.content.words : undefined,
              sha256: r.content?.sha256,
              mtimeMs: r.mtimeMs,
              entries: r.entries,
              binary: r.content?.binary,
              noFinalNewline: r.content?.noFinalNewline,
              crlf: r.content?.crlf,
              symlinkTarget: r.symlinkTarget,
              error: r.error,
              aggregate: r.aggregate,
            })),
          },
        };
      },
      renderCall: (args, theme) => {
        const a = args as ParamsT;
        const paths = Array.isArray(a?.paths) ? a.paths : [];
        const label = paths.length === 1 ? paths[0]! : `${paths.length} paths`;
        const extras: string[] = [];
        if (a?.recursive) extras.push("recursive");
        if (a?.metrics && a.metrics.length > 0) extras.push(a.metrics.join(","));
        return new Text(
          theme.fg("toolTitle", theme.bold("path_stats ")) +
            theme.fg("accent", label) +
            (extras.length ? theme.fg("dim", ` [${extras.join(" ")}]`) : ""),
          0,
          0,
        );
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", "Measuring..."), 0, 0);
        const first = result.content[0];
        const content = (first && "text" in first ? first.text : "") ?? "";
        const lines = content.split("\n");
        if (!expanded && lines.length > 20) {
          return new Text(lines.slice(0, 20).join("\n") + `\n... and ${lines.length - 20} more lines`, 0, 0);
        }
        return new Text(content, 0, 0);
      },
    });
  }
}

export default function (pi: ExtensionAPI) {
  new PathStatsExtension(pi).init();
}
