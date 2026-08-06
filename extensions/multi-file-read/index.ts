/**
 * multi-file-read: read many files in one tool call.
 *
 * Motivation: agents often need 3-10 files at once and fall back to
 * `bash: cat a b c`, which loses line numbers, has no per-file error
 * handling, and can dump unbounded bytes into context. This tool reads
 * them in parallel with per-file error entries, line numbers, and a
 * max-min fair byte budget so one huge file cannot starve the rest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** Default total byte budget across all files (same order as built-in read's 50KB). */
const DEFAULT_TOTAL_BYTES = 50 * 1024;
/** Hard ceiling a caller can request. */
const MAX_TOTAL_BYTES = 200 * 1024;
/** Max files accepted per call; extras become error entries. */
const MAX_FILES = 50;
/** Bytes sniffed for binary detection. */
const SNIFF_BYTES = 8192;
/**
 * Largest single file this tool will load into memory. Reading many files at
 * once multiplies memory use, so oversized files are refused with a bash
 * fallback instead of risking an OOM on a slow or network filesystem.
 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);

type FileSpec = { path: string; offset?: number; limit?: number };

type Loaded =
  | {
      kind: "ok";
      spec: FileSpec;
      display: string;
      lines: string[]; // selected lines (after offset/limit)
      startLine: number; // 1-indexed first selected line
      totalLines: number;
      bytes: number;
      userLimited: boolean;
    }
  | { kind: "error"; spec: FileSpec; display: string; message: string };

/** Resolve a path like pi's read tool: strip a leading @, expand ~, resolve vs cwd. */
function resolveInputPath(raw: string, cwd: string): string {
  let p = raw.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = resolvePath(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolvePath(cwd, p);
}

function isBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Detect text that is not UTF-8 so it is reported instead of silently decoded
 * into mojibake. Covers UTF-16/UTF-32 BOMs (a BOM-less non-ASCII UTF-16 file
 * may contain no NUL in the sniff window) and, as a fallback, a decode that
 * produced a meaningful share of U+FFFD replacement characters.
 */
function badEncoding(buffer: Buffer, text: string): string | null {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return "UTF-16LE/UTF-32LE BOM";
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return "UTF-16BE BOM";
  }
  const sniff = text.slice(0, SNIFF_BYTES);
  if (sniff.length === 0) return null;
  let bad = 0;
  for (let i = 0; i < sniff.length; i++) {
    if (sniff.charCodeAt(i) === 0xfffd) bad++;
  }
  // >2% replacement characters is far above what real UTF-8 text produces.
  if (bad > 4 && bad / sniff.length > 0.02) return "not valid UTF-8 text";
  return null;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function errorMessage(error: unknown): string {
  const err = error as { code?: string; message?: string };
  switch (err?.code) {
    case "ENOENT":
      return "file not found";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "path is a directory, not a file";
    default:
      return err?.message ?? String(error);
  }
}

async function loadFile(spec: FileSpec, cwd: string, signal?: AbortSignal): Promise<Loaded> {
  const display = spec.path;
  const absolute = resolveInputPath(spec.path, cwd);
  try {
    signal?.throwIfAborted();
    const info = await stat(absolute);
    if (info.isDirectory()) {
      return { kind: "error", spec, display, message: "path is a directory, not a file" };
    }
    if (!info.isFile()) {
      // FIFOs/sockets/devices can block forever on read - never touch them.
      const what = info.isFIFO()
        ? "a FIFO/pipe"
        : info.isSocket()
          ? "a socket"
          : info.isBlockDevice() || info.isCharacterDevice()
            ? "a device"
            : "not a regular file";
      return { kind: "error", spec, display, message: `${what} - refusing to read (would block)` };
    }
    if (info.size > MAX_FILE_BYTES) {
      return {
        kind: "error",
        spec,
        display,
        message: `file is ${formatSize(info.size)}, over the ${formatSize(MAX_FILE_BYTES)} per-file limit - use bash: head -c 50000 ${display} (or grep/sed for the part you need)`,
      };
    }
    const ext = extensionOf(absolute);
    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        kind: "error",
        spec,
        display,
        message: `image file (.${ext}) - multi_file_read is text-only; use the read tool to view images as attachments`,
      };
    }
    const buffer = await readFile(absolute, { signal });
    // BOM check before the NUL sniff: UTF-16 text is a wrong-encoding problem,
    // and saying so is more actionable than calling it "binary".
    const bom = badEncoding(buffer, "");
    if (bom) {
      return {
        kind: "error",
        spec,
        display,
        message: `${bom} - only UTF-8 text is decoded; convert it with bash iconv if needed`,
      };
    }
    if (isBinary(buffer)) {
      return {
        kind: "error",
        spec,
        display,
        message: `binary file (${formatSize(buffer.length)}) - skipped`,
      };
    }
    const text = buffer.toString("utf-8");
    const encodingProblem = badEncoding(buffer, text);
    if (encodingProblem) {
      return {
        kind: "error",
        spec,
        display,
        message: `${encodingProblem} - only UTF-8 text is decoded; convert it with bash iconv if needed`,
      };
    }
    const allLines = text.split("\n");
    // A trailing newline is a terminator, not an extra empty line - dropping it
    // keeps reported line counts equal to `wc -l` and avoids emitting a bogus
    // empty final line.
    if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();
    if (text.length === 0) {
      return { kind: "error", spec, display, message: "empty file (0 bytes)" };
    }
    const totalLines = allLines.length;
    const startIndex = spec.offset ? Math.max(0, spec.offset - 1) : 0;
    if (startIndex >= totalLines) {
      return {
        kind: "error",
        spec,
        display,
        message: `offset ${spec.offset} is beyond end of file (${totalLines} lines total)`,
      };
    }
    const endIndex =
      spec.limit !== undefined && spec.limit > 0
        ? Math.min(startIndex + spec.limit, totalLines)
        : totalLines;
    const lines = allLines.slice(startIndex, endIndex);
    return {
      kind: "ok",
      spec,
      display,
      lines,
      startLine: startIndex + 1,
      totalLines,
      bytes: Buffer.byteLength(lines.join("\n"), "utf-8"),
      userLimited: endIndex < totalLines,
    };
  } catch (error) {
    // Cancellation must abort the whole call, not degrade into a per-file error.
    if ((error as { name?: string })?.name === "AbortError" || signal?.aborted) throw error;
    return { kind: "error", spec, display, message: errorMessage(error) };
  }
}

/**
 * Dedup key: the REAL path (symlinks resolved) plus the requested range, so
 * `link.txt` and its target are recognised as the same file. Falls back to the
 * lexical path when the file does not exist (realpath throws) - those become
 * per-file errors anyway.
 */
async function dedupKey(spec: FileSpec, cwd: string): Promise<string> {
  const absolute = resolveInputPath(spec.path, cwd);
  let real = absolute;
  try {
    real = await realpath(absolute);
  } catch {
    /* keep lexical path */
  }
  return `${real}\u0000${spec.offset ?? ""}\u0000${spec.limit ?? ""}`;
}

/**
 * Max-min fair allocation: smallest files get satisfied first, and every
 * byte a small file does not use is redistributed to the larger ones. This
 * guarantees no single huge file can consume the whole budget while other
 * requested files return empty.
 */
function allocate(sizes: number[], budget: number): number[] {
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  const result = new Array<number>(sizes.length).fill(0);
  let remaining = budget;
  let left = order.length;
  for (const { size, index } of order) {
    const share = Math.floor(remaining / left);
    const give = Math.min(size, share);
    result[index] = give;
    remaining -= give;
    left--;
  }
  return result;
}

/**
 * Truncate a selected line list to fit a byte budget, keeping whole lines.
 * `perLineOverhead` accounts for the rendered line-number prefix so the budget
 * bounds what actually lands in context, not just raw file bytes.
 */
function fitLines(
  lines: string[],
  budget: number,
  perLineOverhead = 0,
): { kept: string[]; bytes: number } {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0) + perLineOverhead;
    if (bytes + cost > budget) break;
    kept.push(lines[i]);
    bytes += cost;
  }
  return { kept, bytes };
}

function numberLines(lines: string[], startLine: number, withNumbers: boolean): string {
  if (!withNumbers) return lines.join("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, " ")}|${line}`)
    .join("\n");
}

/**
 * Final safety net so the emitted text is always <= budget bytes: drop whole
 * trailing lines and say so. Only fires if the per-file overhead reserve was
 * an underestimate.
 */
function clipToBudget(text: string, budget: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= budget) return { text, clipped: false };
  const notice = "\n[OUTPUT CLIPPED: total output budget reached; re-request remaining paths separately]";
  const allowed = Math.max(0, budget - Buffer.byteLength(notice, "utf-8"));
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (bytes + cost > allowed) break;
    kept.push(lines[i]);
    bytes += cost;
  }
  return { text: `${kept.join("\n")}${notice}`, clipped: true };
}

function normalizeSpecs(input: unknown): FileSpec[] {
  const raw = Array.isArray(input) ? input : [];
  const specs: FileSpec[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      specs.push({ path: entry });
    } else if (entry && typeof entry === "object" && typeof (entry as FileSpec).path === "string") {
      const e = entry as FileSpec;
      specs.push({ path: e.path, offset: e.offset, limit: e.limit });
    }
  }
  return specs;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "multi_file_read",
    label: "Multi Read",
    description:
      "PREFERRED way to read 2 or more known file paths - use this instead of `bash cat/head/sed` or several read calls, " +
      "including when you only want the first lines of each (pass limit instead of `head -n`). " +
      "Read several text files in ONE call. Returns each file under a `===== path (lines a-b of N) =====` header " +
      "with 1-indexed line numbers, so results are directly citable and editable. " +
      "Each entry accepts optional offset/limit, missing/unreadable/binary/image files come back as per-file " +
      "`!!!!! path - ERROR: ...` entries instead of failing the call, and output is capped by a shared byte budget " +
      `(default ${DEFAULT_TOTAL_BYTES / 1024}KB, max ${MAX_TOTAL_BYTES / 1024}KB) that is fairly split so one huge file cannot ` +
      "crowd out the others; any truncation is reported with an explicit offset to continue from.\n" +
      'Example: {"files":[{"path":"src/a.ts"},{"path":"README.md","offset":1,"limit":40}]}\n' +
      "Best with 2-10 files: the budget is shared, so requesting ~25+ large files returns only the first few dozen lines of each. " +
      "Prefer multi_file_read over several read calls or `bash cat/head` when you want 2+ files. " +
      "Use read for a single file or an image; use grep/code_search when you need to find content rather than read known paths.",
    promptSnippet:
      "Read multiple text files in one call, with line numbers and per-file error entries",
    promptGuidelines: [
      "Use multi_file_read instead of multiple read calls or `bash cat`/`head`/`sed` whenever you need 2 or more files; use the built-in read for exactly one file or for images.",
      "Never shell out to `cat`/`head`/`sed` to peek at several files: call multi_file_read with a per-file `limit` instead - it is bounded, numbered, and cheaper than a bash loop.",
      "Pass every path you need to multi_file_read in a single call - it reads them in parallel and reports missing/unreadable files individually instead of aborting.",
      "If a multi_file_read entry reports truncation, re-request just that path with the suggested offset rather than re-reading everything.",
      "Keep a multi_file_read call to roughly 2-10 files (or pass per-file limit) - the byte budget is shared, so many large files each come back heavily truncated.",
      "Treat a multi_file_read `!!!!! path - ERROR: ... !!!!!` entry as authoritative for that path only; the other files in the same call are still complete and usable.",
      "multi_file_read is text-only: it refuses image files, so read images with the read tool.",
    ],
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({
          path: Type.String({ description: "File path (relative to cwd, absolute, or ~/...)" }),
          offset: Type.Optional(
            Type.Number({ description: "1-indexed line to start reading this file from" }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Max lines to read from this file" }),
          ),
        }),
        {
          description: `Files to read (max ${MAX_FILES} per call)`,
          minItems: 1,
        },
      ),
      maxTotalBytes: Type.Optional(
        Type.Number({
          description: `Total byte budget shared across all files (default ${DEFAULT_TOTAL_BYTES}, max ${MAX_TOTAL_BYTES})`,
        }),
      ),
      lineNumbers: Type.Optional(
        Type.Boolean({
          description: "Prefix each content line with its line number (default true)",
        }),
      ),
    }),
    prepareArguments(args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const source = input.files ?? input.paths;
      return {
        ...input,
        paths: undefined,
        files: normalizeSpecs(source),
      } as { files: FileSpec[]; maxTotalBytes?: number; lineNumbers?: boolean };
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const withNumbers = params.lineNumbers !== false;
      const budget = Math.max(
        1024,
        Math.min(params.maxTotalBytes ?? DEFAULT_TOTAL_BYTES, MAX_TOTAL_BYTES),
      );

      // Deduplicate identical requests (same path+range) while preserving order.
      const seen = new Set<string>();
      const requested: FileSpec[] = [];
      let duplicates = 0;
      signal?.throwIfAborted();
      for (const raw of normalizeSpecs(params.files)) {
        // Normalize the displayed path (strip a stray leading @) and dedupe on
        // the REAL path so the same file requested under two spellings
        // (a.txt vs ./a.txt vs a symlink vs an absolute path) is not emitted twice.
        const spec: FileSpec = { ...raw, path: raw.path.trim().replace(/^@/, "") };
        const key = await dedupKey(spec, cwd);
        if (seen.has(key)) {
          duplicates++;
          continue;
        }
        seen.add(key);
        requested.push(spec);
      }
      if (requested.length === 0) {
        throw new Error("multi_file_read: `files` must contain at least one path");
      }
      const overflow = requested.slice(MAX_FILES);
      const specs = requested.slice(0, MAX_FILES);

      onUpdate?.({
        content: [{ type: "text", text: `Reading ${specs.length} file(s)...` }],
        details: {},
      });

      const loaded = await Promise.all(specs.map((spec) => loadFile(spec, cwd, signal)));
      signal?.throwIfAborted();

      const okFiles = loaded.filter((entry): entry is Extract<Loaded, { kind: "ok" }> => entry.kind === "ok");
      // Reserve room for headers/truncation notices so the real emitted size
      // stays within `budget` rather than overshooting it.
      const overheadReserve = loaded.reduce(
        (sum, entry) => sum + entry.display.length + (entry.kind === "ok" ? 160 : 40),
        0,
      );
      const contentBudget = Math.max(512, budget - overheadReserve);
      const numberingOverhead = (file: Extract<Loaded, { kind: "ok" }>) =>
        withNumbers ? String(file.startLine + file.lines.length - 1).length + 1 : 0;
      const budgets = allocate(
        okFiles.map((f) => f.bytes + numberingOverhead(f) * f.lines.length),
        contentBudget,
      );
      const perFileBudget = new Map<Loaded, number>();
      okFiles.forEach((file, i) => perFileBudget.set(file, budgets[i]));

      const blocks: string[] = [];
      let okCount = 0;
      let errorCount = 0;
      let truncatedCount = 0;
      let emittedLines = 0;
      let emittedBytes = 0;
      const perFile: Array<Record<string, unknown>> = [];

      for (const entry of loaded) {
        if (entry.kind === "error") {
          errorCount++;
          blocks.push(`!!!!! ${entry.display} - ERROR: ${entry.message} !!!!!`);
          perFile.push({ path: entry.display, ok: false, error: entry.message });
          continue;
        }
        okCount++;
        // Per-file line cap first (mirrors read's 2000-line limit), then byte budget.
        const lineCapped = entry.lines.slice(0, DEFAULT_MAX_LINES);
        let truncatedBy: "lines" | "bytes" | null =
          lineCapped.length < entry.lines.length ? "lines" : null;
        const { kept, bytes } = fitLines(
          lineCapped,
          perFileBudget.get(entry) ?? 0,
          numberingOverhead(entry),
        );
        if (kept.length < lineCapped.length) truncatedBy = "bytes";

        const lastLine = entry.startLine + kept.length - 1;
        const shownAll = !truncatedBy && !entry.userLimited;
        const header =
          kept.length === 0
            ? `===== ${entry.display} (no lines shown, ${entry.totalLines} lines total) =====`
            : `===== ${entry.display} (lines ${entry.startLine}-${lastLine} of ${entry.totalLines}${shownAll ? "" : ", partial"}) =====`;
        let block = header;
        if (kept.length > 0) {
          block += `\n${numberLines(kept, entry.startLine, withNumbers)}`;
        }
        if (truncatedBy && kept.length === 0) {
          // The first requested line alone exceeds this file's share of the
          // budget. A continuation offset would loop forever here, so point at
          // a bash fallback instead (mirrors the built-in read tool).
          truncatedCount++;
          const lineBytes = formatSize(Buffer.byteLength(entry.lines[0], "utf-8"));
          block += `\n[TRUNCATED: line ${entry.startLine} alone is ${lineBytes} and does not fit the output budget. Use bash: sed -n '${entry.startLine}p' ${entry.display} | head -c 2000]`;
        } else if (truncatedBy) {
          truncatedCount++;
          const reason =
            truncatedBy === "lines"
              ? `${DEFAULT_MAX_LINES}-line per-file limit`
              : `shared ${formatSize(budget)} output budget`;
          block += `\n[TRUNCATED by ${reason}: ${kept.length} of ${entry.lines.length} requested lines shown. Continue with {"path":"${entry.display}","offset":${lastLine + 1}}]`;
        } else if (entry.userLimited) {
          block += `\n[${entry.totalLines - lastLine} more lines in file. Continue with {"path":"${entry.display}","offset":${lastLine + 1}}]`;
        }
        blocks.push(block);
        emittedLines += kept.length;
        emittedBytes += bytes;
        perFile.push({
          path: entry.display,
          ok: true,
          startLine: entry.startLine,
          endLine: lastLine,
          totalLines: entry.totalLines,
          truncated: truncatedBy !== null,
          truncatedBy,
        });
      }

      for (const spec of overflow) {
        errorCount++;
        blocks.push(
          `!!!!! ${spec.path} - ERROR: not read, exceeds the ${MAX_FILES}-file-per-call limit !!!!!`,
        );
        perFile.push({ path: spec.path, ok: false, error: "exceeds per-call file limit" });
      }

      const summaryParts = [
        `${okCount} file(s) read`,
        `${errorCount} error(s)`,
        `${emittedLines} lines`,
        formatSize(emittedBytes),
      ];
      if (truncatedCount > 0) summaryParts.push(`${truncatedCount} truncated`);
      if (duplicates > 0) summaryParts.push(`${duplicates} duplicate request(s) collapsed`);
      const summary = `multi_file_read: ${summaryParts.join(", ")}`;
      // Hard guarantee: whatever the header/notice overhead estimate did, the
      // emitted text never exceeds the requested budget.
      const { text: output, clipped } = clipToBudget(`${summary}\n\n${blocks.join("\n\n")}`, budget);

      return {
        content: [{ type: "text", text: output }],
        details: {
          summary,
          files: perFile,
          totalBytes: emittedBytes,
          budget,
          truncatedCount,
          errorCount,
          clipped,
        },
      };
    },
    renderCall(args, theme) {
      const specs = normalizeSpecs((args as { files?: unknown })?.files);
      const names = specs.map((s) => s.path).join(", ");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("multi_file_read"))} ${theme.fg("accent", names || "(no files)")}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = (result.details ?? {}) as {
        summary?: string;
        files?: Array<{ path: string; ok: boolean; error?: string; startLine?: number; endLine?: number; truncated?: boolean }>;
      };
      const lines: string[] = [];
      if (details.summary) lines.push(theme.fg("muted", details.summary));
      for (const file of details.files ?? []) {
        lines.push(
          file.ok
            ? `  ${theme.fg("accent", file.path)} ${theme.fg("muted", `${file.startLine}-${file.endLine}`)}${file.truncated ? theme.fg("warning", " [truncated]") : ""}`
            : `  ${theme.fg("error", file.path)} ${theme.fg("warning", file.error ?? "error")}`,
        );
      }
      const max = options.expanded ? lines.length : 12;
      const shown = lines.slice(0, max);
      if (lines.length > max) {
        shown.push(theme.fg("muted", `  ... ${lines.length - max} more`));
      }
      return new Text(shown.join("\n"), 0, 0);
    },
  });
}
