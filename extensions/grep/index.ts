/**
 * Grep Extension for Pi
 *
 * Wraps the ripgrep command to provide powerful text search capabilities
 * across codebases with fallback to grep if ripgrep is not installed.
 *
 * Also collapses several common bash escape hatches into single tool calls:
 *   - `find <dir> -iname "*a*" -o -iname "*b*"`        -> filenamePattern (array)
 *   - `grep -rl pat dir --include=*.ext | grep pat2`   -> filesOnly + include + andPattern
 *   - `find <dir> -iname "*X*" | xargs grep -l pat`    -> filenamePattern + pattern (+filesOnly)
 *   - `grep -v pat file`                               -> invertMatch
 *   - `grep pat dir | grep -v build/`                   -> notPattern
 *   - `grep -c pat file` / `grep pat dir | wc -l`       -> outputMode: "count"
 *   - `grep -q pat file` (just "does it exist?")        -> outputMode: "exists"
 *   - `grep -o 'pat' dir | sort | uniq -c | sort -rn`   -> onlyMatching + aggregateMatches
 *   - `grep -w pat dir`                                 -> wordBoundary
 *   - several of the above chained with `echo "---"`  -> queries[] batch mode
 *
 * Install:
 *   Symlinked into ~/.pi/agent/extensions/grep
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";

/** Default cap on returned match lines; overridable per call via `limit`. */
const DEFAULT_LIMIT = 500;
/** Hard cap on characters returned, mirroring the built-in read tool. */
const MAX_CHARS = 50_000;
/** Hard cap on characters returned for the whole batch (queries[] mode). */
const MAX_BATCH_CHARS = 150_000;
/** Buffer ceiling for the child process; we cut with `head` long before this. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/**
 * Default per-line character cap. A single minified/bundled/base64 line can be megabytes;
 * without this one such line can blow up the whole context. 0 (or negative) disables it.
 */
const DEFAULT_MAX_LINE_LENGTH = 1000;
/**
 * Safety cap on how many aggregated rows (per-file counts / distinct values) are carried out of the
 * shell. Totals are computed BEFORE this cap inside awk and emitted on a sentinel first line, so a
 * capped listing never silently understates the total.
 */
const AGG_SAFETY_ROWS = 50_000;
/** Sentinel first line of every shell-side aggregation stage: "##TOTALS##\t<total>\t<groups>". */
const TOTALS_SENTINEL = "##TOTALS##";
/**
 * Field separator used between path and match text when counting a FILTERED stream, so per-file
 * grouping stays correct for paths that themselves contain ":" (ripgrep only; POSIX grep has no
 * equivalent option, so the fallback splits on ":" and says so in a note).
 */
const FIELD_SEP = "\u0001";

type OutputMode = "content" | "filesOnly" | "count" | "exists";
/** What the raw stdout of the built pipeline looks like, and therefore how to post-process it. */
type PostShape =
  | "content" // path:line:text (or bare text) match lines
  | "fileList" // one path per line
  | "countPerFile" // per-file counts, either "n<TAB>path" (awk) or "path:n" (native -c)
  | "countTotalOnly" // a single number from `wc -l`
  | "aggregate" // `sort | uniq -c | sort -rn` output: "   n value"
  | "exists"; // at most one line

/** Wrap a value in single quotes so the shell treats it as a literal. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Accept a single glob or an array of globs; always return an array (possibly empty). */
function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * find's -iname only matches the basename, never the full path, so a glob containing a slash
 * (e.g. a directory-scoped exclude like build-or-dot-git-anywhere) silently never matches anything
 * with -iname. Use -ipath for any glob containing a slash, -iname otherwise, so both extension-style
 * globs and directory-scoped globs behave like ripgrep's --iglob (which matches full relative paths).
 */
function findNameTest(pattern: string): string {
  const flag = pattern.includes("/") ? "-ipath" : "-iname";
  return `${flag} ${shellQuote(pattern)}`;
}

/**
 * Shared shape for a single search request, used both at the top level and inside `queries[]`.
 *
 * `doc: true` attaches the LLM-facing descriptions (top-level params); `doc: false` omits them
 * for the `queries[]` item schema, where the identically-named top-level params already document
 * every field. Duplicating them measured 1446 of grep's 2747 schema tokens for zero new information.
 */
function queryFields(doc: boolean) {
  const d = (text: string, rest: Record<string, unknown> = {}) => (doc ? { description: text, ...rest } : rest);
  return {
    pattern: Type.Optional(
      Type.String(d("Regex/text to search INSIDE file contents. Optional if filenamePattern is set (then only names are listed).")),
    ),
    file: Type.Optional(Type.String(d("Single file to search."))),
    directory: Type.Optional(Type.String(d("Directory to search (default cwd)."))),
    filenamePattern: Type.Optional(
      Type.Union(
        [Type.String(), Type.Array(Type.String())],
        d('Glob(s) on the file NAME/PATH (`find -iname`), e.g. "*Jenkinsfile*". With `pattern`: restrict the search to those files (`find | xargs grep`). Alone: list matching paths.'),
      ),
    ),
    include: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], d('Glob(s) limiting the search to matching files (rg -g), e.g. "*.json".')),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], d('Glob(s) of files to skip (rg -g "!glob"), e.g. "*.min.js".')),
    ),
    andPattern: Type.Optional(Type.String(d("Extra pattern each result line (path in filesOnly mode) must ALSO match — `| grep`."))),
    notPattern: Type.Optional(
      Type.String(d('Drop result lines/paths containing this — `| grep -v` (e.g. "/build/"), applied after andPattern. Filters results; invertMatch inverts the match itself.')),
    ),
    invertMatch: Type.Optional(
      Type.Boolean(d("Return lines NOT matching `pattern` (grep -v). Line-level. Needs `pattern`; not with onlyMatching.", { default: false })),
    ),
    withoutMatch: Type.Optional(
      Type.Boolean(
        d("FILE-level inverse (grep -L): files where `pattern` NEVER appears. Requires outputMode 'filesOnly' or 'count'.", { default: false }),
      ),
    ),
    outputMode: Type.Optional(
      Type.Union(
        [Type.Literal("content"), Type.Literal("filesOnly"), Type.Literal("count"), Type.Literal("exists")],
        d("content (default) = matching lines; filesOnly = paths (-l); count = per-file counts + exact total (-c, `| wc -l`); exists = yes/no + first hit (-q)."),
      ),
    ),
    onlyMatching: Type.Optional(
      Type.Boolean(d("Return only the matched substring, not the line (grep -o) — to extract versions/ids/urls.", { default: false })),
    ),
    captureGroup: Type.Optional(
      Type.Number(
        d("Return only this group (1-based, 0 = whole match). Implies onlyMatching. Needs ripgrep; ignored (noted in output) in the grep fallback."),
      ),
    ),
    aggregateMatches: Type.Optional(
      Type.Boolean(
        d("Unique matched values + counts, most frequent first (`-o | sort | uniq -c`). Implies onlyMatching; output bounded by distinct values, not match count.", { default: false }),
      ),
    ),
    wordBoundary: Type.Optional(Type.Boolean(d("Whole words only (grep -w): 'id' misses 'uuid'.", { default: false }))),
    maxLineLength: Type.Optional(
      Type.Number(d(`Clip each returned line to N chars with a marker (default ${DEFAULT_MAX_LINE_LENGTH}, 0 = off).`)),
    ),
    regex: Type.Optional(Type.Boolean(d("Regex matching (default true; false = literal text).", { default: true }))),
    caseSensitive: Type.Optional(Type.Boolean(d("Default true.", { default: true }))),
    lineNumbers: Type.Optional(Type.Boolean(d("Default true.", { default: true }))),
    context: Type.Optional(Type.Number(d("Context lines before/after each match (grep -C).", { default: 0 }))),
    limit: Type.Optional(Type.Number(d(`Max output lines for this query (default ${DEFAULT_LIMIT}).`, { default: DEFAULT_LIMIT }))),
  };
}

const QueryFields = queryFields(true);

const SingleQuery = Type.Object(QueryFields);
type SingleQueryT = Static<typeof SingleQuery>;

const QueryWithLabel = Type.Object({
  ...queryFields(false),
  label: Type.Optional(Type.String({ description: "Short label for this query's output header." })),
});
type QueryWithLabelT = Static<typeof QueryWithLabel>;

const Params = Type.Object({
  ...QueryFields,
  queries: Type.Optional(
    Type.Array(QueryWithLabel, {
      description:
        "Run several related searches in ONE call instead of chaining shell commands. Each entry takes the same " +
        "fields as the top-level params above and may override any of them (e.g. one entry in count mode, another " +
        "in filesOnly mode). Results come back in labeled sections. When `queries` is set the top-level " +
        "pattern/directory/etc. are ignored.",
    }),
  ),
});
type ParamsT = Static<typeof Params>;

interface BuiltCommand {
  /** Full shell pipeline, minus the trailing per-mode `head` cap. */
  command: string;
  mode: OutputMode;
  post: PostShape;
  /** What the numbers in count mode mean. */
  countKind: "lines" | "occurrences" | "files";
  /** Human label for the single-number count mode (`countTotalOnly`). */
  countLabel?: string;
  /** Which per-file count format the pipeline emits, so parsing never has to guess. */
  countFormat: "native" | "awk" | "none";
  /** Semantics/degradation notes surfaced in the output so the caller can calibrate trust. */
  notes: string[];
}

class BashGrepExtension {
  constructor(private pi: ExtensionAPI) {}

  async init() {
    this.pi.registerTool({
      name: "grep",
      label: "Grep",
      description:
        "Search file contents and file names with ripgrep (POSIX grep fallback). Use instead of bash " +
        "grep/rg/find/awk — every flag is a param: invertMatch=`-v`, andPattern/notPattern=`| grep`/`| grep -v`, " +
        "outputMode filesOnly|count|exists=`-l`/`-c`/`-q`, withoutMatch=`-L`, onlyMatching+captureGroup=`-o`, " +
        "aggregateMatches=`-o | sort | uniq -c | sort -rn`, wordBoundary=`-w`, filenamePattern=`find -iname`, " +
        "queries[]=several searches in one call.\n" +
        "Ex A: {pattern: 'implementation \"([^\"]+)\"', include: \"*.gradle*\", captureGroup: 1, " +
        "aggregateMatches: true} -> every unique dependency coordinate with its usage count, one call.\n" +
        "Ex B (a count AND a sample, still one call): {queries: [{pattern: \"^\\\\s*(//|$)\", file: \"Foo.kt\", " +
        "invertMatch: true, outputMode: \"count\"}, {pattern: \"^\\\\s*(//|$)\", file: \"Foo.kt\", " +
        "invertMatch: true, limit: 5}]} -> replaces `grep -v ... | wc -l` plus `grep -v ... | head -5`.",
      promptSnippet:
        "Search text/regex patterns and file names: invert match, counts, existence checks, match extraction, batch queries",
      promptGuidelines: [
        "Use grep, not bash grep/rg/find/awk, for every content or filename search — every common flag and pipeline " +
          "shape is a parameter, so reaching for a bash search pipeline almost always means you missed one. " +
          "`regex: false` for literal text. Pick `outputMode` from the question: 'filesOnly' (which files), 'count' " +
          "(how many — exact total), 'exists' (yes/no); never pull back content and count it yourself.",
        "Need a number AND example lines? ONE call: `queries: [{...outputMode:'count'}, {...limit:5}]`, not `| wc -l` " +
          "plus `| head`. Content queries keep real line numbers, so the sample is citable.",
        "\"Which/how many files do NOT contain X\" = `withoutMatch: true` with outputMode 'filesOnly'/'count' " +
          "(`grep -L`). Never list the files that DO contain X and set-diff in bash (`comm`, `wc -l`).",
        "Trust a grep result as complete — do NOT re-run the search through bash to check it. Only a " +
          "surprisingly empty result earns one follow-up, and that follow-up is another grep call (ripgrep skips " +
          ".gitignore'd and binary files when recursing: re-query with `file` set to the exact path).",
        "Read the output prefixes: `[engine: grep-fallback]` = POSIX grep ran (different ignore handling, " +
          "`captureGroup` not applied); `[note: ...]` = an option was reinterpreted; `[line truncated: ...]` = one " +
          "long line clipped, not a partial match. On truncation narrow the pattern or switch to count/filesOnly — " +
          "count/aggregate totals stay exact regardless.",
      ],
      parameters: Params,
      execute: async (_toolCallId, rawParams, _signal, onUpdate, ctx) => {
        const params = rawParams as ParamsT;

        const ripgrepAvailable = await this.isRipgrepAvailable();
        let tool: "ripgrep" | "grep" = "ripgrep";
        if (!ripgrepAvailable) {
          const grepAvailable = await this.isGrepAvailable();
          if (!grepAvailable) {
            return {
              content: [{ type: "text", text: "Error: Neither ripgrep nor grep command available on this system" }],
              details: { error: "ripgrep and grep not available" },
            };
          }
          tool = "grep";
        }
        onUpdate?.({
          content: [{ type: "text", text: `Using ${tool === "ripgrep" ? "ripgrep (rg)" : "grep"} as the search tool` }],
          details: { tool },
        });

        const queries: QueryWithLabelT[] =
          params.queries && params.queries.length > 0
            ? params.queries
            : [{ ...params } as QueryWithLabelT];

        // Validate up front so a bad query in a batch fails fast with a clear message.
        for (const [i, q] of queries.entries()) {
          const problem = this.validateQuery(q);
          if (problem) {
            return {
              content: [{ type: "text", text: `Error: query ${i + 1}: ${problem}` }],
              details: { error: problem, queryIndex: i },
            };
          }
        }

        const isBatch = !!params.queries && params.queries.length > 0;
        const sections: string[] = [];
        const commandsRun: string[] = [];
        const modesRun: string[] = [];
        const shapesRun: string[] = [];

        for (const [i, q] of queries.entries()) {
          const built = this.buildCommand(q, ripgrepAvailable);
          commandsRun.push(built.command);
          modesRun.push(built.mode);
          shapesRun.push(built.post);
          const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : DEFAULT_LIMIT;
          const finalCommand = `${built.command} | head -n ${this.rawLineBudget(built, limit)}`;

          let resultText: string;
          try {
            const raw = await this.executeCommand(finalCommand, ctx);
            // stderr must never be treated as data: a missing directory used to surface as
            // "count: 0" / "exists: true (first hit: rg: IO error ...)" — silently wrong answers.
            const stderr = raw.stderr.trim();
            const hasOut = raw.stdout.trim().length > 0;
            if (!hasOut && (stderr || raw.hardError)) {
              resultText = `Error: search command failed: ${stderr || raw.hardError}`;
            } else {
              resultText = this.formatResult(raw.stdout, built, q, limit);
              if (stderr) {
                // A zero result plus a non-empty stderr is a failure, not a finding: count/exists
                // pipelines legitimately print "0"/nothing to stdout, so without this check a bad
                // path would be reported as a confident "count: 0".
                const zeroResult = /^(count: 0 |No matches found|exists: false)/.test(resultText);
                resultText = zeroResult
                  ? `Error: search command failed (no results, and the search reported): ${stderr}`
                  : `[warning: the search also reported errors, results may be partial: ${stderr.slice(0, 300)}]\n` +
                    resultText;
              }
            }
          } catch (error) {
            resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }

          // Degraded/uncertain code paths are tagged in the output itself, not just documented,
          // so the caller can calibrate trust per result (grep fallback, ignored captureGroup, ...).
          const prefix: string[] = [];
          if (!ripgrepAvailable) prefix.push("[engine: grep-fallback]");
          for (const n of built.notes) prefix.push(`[note: ${n}]`);
          if (prefix.length > 0 && !resultText.startsWith("Error:")) {
            resultText = `${prefix.join(" ")}\n${resultText}`;
          }

          if (isBatch) {
            const label = q.label ? `: ${q.label}` : "";
            sections.push(`===== query ${i + 1}${label} (${this.summarizeQuery(q)}) =====\n${resultText}`);
          } else {
            sections.push(resultText);
          }
        }

        let combined = sections.join("\n\n");
        if (isBatch && combined.length > MAX_BATCH_CHARS) {
          combined = combined.slice(0, MAX_BATCH_CHARS) +
            `\n... [batch output truncated at ${MAX_BATCH_CHARS} chars total. Narrow individual queries or run fewer at once.]`;
        }

        return {
          content: [{ type: "text", text: combined }],
          details: {
            commands: commandsRun,
            tool,
            engine: ripgrepAvailable ? "ripgrep" : "grep-fallback",
            modes: modesRun,
            resultShapes: shapesRun,
            batch: isBatch,
            queryCount: queries.length,
          },
        };
      },
      renderCall: (args, theme) => {
        const a = args as ParamsT;
        let text = theme.fg("toolTitle", theme.bold("grep "));
        if (a.queries && a.queries.length > 0) {
          text += theme.fg("accent", `${a.queries.length} queries`);
        } else {
          const mode = this.resolveMode(a);
          const flags: string[] = [];
          if (mode !== "content") flags.push(mode);
          if (a.invertMatch) flags.push("-v");
          if (a.withoutMatch) flags.push("-L");
          if (a.aggregateMatches) flags.push("-o uniq");
          else if (a.onlyMatching || a.captureGroup !== undefined) flags.push("-o");
          if (a.wordBoundary) flags.push("-w");
          if (a.notPattern) flags.push(`not:${a.notPattern}`);
          const flagText = flags.length > 0 ? `[${flags.join(" ")}] ` : "";
          text += theme.fg("accent", `${flagText}${String(a.pattern ?? a.filenamePattern ?? "")}`);
        }
        return new Text(text, 0, 0);
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

        const first = result.content[0];
        const content = (first && "text" in first ? first.text : undefined) ?? "";
        if (content.startsWith("Error:")) {
          return new Text(theme.fg("error", content), 0, 0);
        }

        const lines = content.split("\n");
        if (lines.length > 15 && !expanded) {
          const truncated = lines.slice(0, 15).join("\n") + `\n... and ${lines.length - 15} more lines`;
          return new Text(truncated, 0, 0);
        }

        return new Text(content, 0, 0);
      },
    });
  }

  /**
   * outputMode wins over the legacy `filesOnly` boolean. `filesOnly` is deliberately NOT in the
   * schema any more (it taught the model nothing and cost schema tokens twice, top level +
   * queries[]), but callers that still send it keep working.
   */
  private resolveMode(q: SingleQueryT): OutputMode {
    if (q.outputMode) return q.outputMode;
    return (q as { filesOnly?: boolean }).filesOnly ? "filesOnly" : "content";
  }

  /** True when the caller wants matched substrings rather than whole lines. */
  private wantsOnlyMatching(q: SingleQueryT): boolean {
    return !!q.onlyMatching || !!q.aggregateMatches || q.captureGroup !== undefined;
  }

  /**
   * Reject impossible flag combinations up front with an explicit message. Silent
   * misbehaviour is the real risk here: `rg -o -v pat` does NOT error, it quietly prints
   * whole non-matching lines, which looks like a successful extraction and isn't.
   */
  private validateQuery(q: SingleQueryT): string | null {
    if (!q.pattern && !q.filenamePattern) return "needs at least one of 'pattern' or 'filenamePattern'.";
    const onlyMatching = this.wantsOnlyMatching(q);
    if (!q.pattern) {
      if (q.invertMatch) return "'invertMatch' needs a 'pattern' to invert.";
      if (onlyMatching) return "'onlyMatching'/'captureGroup'/'aggregateMatches' need a content 'pattern'.";
      if (q.wordBoundary) return "'wordBoundary' needs a content 'pattern'.";
    }
    if (onlyMatching && q.invertMatch) {
      return "'onlyMatching'/'captureGroup'/'aggregateMatches' cannot be combined with 'invertMatch' — a non-matching line has no matched substring to extract. Drop one of them.";
    }
    if (onlyMatching && this.resolveMode(q) === "filesOnly") {
      return "'onlyMatching' cannot be combined with outputMode 'filesOnly' — pick one: matched substrings or file paths.";
    }
    if (q.captureGroup !== undefined && (!Number.isInteger(q.captureGroup) || q.captureGroup < 0)) {
      return "'captureGroup' must be a non-negative integer (0 = whole match, 1 = first group).";
    }
    if (q.withoutMatch) {
      if (!q.pattern) return "'withoutMatch' needs a 'pattern' (the text the files must NOT contain).";
      const mode = this.resolveMode(q);
      if (mode !== "filesOnly" && mode !== "count") {
        return "'withoutMatch' works per FILE, so it needs outputMode 'filesOnly' (list the files lacking the pattern) or 'count' (how many files lack it).";
      }
      if (q.invertMatch) {
        return "'withoutMatch' (file-level, `grep -L`) cannot be combined with 'invertMatch' (line-level, `grep -v`) — pick one.";
      }
      if (onlyMatching) return "'withoutMatch' cannot be combined with onlyMatching/captureGroup/aggregateMatches.";
    }
    return null;
  }

  /** Short human-readable summary of a query for batch section headers. */
  private summarizeQuery(q: SingleQueryT): string {
    const parts: string[] = [];
    if (q.pattern) parts.push(`pattern=${q.pattern}`);
    if (q.filenamePattern) parts.push(`filenamePattern=${toArray(q.filenamePattern).join(",")}`);
    if (q.include) parts.push(`include=${toArray(q.include).join(",")}`);
    if (q.exclude) parts.push(`exclude=${toArray(q.exclude).join(",")}`);
    if (q.andPattern) parts.push(`andPattern=${q.andPattern}`);
    if (q.notPattern) parts.push(`notPattern=${q.notPattern}`);
    if (q.invertMatch) parts.push("invertMatch");
    if (q.withoutMatch) parts.push("withoutMatch");
    if (q.wordBoundary) parts.push("wordBoundary");
    if (q.aggregateMatches) parts.push("aggregateMatches");
    else if (this.wantsOnlyMatching(q)) parts.push("onlyMatching");
    if (q.captureGroup !== undefined) parts.push(`captureGroup=${q.captureGroup}`);
    const mode = this.resolveMode(q);
    if (mode !== "content") parts.push(`mode=${mode}`);
    if (q.directory) parts.push(`dir=${q.directory}`);
    if (q.file) parts.push(`file=${q.file}`);
    return parts.join(" ") || "(no filters)";
  }

  /**
   * How many raw stdout lines to let through `head`. Content/file lists are cut at the
   * caller's limit (+1 so truncation is detectable); aggregation stages need more raw
   * lines than they emit, because their output is already collapsed per file/per value.
   */
  private rawLineBudget(built: BuiltCommand, limit: number): number {
    switch (built.post) {
      case "exists":
        return 1;
      case "countTotalOnly":
        return 1;
      case "countPerFile":
      case "aggregate":
        // +2 covers the sentinel line and the truncation-detection line.
        return AGG_SAFETY_ROWS + 2;
      default:
        return limit + 1;
    }
  }

  /**
   * Build the core search command (without the trailing `| head -n` cap, which
   * the caller appends once the per-query limit is known).
   *
   * NOTE: flags differ between the two tools. In ripgrep, -g is a glob filter and
   * it recurses by default; in grep, globs are --include/--exclude and recursion
   * needs an explicit -r. Both tools support -l/-c/-o/-v/-w/-i, so those are shared.
   */
  private buildCommand(q: SingleQueryT, ripgrepAvailable: boolean): BuiltCommand {
    const namePatterns = toArray(q.filenamePattern);
    const includePatterns = toArray(q.include);
    const excludePatterns = toArray(q.exclude);
    const mode = this.resolveMode(q);
    const hasContentPattern = !!q.pattern;
    const dirArg = q.directory ? shellQuote(q.directory) : ".";
    const notes: string[] = [];

    const onlyMatching = this.wantsOnlyMatching(q);
    const aggregate = !!q.aggregateMatches;
    const hasLineFilters = !!q.andPattern || !!q.notPattern;
    const filesOnly = mode === "filesOnly";

    // Count mode has two implementations. Native `-c` is fast and exact but counts BEFORE any
    // line-level filter, so it is only usable when there are no andPattern/notPattern filters and
    // we're counting lines (not -o occurrences). Otherwise we aggregate the filtered stream with awk.
    // `grep -L` semantics: the pipeline emits a plain list of paths, so counting is just `wc -l`.
    const withoutMatch = !!q.withoutMatch && hasContentPattern;
    const wantCount = mode === "count" && hasContentPattern && !aggregate && !withoutMatch;
    const nativeCount = wantCount && !hasLineFilters && !onlyMatching;
    const awkCount = wantCount && !nativeCount;

    let post: PostShape;
    let countKind: "lines" | "occurrences" | "files" = "lines";
    let countLabel: string | undefined;
    const countFormat: "native" | "awk" | "none" = nativeCount ? "native" : awkCount ? "awk" : "none";
    if (withoutMatch) {
      post = mode === "count" ? "countTotalOnly" : "fileList";
      countKind = "files";
      countLabel = `file(s) that do NOT contain pattern "${q.pattern}"`;
    } else if (!hasContentPattern) {
      post = mode === "count" ? "countTotalOnly" : mode === "exists" ? "exists" : "fileList";
      countKind = "files";
      countLabel = `file(s) matching filenamePattern ${toArray(q.filenamePattern).join(", ")}`;
    } else if (aggregate) {
      post = "aggregate";
      if (mode === "count") notes.push("aggregateMatches already returns counts; outputMode 'count' ignored");
    } else if (wantCount) {
      post = "countPerFile";
      countKind = onlyMatching ? "occurrences" : "lines";
    } else if (mode === "exists") {
      post = "exists";
    } else if (filesOnly) {
      post = "fileList";
    } else {
      post = "content";
    }

    if (q.captureGroup !== undefined && !ripgrepAvailable) {
      notes.push(
        `captureGroup=${q.captureGroup} NOT applied: the grep fallback cannot extract capture groups, so whole matches are returned`
      );
    }
    if (q.captureGroup !== undefined && !q.onlyMatching && !q.aggregateMatches) {
      notes.push("captureGroup implies onlyMatching");
    }

    let command: string;

    // NOTE: name-glob matching mirrors `find -iname` (case-INSENSITIVE), matching the shell idioms this
    // tool replaces. In ripgrep that means `--iglob`, NOT `-g` (rg's `-i` only affects content matching,
    // not glob matching against file names — a bare `-g '*analytics*' -i` will silently miss
    // `*Analytics*`-cased files, which was caught empirically against a real repo during validation).
    // grep has no case-insensitive --include/--exclude, so the grep-fallback path always routes
    // name-based restriction through `find -iname ... -exec grep {} +` instead, for the same reason.
    const allNameGlobs = [...namePatterns, ...includePatterns];

    if (!hasContentPattern) {
      // Pure filename/path search: replaces `find <dir> -iname "*a*" -o -iname "*b*"`.
      if (ripgrepAvailable) {
        command = "rg --files";
        for (const p of allNameGlobs) command += ` --iglob ${shellQuote(p)}`;
        for (const p of excludePatterns) command += ` --iglob ${shellQuote("!" + p)}`;
        command += ` ${dirArg}`;
      } else {
        const nameExpr =
          allNameGlobs.length > 0 ? "\\( " + allNameGlobs.map(findNameTest).join(" -o ") + " \\)" : "";
        command = `find ${dirArg} -type f`;
        if (nameExpr) command += ` ${nameExpr}`;
        for (const p of excludePatterns) command += ` -not ${findNameTest(p)}`;
      }
    } else if (ripgrepAvailable) {
      // Content search, optionally scoped by name/include/exclude globs, in any output mode.
      // Combining filenamePattern + pattern replaces `find <dir> -iname "*X*" | xargs grep -l "<pat>"`.
      command = "rg" + this.rgFlags(q, { mode, post, nativeCount, awkCount, onlyMatching, aggregate, withoutMatch });
      for (const p of allNameGlobs) command += ` --iglob ${shellQuote(p)}`;
      for (const p of excludePatterns) command += ` --iglob ${shellQuote("!" + p)}`;
      command += ` ${shellQuote(q.pattern!)}`;
      command += ` ${q.file ? shellQuote(q.file) : dirArg}`;
    } else if (allNameGlobs.length > 0 || excludePatterns.length > 0) {
      // grep fallback with name-glob restriction: `find -iname ... -exec grep ... {} +` — the exact
      // `find | xargs grep` idiom this tool replaces, chosen over --include/--exclude so name matching
      // stays case-insensitive like `-iname`, and over `xargs` to sidestep GNU/BSD `-r`/empty-input differences.
      // `(`/`)` are shell metacharacters, so they must be backslash-escaped (`\(`/`\)`) to reach `find`
      // as literal grouping operators rather than opening a subshell (a real bug caught empirically:
      // an unescaped `(...)` here produced a shell syntax error that a too-broad catch below was
      // silently swallowing as "no matches found" instead of surfacing).
      const nameExpr =
        allNameGlobs.length > 0 ? "\\( " + allNameGlobs.map(findNameTest).join(" -o ") + " \\)" : "";
      const grepCmd =
        "grep" +
        this.grepFlags(q, {
          mode,
          post,
          nativeCount,
          awkCount,
          onlyMatching,
          aggregate,
          withoutMatch,
          multiFile: !q.file,
        }) +
        ` ${shellQuote(q.pattern!)}`;

      command = q.file
        ? `${grepCmd} ${shellQuote(q.file)}`
        : `find ${dirArg} -type f${nameExpr ? ` ${nameExpr}` : ""}${excludePatterns
            .map((p) => ` -not ${findNameTest(p)}`)
            .join("")} -exec ${grepCmd} {} +`;
    } else {
      // grep fallback with no name restriction: plain recursive grep.
      command =
        "grep" +
        this.grepFlags(q, {
          mode,
          post,
          nativeCount,
          awkCount,
          onlyMatching,
          aggregate,
          withoutMatch,
          multiFile: !q.file,
        }) +
        ` ${shellQuote(q.pattern!)}`;
      command += q.file ? ` ${shellQuote(q.file)}` : ` -r ${dirArg}`;
    }

    // `grep -c` prints "path:0" for files with no match; ripgrep omits them. Normalize.
    if (nativeCount && !ripgrepAvailable) command += ` | grep -v ':0$'`;

    // Narrowing filters: equivalent to `| grep andPattern` and `| grep -v notPattern`.
    // andPattern first, then notPattern, so notPattern always sees the already-narrowed lines.
    if (q.andPattern) command += ` | ${this.lineFilter(q, q.andPattern, false)}`;
    if (q.notPattern) command += ` | ${this.lineFilter(q, q.notPattern, true)}`;

    // Mode-specific aggregation stage. Each one computes its totals in awk over the FULL stream and
    // prints them on a sentinel first line, so the row cap (and the trailing `head`) can only shorten
    // the listing, never corrupt the totals.
    if (post === "countTotalOnly") {
      command += " | wc -l";
    } else if (awkCount) {
      // Per-file counts over the FILTERED stream. `$1` is the path prefix (a filename prefix is always
      // forced in this mode); ripgrep emits FIELD_SEP after the path so colons inside paths don't split it.
      const sep = ripgrepAvailable ? FIELD_SEP : ":";
      if (!ripgrepAvailable) {
        notes.push(
          "per-file count labels are split on ':' in the grep fallback, so a path containing ':' may be shown truncated (the total is still exact)"
        );
      }
      command +=
        ` | awk -F${shellQuote(sep)} '{ t++; if (!($1 in c)) files++; c[$1]++ }` +
        ` END { print "${TOTALS_SENTINEL}\\t" t "\\t" files; i = 0;` +
        ` for (f in c) { if (++i > ${AGG_SAFETY_ROWS}) break; print c[f] "\\t" f } }'`;
    } else if (nativeCount) {
      // `rg -c` / `grep -c` rows are "path:count"; $NF is the count even if the path contains colons.
      command +=
        ` | awk -F: '{ n++; t += $NF; if (n <= ${AGG_SAFETY_ROWS}) r[n] = $0 }` +
        ` END { print "${TOTALS_SENTINEL}\\t" t "\\t" n;` +
        ` m = (n < ${AGG_SAFETY_ROWS} ? n : ${AGG_SAFETY_ROWS}); for (i = 1; i <= m; i++) print r[i] }'`;
    } else if (post === "aggregate") {
      // Replaces `... | sort | uniq -c | sort -rn`, then totals the counts (field 1 of `uniq -c`).
      command +=
        " | sort | uniq -c | sort -rn" +
        ` | awk '{ n++; t += $1; if (n <= ${AGG_SAFETY_ROWS}) r[n] = $0 }` +
        ` END { print "${TOTALS_SENTINEL}\\t" t "\\t" n;` +
        ` m = (n < ${AGG_SAFETY_ROWS} ? n : ${AGG_SAFETY_ROWS}); for (i = 1; i <= m; i++) print r[i] }'`;
    }

    return { command, mode, post, countKind, countFormat, countLabel, notes };
  }

  /** ripgrep flag assembly, shared by every output mode. */
  private rgFlags(
    q: SingleQueryT,
    o: {
      mode: OutputMode;
      post: PostShape;
      nativeCount: boolean;
      awkCount: boolean;
      onlyMatching: boolean;
      aggregate: boolean;
      withoutMatch: boolean;
    }
  ): string {
    let f = "";
    if (o.withoutMatch) f += " --files-without-match";
    else if (o.mode === "filesOnly") f += " -l";
    else if (o.nativeCount) f += " -c -H";
    else {
      if (o.aggregate) f += " --no-filename --no-line-number";
      else if (o.awkCount) f += ` -H --no-heading --no-line-number --field-match-separator ${shellQuote(FIELD_SEP)}`;
      else if (q.lineNumbers !== false) f += " -n";
      if (o.onlyMatching) f += " -o";
      if (q.captureGroup !== undefined) f += ` -r ${shellQuote("$" + q.captureGroup)}`;
      if (!o.onlyMatching && !o.awkCount && o.mode === "content" && q.context && q.context > 0) {
        f += ` -C ${q.context}`;
      }
    }
    if (q.regex === false) f += " -F";
    if (q.caseSensitive === false) f += " -i";
    if (q.wordBoundary) f += " -w";
    if (q.invertMatch) f += " -v";
    return f;
  }

  /** POSIX grep flag assembly (fallback engine), mirroring rgFlags. */
  private grepFlags(
    q: SingleQueryT,
    o: {
      mode: OutputMode;
      post: PostShape;
      nativeCount: boolean;
      awkCount: boolean;
      onlyMatching: boolean;
      aggregate: boolean;
      withoutMatch: boolean;
      multiFile: boolean;
    }
  ): string {
    let f = "";
    if (o.withoutMatch) f += " -L";
    else if (o.mode === "filesOnly") f += " -l";
    else if (o.nativeCount) f += " -c -H";
    else {
      if (o.aggregate) f += " -h";
      else if (o.awkCount) f += " -H";
      else {
        // grep omits the filename when handed exactly ONE file, which happens whenever the
        // `find ... -exec grep {} +` form expands to a single file — silently producing bare
        // `line:text` output with no path, unlike ripgrep. Force -H so multi-file searches always
        // identify the file (caught empirically: a one-matching-file onlyMatching search lost its paths).
        if (o.multiFile) f += " -H";
        if (q.lineNumbers !== false) f += " -n";
      }
      if (o.onlyMatching) f += " -o";
      if (!o.onlyMatching && !o.awkCount && o.mode === "content" && q.context && q.context > 0) {
        f += ` -C ${q.context}`;
      }
    }
    f += q.regex === false ? " -F" : " -E";
    if (q.caseSensitive === false) f += " -i";
    if (q.wordBoundary) f += " -w";
    if (q.invertMatch) f += " -v";
    return f;
  }

  /** A `| grep [-v] pat` stage used for andPattern/notPattern. */
  private lineFilter(q: SingleQueryT, pattern: string, invert: boolean): string {
    let cmd = "grep";
    if (invert) cmd += " -v";
    cmd += q.regex === false ? " -F" : " -E";
    if (q.caseSensitive === false) cmd += " -i";
    return `${cmd} ${shellQuote(pattern)}`;
  }

  private async isRipgrepAvailable(): Promise<boolean> {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);
      await execPromise("which rg");
      return true;
    } catch {
      return false;
    }
  }

  private async isGrepAvailable(): Promise<boolean> {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);
      await execPromise("which grep");
      return true;
    } catch {
      return false;
    }
  }

  /** Run the pipeline, keeping stdout and stderr strictly separate. */
  private async executeCommand(
    command: string,
    ctx: ExtensionContext
  ): Promise<{ stdout: string; stderr: string; hardError?: string }> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execPromise = promisify(exec);

    try {
      const { stdout, stderr } = await execPromise(command, {
        cwd: ctx.cwd,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      return { stdout, stderr };
    } catch (error) {
      // Every command we build ends with `| head` (or `| wc -l` / `| awk`), which normalizes the
      // pipeline's exit status to that last stage's (0) even when grep/rg/find found nothing — so a
      // non-zero exit here means a REAL failure (bad flag, shell syntax error, missing path), not
      // "no matches". Never swallow it as an empty result.
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const message = e.stderr?.trim() || e.message || String(error);
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", hardError: message };
    }
  }

  /** Turn raw pipeline stdout into the text the model sees, per output mode. */
  private formatResult(raw: string, built: BuiltCommand, q: SingleQueryT, limit: number): string {
    const scope = this.describeScope(q);
    const desc = q.pattern ?? toArray(q.filenamePattern).join(", ");

    switch (built.post) {
      case "exists":
        return this.formatExists(raw, desc, scope, q);
      case "countTotalOnly": {
        const n = parseInt(raw.trim(), 10) || 0;
        return `count: ${n} ${built.countLabel ?? `file(s) matching ${desc}`}${scope}`;
      }
      case "countPerFile":
        return this.formatCount(raw, built, desc, scope, q, limit);
      case "aggregate":
        return this.formatAggregate(raw, desc, scope, q, limit);
      default:
        return this.formatLines(raw, desc, scope, q, limit, built);
    }
  }

  /**
   * Read the `##TOTALS##\t<total>\t<groups>` sentinel line emitted by the shell-side aggregation
   * stages. It is printed FIRST, before any rows, so it always survives the row cap and the
   * trailing `head` — which is what keeps count/aggregate totals exact on huge result sets.
   */
  private parseTotals(raw: string): { total: number; groups: number } | null {
    for (const line of raw.split("\n")) {
      if (!line.startsWith(TOTALS_SENTINEL)) continue;
      const parts = line.split("\t");
      const total = parseInt(parts[1] ?? "", 10);
      const groups = parseInt(parts[2] ?? "", 10);
      if (Number.isNaN(total)) return null;
      return { total, groups: Number.isNaN(groups) ? 0 : groups };
    }
    return null;
  }

  private describeScope(q: SingleQueryT): string {
    const where = q.file ?? q.directory ?? ".";
    return ` in ${where}`;
  }

  private formatExists(raw: string, desc: string, scope: string, q: SingleQueryT): string {
    const first = raw.split("\n").find((l) => l.trim().length > 0);
    if (!first) {
      return `exists: false — no ${q.invertMatch ? "non-matching" : "matching"} line for pattern "${desc}"${scope}`;
    }
    return `exists: true — first hit: ${this.clipLine(first, q)}\n(outputMode 'exists' returns only the first hit; use 'count' for how many or 'content' for all.)`;
  }

  private formatCount(
    raw: string,
    built: BuiltCommand,
    desc: string,
    scope: string,
    q: SingleQueryT,
    limit: number
  ): string {
    const rows: { count: number; path: string }[] = [];
    const totals = this.parseTotals(raw);

    for (const line of raw.split("\n")) {
      if (!line.trim() || line.startsWith(TOTALS_SENTINEL)) continue;
      if (built.countFormat === "awk") {
        // "count<TAB>path"
        const tab = line.indexOf("\t");
        if (tab <= 0) continue;
        const count = parseInt(line.slice(0, tab), 10);
        if (Number.isNaN(count)) continue;
        rows.push({ count, path: line.slice(tab + 1) });
      } else {
        // "path:count"
        const colon = line.lastIndexOf(":");
        if (colon < 0) continue;
        const count = parseInt(line.slice(colon + 1), 10);
        if (Number.isNaN(count)) continue;
        rows.push({ count, path: line.slice(0, colon) });
      }
    }

    const total = totals?.total ?? rows.reduce((a, r) => a + r.count, 0);
    const fileCount = totals?.groups ?? rows.length;
    const unit = built.countKind === "occurrences" ? "occurrence(s)" : "matching line(s)";
    const what = q.invertMatch ? `NON-matching line(s) (invertMatch)` : unit;
    if (total === 0) return `count: 0 ${what} for pattern "${desc}"${scope}`;

    rows.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    const shown = rows.slice(0, limit);
    const body = shown.map((r) => `${String(r.count).padStart(6)}  ${r.path}`).join("\n");
    const hidden = fileCount - shown.length;
    const capped = fileCount > rows.length;
    const more =
      hidden > 0
        ? `\n... [${hidden} more file(s) not listed${
            capped ? ` (only the first ${rows.length} files were listed at all)` : ""
          }; the totals above are still exact. Raise 'limit' to list more.]`
        : "";
    return `count: ${total} ${what} across ${fileCount} file(s) for pattern "${desc}"${scope}\n${body}${more}`;
  }

  private formatAggregate(raw: string, desc: string, scope: string, q: SingleQueryT, limit: number): string {
    const totals = this.parseTotals(raw);
    const rows: { count: number; value: string }[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(TOTALS_SENTINEL)) continue;
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (!m) continue;
      rows.push({ count: parseInt(m[1]!, 10), value: m[2]! });
    }
    if (rows.length === 0) return `No matches found for pattern: "${desc}"${scope}`;

    const totalOccurrences = totals?.total ?? rows.reduce((a, r) => a + r.count, 0);
    const distinct = totals?.groups ?? rows.length;
    const shown = rows.slice(0, limit);
    const body = shown
      .map((r) => `${String(r.count).padStart(6)}  ${this.clipLine(r.value, q)}`)
      .join("\n");
    const hidden = distinct - shown.length;
    const capped = distinct > rows.length;
    const more =
      hidden > 0
        ? `\n... [${hidden} more distinct value(s) not listed${
            capped ? ` (only the top ${rows.length} were carried out of the search)` : ""
          }; the totals above are still exact. Raise 'limit' to see more.]`
        : "";
    return (
      `unique matched values for pattern "${desc}"${scope}: ${distinct} distinct, ` +
      `${totalOccurrences} occurrence(s) total (count on the left)\n${body}${more}`
    );
  }

  /** Content / file-list output: per-line clipping, then the line/char caps. */
  private formatLines(
    raw: string,
    desc: string,
    scope: string,
    q: SingleQueryT,
    limit: number,
    built: BuiltCommand
  ): string {
    const allLines = raw.split("\n");
    // Drop a single trailing empty line from stdout without hiding real blank matches.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
    if (allLines.length === 0) {
      const what = q.invertMatch ? `non-matching lines for pattern` : "pattern";
      return `No matches found for ${what}: "${desc}"${scope}`;
    }

    let truncatedLines = false;
    let lines = allLines;
    if (lines.length > limit) {
      lines = lines.slice(0, limit);
      truncatedLines = true;
    }

    let text = lines.map((l) => this.clipLine(l, q)).join("\n");
    let truncatedChars = false;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncatedChars = true;
    }

    if (truncatedLines || truncatedChars) {
      const hint =
        built.post === "fileList"
          ? "narrow the pattern/globs, or raise 'limit'"
          : "narrow the pattern, switch to outputMode 'count'/'filesOnly', or raise 'limit'";
      text += `\n... [output truncated at ${limit} lines / ${MAX_CHARS} chars. More matches exist: ${hint}.]`;
    }

    return text.trim() || `No matches found for pattern: "${desc}"${scope}`;
  }

  /**
   * Clip one very long line (minified bundle, base64 blob, generated file) with an explicit
   * marker, so a single pathological line cannot flood the context. The `path:line:` prefix
   * comes first in grep output, so clipping from the right always preserves it.
   */
  private clipLine(line: string, q: SingleQueryT): string {
    const max = q.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : Math.floor(q.maxLineLength);
    if (max <= 0 || line.length <= max) return line;
    return `${line.slice(0, max)} … [line truncated: showed ${max} of ${line.length} chars]`;
  }
}

export default function (pi: ExtensionAPI) {
  const ext = new BashGrepExtension(pi);
  return ext.init();
}
