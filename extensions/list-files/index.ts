/**
 * list-files: one tool call instead of a `find`/`ls` shell pipeline.
 *
 * Motivation (measured over 266 real pi sessions): 356 of 1539 shell commands
 * were file listings — `find -iname` (129), `ls -la` (66), `ls | grep` (52),
 * multi-pattern `find -o -iname` (39), `find | grep -v` (36),
 * `find -not -path` build-dir excludes (29), `find -maxdepth` (21), `readlink` (15).
 * Every one of those needs quoting, a noise filter, and an output cap that the
 * agent has to remember. This tool does them in a single structured call with
 * default noise pruning, a hard output cap, and explicit truncation reporting.
 *
 * Implemented directly on node:fs (no shell, no deps) so filenames with spaces,
 * quotes, newlines or unicode need no escaping, symlink loops cannot hang it,
 * and permission errors are reported instead of being swallowed by 2>/dev/null.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";

/** Default number of paths emitted per call. */
const DEFAULT_LIMIT = 100;
/** Hard ceiling a caller can request. */
const MAX_LIMIT = 5000;
/** Hard byte cap on emitted text (same order as built-in tools' 50KB). */
const MAX_CHARS = 50_000;
/**
 * Byte cap applied when the caller did NOT ask for a specific `limit`. Keeps an
 * accidental unfiltered listing (`{}` on a monorepo root) from dumping 15KB of
 * irrelevant paths, while an explicit `limit` still gets the full 50KB budget.
 */
const SOFT_MAX_CHARS = 8_000;
/** Stop walking after this many directory entries have been visited. */
const MAX_SCAN_ENTRIES = 400_000;
/** Stop walking after this long (ms) and report a partial result. */
const MAX_SCAN_MS = 20_000;
/** Never retain more matches than this in memory (sorting needs them all). */
const MAX_MATCHES = 50_000;
/** Max directory groups printed in countOnly mode. */
const MAX_COUNT_GROUPS = 25;
/** Directory basenames pruned unless includeIgnored is set. */
const DEFAULT_IGNORED_DIRS = [
  ".git",
  "build",
  "node_modules",
  ".gradle",
  "dist",
  ".idea",
  ".venv",
];

type EntryKind = "file" | "dir" | "symlink" | "other";

interface Match {
  /** Path as emitted: relative to the requested root (or absolute if the root was). */
  display: string;
  absolute: string;
  kind: EntryKind;
  size?: number;
  mtimeMs?: number;
  /** Resolved symlink target, only when resolveSymlinks is set. */
  linkTarget?: string;
}

interface WalkStats {
  scanned: number;
  prunedIgnored: Map<string, number>;
  prunedExcluded: number;
  unreadable: string[];
  hitScanCap: boolean;
  hitTimeCap: boolean;
  hitMatchCap: boolean;
}

/** Resolve an input path like pi's built-in tools: strip a leading @, expand ~, resolve vs cwd. */
function resolveInputPath(raw: string, cwd: string): string {
  let p = raw.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = resolvePath(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolvePath(cwd, p);
}

/** Display prefix for a root: "" for "." so results read like `src/a.kt`, not `./src/a.kt`. */
function displayPrefix(raw: string): string {
  let p = raw.trim().replace(/^@/, "");
  p = p.replace(/\/+$/, "");
  if (p === "" || p === "." ) return "";
  return p;
}

const GLOB_META = /[*?\[\]{}]/;

/**
 * Convert a glob to a RegExp source.
 * `*` matches within one path segment, `**` crosses separators, `?` one char,
 * `[...]` a character class, `{a,b}` an alternation.
 */
function globToRegexSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` should also match zero directories ("**/x" matches "x").
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        i++;
        continue;
      }
      let cls = glob.slice(i + 1, end);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      out += `[${cls}]`;
      i = end + 1;
      continue;
    }
    if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        i++;
        continue;
      }
      const parts = glob.slice(i + 1, end).split(",");
      out += `(?:${parts.map(globToRegexSource).join("|")})`;
      i = end + 1;
      continue;
    }
    out += c.replace(/[.+^$(){}|\\\/]/g, (m) => `\\${m}`);
    i++;
  }
  return out;
}

interface CompiledGlob {
  raw: string;
  /** True when the glob is matched against the path relative to the root, not the basename. */
  pathScoped: boolean;
  regex: RegExp;
  /** Literal (no wildcard) globs can fall back to substring matching when nothing matched. */
  literal: boolean;
}

function compileGlob(glob: string, caseSensitive: boolean): CompiledGlob {
  const pathScoped = glob.includes("/");
  const flags = caseSensitive ? "" : "i";
  return {
    raw: glob,
    pathScoped,
    regex: new RegExp(`^${globToRegexSource(glob)}$`, flags),
    literal: !GLOB_META.test(glob),
  };
}

/** Escape a literal for use inside a RegExp. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyGlob(
  globs: CompiledGlob[],
  relPath: string,
  name: string,
  substringFallback: boolean,
): boolean {
  for (const g of globs) {
    const subject = g.pathScoped ? relPath : name;
    if (g.regex.test(subject)) return true;
    if (substringFallback && g.literal) {
      const re = new RegExp(escapeRegex(g.raw), g.regex.flags);
      if (re.test(subject)) return true;
    }
  }
  return false;
}

/**
 * Should this directory be pruned by an exclude glob?
 * Tests the glob against the basename, the relative path, and the relative path
 * plus a probe segment so directory-scoped patterns ("build", star-slash-build-star,
 * double-star-slash-build-double-star, "a/b") all prune the subtree instead of
 * only matching files.
 */
function dirExcluded(globs: CompiledGlob[], relPath: string, name: string): boolean {
  for (const g of globs) {
    if (!g.pathScoped) {
      if (g.regex.test(name)) return true;
      continue;
    }
    if (g.regex.test(relPath) || g.regex.test(`${relPath}/`) || g.regex.test(`${relPath}/x`)) {
      return true;
    }
  }
  return false;
}

/** Parse `modifiedAfter`: relative ("30m", "6h", "2d", "1w") or anything Date can parse. */
function parseModifiedAfter(value: string): number {
  const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(value.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    return Date.now() - n * ms;
  }
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    throw new Error(
      `list_files: could not parse modifiedAfter=${JSON.stringify(value)}. Use a relative age like "2d"/"6h"/"30m"/"1w" or an ISO date like "2026-01-01".`,
    );
  }
  return parsed;
}

function kindOfDirent(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return "other";
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface WalkOptions {
  globs: CompiledGlob[];
  excludes: CompiledGlob[];
  type: "file" | "dir" | "any";
  maxDepth: number;
  includeIgnored: boolean;
  substringFallback: boolean;
  caseSensitive: boolean;
}

/**
 * Iterative walk of one root. Never descends into symlinked directories (so
 * symlink loops are structurally impossible, matching `find` without -L) and
 * turns per-directory read failures into reported entries rather than throwing.
 */
async function walkRoot(
  rootAbs: string,
  rootDisplay: string,
  opts: WalkOptions,
  stats: WalkStats,
  deadline: number,
  signal?: AbortSignal,
): Promise<Match[]> {
  const matches: Match[] = [];
  const stack: Array<{ abs: string; rel: string; depth: number }> = [{ abs: rootAbs, rel: "", depth: 0 }];

  const emit = (rel: string, name: string, kind: EntryKind, abs: string) => {
    if (opts.type === "file" && kind !== "file" && kind !== "symlink") return;
    if (opts.type === "dir" && kind !== "dir" && kind !== "symlink") return;
    if (opts.globs.length > 0 && !matchesAnyGlob(opts.globs, rel, name, opts.substringFallback)) return;
    if (matches.length >= MAX_MATCHES) {
      stats.hitMatchCap = true;
      return;
    }
    matches.push({
      display: rootDisplay ? `${rootDisplay}/${rel}` : rel,
      absolute: abs,
      kind,
    });
  };

  while (stack.length > 0) {
    if (signal?.aborted) signal.throwIfAborted();
    if (stats.scanned >= MAX_SCAN_ENTRIES) {
      stats.hitScanCap = true;
      break;
    }
    if (Date.now() > deadline) {
      stats.hitTimeCap = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const label = dir.rel === "" ? rootDisplay || "." : rootDisplay ? `${rootDisplay}/${dir.rel}` : dir.rel;
      stats.unreadable.push(`${label} (${code === "EACCES" || code === "EPERM" ? "permission denied" : code ?? "unreadable"})`);
      continue;
    }
    // Deterministic traversal order regardless of filesystem readdir order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // Caps must be enforced INSIDE this loop, not just per directory: a single
      // directory can hold millions of entries, and a per-directory-only check
      // would walk all of them before noticing (found empirically by forcing a
      // low cap against an 800-entry directory, which sailed straight past it).
      if (stats.scanned >= MAX_SCAN_ENTRIES) {
        stats.hitScanCap = true;
        return matches;
      }
      if ((stats.scanned & 0x3ff) === 0) {
        if (signal?.aborted) signal.throwIfAborted();
        if (Date.now() > deadline) {
          stats.hitTimeCap = true;
          return matches;
        }
      }
      stats.scanned++;
      const rel = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
      const abs = join(dir.abs, entry.name);
      const kind = kindOfDirent(entry);

      if (kind === "dir") {
        const ignored = !opts.includeIgnored && DEFAULT_IGNORED_DIRS.includes(entry.name);
        const excluded = dirExcluded(opts.excludes, rel, entry.name);
        if (ignored) {
          stats.prunedIgnored.set(entry.name, (stats.prunedIgnored.get(entry.name) ?? 0) + 1);
          continue;
        }
        if (excluded) {
          stats.prunedExcluded++;
          continue;
        }
        emit(rel, entry.name, kind, abs);
        if (dir.depth + 1 < opts.maxDepth) {
          stack.push({ abs, rel, depth: dir.depth + 1 });
        }
        continue;
      }

      if (opts.excludes.length > 0 && matchesAnyGlob(opts.excludes, rel, entry.name, false)) {
        stats.prunedExcluded++;
        continue;
      }
      emit(rel, entry.name, kind, abs);
    }
  }

  return matches;
}

const Params = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Root dirs (or single files) to list. Default cwd. Each root walked independently, results de-duplicated." }),
  ),
  globs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Name patterns; an entry matching ANY is returned. Case-insensitive on the BASENAME unless the pattern contains "/", then on the path relative to the root: "*Foo*", "*.kt", "**/analytics/*.kt". Omit to list everything.',
    }),
  ),
  excludeGlobs: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Excluded patterns (`find | grep -v`, `-not -path`); a matching DIRECTORY is pruned with its whole subtree, e.g. ["*Test*", "**/androidTest/**"].',
    }),
  ),
  type: Type.Optional(Type.String({ description: '"file" | "dir" | "any" (default). Replaces `find -type f`/`-type d`.' })),
  maxDepth: Type.Optional(Type.Number({ description: "`find -maxdepth`: 1 = direct children only (a plain `ls`). Default unlimited." })),
  modifiedAfter: Type.Optional(
    Type.String({ description: 'Modified after: "30m"/"6h"/"2d"/"1w" or an ISO date (`find -newermt`).' }),
  ),
  sortBy: Type.Optional(Type.String({ description: '"path" (default) | "mtime" (newest first) | "size" (largest first).' })),
  countOnly: Type.Optional(
    Type.Boolean({
      description: "Return only the total + a per-directory breakdown instead of every path (`find | wc -l`). Use for HOW MANY / WHERE questions.",
    }),
  ),
  withMeta: Type.Optional(Type.Boolean({ description: "Prefix each line with aligned size and mtime, like `ls -la` (default: bare paths)." })),
  resolveSymlinks: Type.Optional(Type.Boolean({ description: "Append ` -> target` (resolved) and classify by the target's type. Replaces `readlink -f`." })),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: `Also descend into normally-ignored noise dirs (${DEFAULT_IGNORED_DIRS.join(", ")}). Default false.` }),
  ),
  caseSensitive: Type.Optional(Type.Boolean({ description: "Default false, like `find -iname`." })),
  limit: Type.Optional(
    Type.Number({
      description: `Max paths emitted (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); the TOTAL count is always reported. An explicit limit raises the byte budget ${SOFT_MAX_CHARS}->${MAX_CHARS}.`,
    }),
  ),
});

interface ParamsT {
  paths?: string[];
  globs?: string[];
  excludeGlobs?: string[];
  type?: string;
  maxDepth?: number;
  modifiedAfter?: string;
  sortBy?: string;
  countOnly?: boolean;
  withMeta?: boolean;
  resolveSymlinks?: boolean;
  includeIgnored?: boolean;
  caseSensitive?: boolean;
  limit?: number;
}

/** Accept a bare string where an array is expected (models do this constantly). */
function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_files",
    label: "List Files",
    description:
      "PREFERRED way to list or find files/dirs BY NAME, SIZE, AGE or LOCATION — use instead of `bash find`/`ls`. " +
      "One call replaces `find -iname/-type/-maxdepth/-newermt`, `ls -la`, `ls | grep`, `find | grep -v`, " +
      '`find -not -path "*/build/*"`, multi-pattern `find -o -iname`, `find | wc -l` (countOnly) and `readlink -f`.\n' +
      "Noise dirs are pruned by default; output is capped but the TOTAL match count is always reported, so " +
      "truncation is never silent.\n" +
      'Ex: {"paths":["features/subscriptions"],"globs":["*Analytics*.kt"],"excludeGlobs":["**/test/**"],"type":"file"} ' +
      "-> the file list, no shell quoting, no `grep -v`, no `2>/dev/null`. countOnly:true answers HOW MANY / WHERE in " +
      "a few hundred bytes instead of hundreds of paths. Use bash only for listing work this cannot express " +
      "(`-exec`, `du`, `stat` formats, `git ls-files`).",
    promptSnippet: "List/find files and dirs by name glob, type, depth, size or mtime (replaces find/ls)",
    promptGuidelines: [
      "Use list_files instead of `bash find`/`bash ls` for any listing: pass every name pattern in one `globs` array (not `-iname A -o -iname B`) and use `excludeGlobs` instead of `| grep -v` / `-not -path`. Globs match the basename case-insensitively unless they contain `/`, then the path relative to the root (`*Foo*` substring, `**/test/**` path shape).",
      "maxDepth:1 for a plain directory listing, withMeta:true for sizes/timestamps (`ls -la`), sortBy:'size'/'mtime' + limit for \"largest/newest N\", resolveSymlinks:true instead of `readlink`, and countOnly:true whenever you only need how many match and roughly where (never list every path just to count them).",
      "list_files already prunes .git, build, node_modules, .gradle, dist, .idea, .venv — do not exclude those yourself; pass includeIgnored:true when you need to look inside them (e.g. generated build output).",
      "Never call list_files with no globs and no maxDepth on a large repo root — that is an unfiltered recursive walk whose output gets clipped; pass globs, maxDepth:1 or countOnly:true. If a result reports truncation by `limit`, narrow it (tighter glob, a subdirectory in `paths`, maxDepth) rather than re-running with a huge limit.",
      "Prefer grep for file CONTENTS and code_search for symbol declarations; list_files is for locating files by name/metadata. A `[substring fallback]` tag means the literal pattern matched nothing exactly and was loosened — confirm the hits are the intended ones.",
    ],
    parameters: Params,
    prepareArguments(args) {
      const input = (args ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = { ...input };
      // Models pass single strings, and sometimes `path`/`glob`/`pattern` singulars.
      out.paths = toStringArray(input.paths ?? input.path ?? input.dir ?? input.directory);
      out.globs = toStringArray(input.globs ?? input.glob ?? input.pattern ?? input.patterns);
      out.excludeGlobs = toStringArray(input.excludeGlobs ?? input.exclude ?? input.excludes);
      delete out.path;
      delete out.dir;
      delete out.directory;
      delete out.glob;
      delete out.pattern;
      delete out.patterns;
      delete out.exclude;
      delete out.excludes;
      for (const key of ["paths", "globs", "excludeGlobs"]) {
        if (out[key] === undefined) delete out[key];
      }
      return out;
    },
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as ParamsT;
      const cwd = ctx?.cwd ?? process.cwd();
      const started = Date.now();
      const deadline = started + MAX_SCAN_MS;

      const type = ((params.type ?? "any") as string).toLowerCase();
      if (type !== "file" && type !== "dir" && type !== "any") {
        throw new Error(`list_files: type must be "file", "dir" or "any" (got ${JSON.stringify(params.type)})`);
      }
      const sortBy = ((params.sortBy ?? "path") as string).toLowerCase();
      if (sortBy !== "path" && sortBy !== "mtime" && sortBy !== "size") {
        throw new Error(`list_files: sortBy must be "path", "mtime" or "size" (got ${JSON.stringify(params.sortBy)})`);
      }
      const limit = Math.max(1, Math.min(Math.floor(params.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
      const maxDepth =
        params.maxDepth !== undefined && params.maxDepth > 0 ? Math.floor(params.maxDepth) : Number.MAX_SAFE_INTEGER;
      const caseSensitive = params.caseSensitive === true;
      const withMeta = params.withMeta === true;
      const countOnly = params.countOnly === true;
      const resolveLinks = params.resolveSymlinks === true;
      const includeIgnored = params.includeIgnored === true;
      const modifiedAfterMs = params.modifiedAfter ? parseModifiedAfter(params.modifiedAfter) : undefined;

      const rawGlobs = (params.globs ?? []).filter((g) => g.trim() !== "");
      const rawExcludes = (params.excludeGlobs ?? []).filter((g) => g.trim() !== "");
      const globs = rawGlobs.map((g) => compileGlob(g, caseSensitive));
      const excludes = rawExcludes.map((g) => compileGlob(g, caseSensitive));

      const rawPaths = params.paths && params.paths.length > 0 ? params.paths : ["."];
      const rootErrors: string[] = [];
      const roots: Array<{ abs: string; display: string; isFile: boolean }> = [];
      const seenRoots = new Set<string>();
      for (const raw of rawPaths) {
        const abs = resolveInputPath(raw, cwd);
        if (seenRoots.has(abs)) continue;
        seenRoots.add(abs);
        try {
          const info = await stat(abs);
          roots.push({ abs, display: displayPrefix(raw), isFile: !info.isDirectory() });
        } catch (error) {
          const code = (error as { code?: string }).code;
          rootErrors.push(
            `!!!!! ${raw} - ERROR: ${code === "ENOENT" ? "path not found" : code === "EACCES" || code === "EPERM" ? "permission denied" : (error as Error).message} !!!!!`,
          );
        }
      }

      if (roots.length === 0) {
        const text = [
          `list_files: no readable roots (${rawPaths.length} requested).`,
          ...rootErrors,
        ].join("\n");
        return { content: [{ type: "text", text }], details: { matches: 0, shown: 0, errors: rootErrors.length } };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Listing ${roots.map((r) => r.display || ".").join(", ")}${rawGlobs.length ? ` matching ${rawGlobs.join(", ")}` : ""}...`,
          },
        ],
        details: {},
      });

      const stats: WalkStats = {
        scanned: 0,
        prunedIgnored: new Map(),
        prunedExcluded: 0,
        unreadable: [],
        hitScanCap: false,
        hitTimeCap: false,
        hitMatchCap: false,
      };

      const walkOpts: WalkOptions = {
        globs,
        excludes,
        type: type as "file" | "dir" | "any",
        maxDepth,
        includeIgnored,
        substringFallback: false,
        caseSensitive,
      };

      const collect = async (opts: WalkOptions): Promise<Match[]> => {
        const all: Match[] = [];
        for (const root of roots) {
          if (root.isFile) {
            // A file root behaves like `ls <file>`: it is itself the candidate.
            const name = basename(root.abs);
            const passesType = opts.type !== "dir";
            const passesGlob =
              opts.globs.length === 0 || matchesAnyGlob(opts.globs, name, name, opts.substringFallback);
            if (passesType && passesGlob) {
              all.push({ display: root.display || name, absolute: root.abs, kind: "file" });
            }
            continue;
          }
          all.push(...(await walkRoot(root.abs, root.display, opts, stats, deadline, signal)));
        }
        return all;
      };

      let matches = await collect(walkOpts);
      // Degraded path, explicitly tagged in the output: a wildcard-free pattern
      // that matched no exact basename is retried as a substring match.
      let substringFallback = false;
      if (matches.length === 0 && globs.length > 0 && globs.every((g) => g.literal)) {
        stats.scanned = 0;
        stats.prunedIgnored = new Map();
        stats.prunedExcluded = 0;
        stats.unreadable = [];
        matches = await collect({ ...walkOpts, substringFallback: true });
        substringFallback = matches.length > 0;
      }

      // De-duplicate by absolute path (overlapping roots) while keeping order.
      const seen = new Set<string>();
      matches = matches.filter((m) => (seen.has(m.absolute) ? false : (seen.add(m.absolute), true)));

      // Symlinks must be stat'ed whenever a type filter is active, otherwise a
      // symlink-to-dir would be reported as a "file" (and vice versa).
      const needsStat =
        withMeta || modifiedAfterMs !== undefined || sortBy !== "path" || resolveLinks || type !== "any";
      if (needsStat) {
        const CONCURRENCY = 32;
        for (let i = 0; i < matches.length; i += CONCURRENCY) {
          if (signal?.aborted) signal.throwIfAborted();
          await Promise.all(
            matches.slice(i, i + CONCURRENCY).map(async (m) => {
              try {
                const info = await lstat(m.absolute);
                m.size = info.size;
                m.mtimeMs = info.mtimeMs;
                if (m.kind === "symlink") {
                  try {
                    const target = await stat(m.absolute);
                    m.kind = target.isDirectory() ? "dir" : "file";
                    if (resolveLinks) {
                      m.linkTarget = await realpath(m.absolute);
                      m.size = target.size;
                      m.mtimeMs = target.mtimeMs;
                    }
                  } catch (error) {
                    // Broken link or loop: keep kind "symlink" so a type filter
                    // drops it (like `find -type f`), and say so when resolving.
                    const code = (error as { code?: string }).code;
                    if (resolveLinks) m.linkTarget = code === "ELOOP" ? "(symlink loop)" : "(broken link)";
                  }
                }
              } catch {
                /* entry vanished mid-walk; leave meta undefined */
              }
            }),
          );
        }
      }

      // Type filter re-applied after symlink resolution so `type` means the
      // target's type when resolveSymlinks is on.
      if (needsStat && type !== "any") {
        matches = matches.filter((m) => (type === "file" ? m.kind === "file" : m.kind === "dir"));
      }
      let mtimeFiltered = 0;
      if (modifiedAfterMs !== undefined) {
        const before = matches.length;
        matches = matches.filter((m) => m.mtimeMs !== undefined && m.mtimeMs >= modifiedAfterMs);
        mtimeFiltered = before - matches.length;
      }

      if (sortBy === "path") {
        matches.sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
      } else if (sortBy === "mtime") {
        matches.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
      } else {
        matches.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      }

      const total = matches.length;
      const shownMatches = countOnly ? [] : matches.slice(0, limit);

      // ---- render ----
      const filterParts: string[] = [];
      if (rawGlobs.length) filterParts.push(`globs=[${rawGlobs.join(", ")}]`);
      if (rawExcludes.length) filterParts.push(`exclude=[${rawExcludes.join(", ")}]`);
      if (type !== "any") filterParts.push(`type=${type}`);
      if (maxDepth !== Number.MAX_SAFE_INTEGER) filterParts.push(`maxDepth=${maxDepth}`);
      if (params.modifiedAfter) filterParts.push(`modifiedAfter=${params.modifiedAfter}`);
      if (sortBy !== "path") filterParts.push(`sortBy=${sortBy}`);
      if (countOnly) filterParts.push("countOnly");
      if (includeIgnored) filterParts.push("includeIgnored");
      const where = roots.map((r) => r.display || ".").join(", ");
      const filters = filterParts.length ? ` (${filterParts.join(" ")})` : "";

      const notes: string[] = [];
      if (substringFallback) {
        notes.push(
          `[substring fallback] no entry was named exactly ${rawGlobs.map((g) => `"${g}"`).join(" / ")}; matched as a substring instead — verify these are the intended files.`,
        );
      }
      const prunedTotal = [...stats.prunedIgnored.values()].reduce((a, b) => a + b, 0);
      if (prunedTotal > 0) {
        const names = [...stats.prunedIgnored.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, count]) => `${name}×${count}`)
          .join(", ");
        notes.push(`pruned ${prunedTotal} default-ignored dir(s) (${names}); pass includeIgnored:true to include them.`);
      }
      if (mtimeFiltered > 0) notes.push(`${mtimeFiltered} match(es) dropped by modifiedAfter.`);
      if (stats.unreadable.length > 0) {
        notes.push(
          `${stats.unreadable.length} dir(s) not readable: ${stats.unreadable.slice(0, 3).join(", ")}${stats.unreadable.length > 3 ? ", ..." : ""} — results below may be incomplete.`,
        );
      }
      if (stats.hitScanCap) {
        notes.push(
          `SCAN CAP: stopped after ${MAX_SCAN_ENTRIES} entries — results are PARTIAL. Narrow 'paths' or set maxDepth.`,
        );
      }
      if (stats.hitTimeCap) {
        notes.push(
          `TIME CAP: stopped after ${MAX_SCAN_MS / 1000}s of walking — results are PARTIAL. Narrow 'paths' or set maxDepth.`,
        );
      }
      if (stats.hitMatchCap) {
        notes.push(
          `MATCH CAP: more than ${MAX_MATCHES} matches; extras were dropped BEFORE sorting, so this list is not the true top ${limit}. Add globs/maxDepth to narrow.`,
        );
      }
      // An unfiltered recursive listing is almost never the useful answer.
      if (globs.length === 0 && maxDepth === Number.MAX_SAFE_INTEGER && !countOnly && total > shownMatches.length) {
        notes.push(
          "unfiltered recursive listing: pass globs, maxDepth (1 = like `ls`) or countOnly:true to get an answer that fits.",
        );
      }

      let body: string;
      if (total === 0) {
        const hints = [
          rawGlobs.length
            ? 'globs match the BASENAME (use "*Foo*" for substring) unless they contain "/" (then the path relative to the root)'
            : "the directory may be empty",
          "case folding is Unicode-simple, exactly like `find -iname`: accented letters do NOT match their ASCII forms (\"needle\" will not match \"Nëëdle\")",
          `default-ignored dirs were skipped (${DEFAULT_IGNORED_DIRS.join(", ")}) — pass includeIgnored:true to search them`,
          "for content matches use grep, for symbol declarations use code_search",
        ];
        body = `no matches. Hints: ${hints.join("; ")}.`;
      } else if (countOnly) {
        // Compact "how many and where" answer: counts per immediate parent dir.
        const groups = new Map<string, number>();
        for (const m of matches) {
          const slash = m.display.lastIndexOf("/");
          const parent = slash === -1 ? "." : m.display.slice(0, slash);
          groups.set(parent, (groups.get(parent) ?? 0) + 1);
        }
        const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        const width = String(sorted[0][1]).length;
        const lines = sorted
          .slice(0, MAX_COUNT_GROUPS)
          .map(([parent, count]) => `${String(count).padStart(width, " ")}  ${parent}/`);
        if (sorted.length > MAX_COUNT_GROUPS) {
          lines.push(`... ${sorted.length - MAX_COUNT_GROUPS} more director(ies) omitted`);
        }
        body = `${total} match(es) in ${sorted.length} director(ies):\n${lines.join("\n")}\n(countOnly: pass countOnly:false to list the paths themselves)`;
      } else {
        const lines: string[] = [];
        if (withMeta) {
          const sizeCol = Math.max(
            ...shownMatches.map((m) => (m.size !== undefined ? formatSize(m.size).length : 1)),
          );
          for (const m of shownMatches) {
            const size = m.size !== undefined ? formatSize(m.size).padStart(sizeCol, " ") : "?".padStart(sizeCol, " ");
            const when = m.mtimeMs !== undefined ? formatMtime(m.mtimeMs) : "?               ";
            lines.push(`${size}  ${when}  ${renderPath(m)}`);
          }
        } else {
          for (const m of shownMatches) lines.push(renderPath(m));
        }
        body = lines.join("\n");
      }

      const headerBits = [
        stats.hitMatchCap ? `>=${total} match(es) (match cap hit, true total is higher)` : `${total} match(es)`,
      ];
      if (!countOnly && total > shownMatches.length) headerBits.push(`showing first ${shownMatches.length}`);
      headerBits.push(`${stats.scanned} entries scanned in ${Date.now() - started}ms`);
      let text = `list_files: ${headerBits.join(", ")} under ${where}${filters}`;
      if (notes.length) text += `\n${notes.map((n) => `  note: ${n}`).join("\n")}`;
      if (rootErrors.length) text += `\n${rootErrors.join("\n")}`;
      text += `\n\n${body}`;
      if (!countOnly && total > shownMatches.length) {
        text += `\n... ${total - shownMatches.length} more match(es) not shown (limit=${limit}). Narrow with a tighter glob, a subdirectory in 'paths', maxDepth, or raise 'limit' (max ${MAX_LIMIT}).`;
      }
      // Byte cap: whole lines only, so every emitted path stays citable.
      const charBudget = params.limit !== undefined ? MAX_CHARS : SOFT_MAX_CHARS;
      let clippedLines = 0;
      if (text.length > charBudget) {
        const lines = text.split("\n");
        const kept: string[] = [];
        let used = 0;
        for (const line of lines) {
          if (used + line.length + 1 > charBudget) break;
          kept.push(line);
          used += line.length + 1;
        }
        clippedLines = lines.length - kept.length;
        text =
          `${kept.join("\n")}\n... [output clipped at ${charBudget} chars: ${clippedLines} more line(s) omitted. ` +
          `Narrow with globs/maxDepth/paths, use countOnly:true, or pass an explicit 'limit' to raise the budget to ${MAX_CHARS} chars.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          total,
          shown: shownMatches.length,
          countOnly,
          scanned: stats.scanned,
          prunedIgnored: prunedTotal,
          prunedExcluded: stats.prunedExcluded,
          unreadableDirs: stats.unreadable.length,
          substringFallback,
          truncatedByLimit: !countOnly && total > shownMatches.length,
          hitScanCap: stats.hitScanCap,
          hitTimeCap: stats.hitTimeCap,
          hitMatchCap: stats.hitMatchCap,
          clippedLines,
          rootErrors: rootErrors.length,
          elapsedMs: Date.now() - started,
          paths: shownMatches.map((m) => m.display),
        },
      };
    },
    renderCall(args, theme) {
      const a = (args ?? {}) as ParamsT;
      const globs = toStringArray(a.globs) ?? [];
      const paths = toStringArray(a.paths) ?? [];
      const what = globs.length ? globs.join(",") : "*";
      const where = paths.length ? paths.join(",") : ".";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("list_files"))} ${theme.fg("accent", what)} ${theme.fg("muted", `in ${where}`)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const first = result.content[0];
      const content = (first && "text" in first ? first.text : "") ?? "";
      const lines = content.split("\n");
      const max = options.expanded ? lines.length : 15;
      const shown = lines.slice(0, max);
      if (lines.length > max) shown.push(theme.fg("muted", `... ${lines.length - max} more lines`));
      return new Text(shown.join("\n"), 0, 0);
    },
  });
}

/** One emitted path: dirs get a trailing slash, symlinks their resolved target. */
function renderPath(m: Match): string {
  const suffix = m.kind === "dir" ? "/" : "";
  return m.linkTarget ? `${m.display}${suffix} -> ${m.linkTarget}` : `${m.display}${suffix}`;
}
