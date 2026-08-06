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

/** Shared shape for a single search request, used both at the top level and inside `queries[]`. */
const QueryFields = {
  pattern: Type.Optional(
    Type.String({
      description:
        "The text pattern or regex to search for INSIDE file contents. Optional if filenamePattern is set " +
        "(in that case the tool just lists matching file names/paths).",
    })
  ),
  file: Type.Optional(
    Type.String({
      description: "Specific file to search in (optional)",
    })
  ),
  directory: Type.Optional(
    Type.String({
      description: "Directory to search in (optional, defaults to current)",
    })
  ),
  filenamePattern: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Glob pattern (or array of globs) matched against the FILE NAME/PATH, e.g. \"*Jenkinsfile*\" or " +
        "[\"*a*\", \"*b*\"]. Replaces `find -iname ...`. If `pattern` is also set, content search is " +
        "restricted to files whose name matches this glob (replaces `find ... | xargs grep`). If `pattern` " +
        "is omitted, this just lists matching file paths (replaces `find -iname ... -o -iname ...`).",
    })
  ),
  include: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        'Glob pattern (or array) restricting content search to matching files by type/location, e.g. "*.json". ' +
        "Maps to ripgrep -g / grep --include. Combine with `pattern` for a content search scoped to these files.",
    })
  ),
  exclude: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: 'Glob pattern (or array) to exclude from search, e.g. "*.min.js". Maps to ripgrep -g "!glob" / grep --exclude.',
    })
  ),
  andPattern: Type.Optional(
    Type.String({
      description:
        "A second pattern that must ALSO be present in each output line (file path if filesOnly, otherwise the " +
        'match line). Equivalent to piping into a second `grep`, e.g. `grep pat dir | grep andPattern`, so the ' +
        "model doesn't need a separate pipeline.",
    })
  ),
  filesOnly: Type.Optional(
    Type.Boolean({
      description:
        "If true, return only the list of matching file paths (like `rg -l` / `grep -rl`), not match content. " +
        "Use this whenever you only need to know WHICH files match, not the matching lines themselves.",
      default: false,
    })
  ),
  regex: Type.Optional(
    Type.Boolean({
      description: "Whether to use regex pattern matching (default true)",
      default: true,
    })
  ),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description: "Whether the search is case sensitive (default true)",
      default: true,
    })
  ),
  lineNumbers: Type.Optional(
    Type.Boolean({
      description: "Whether to include line numbers (default true)",
      default: true,
    })
  ),
  context: Type.Optional(
    Type.Number({
      description: "Number of context lines before/after matches (default 0)",
      default: 0,
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of output lines to return for this query (default ${DEFAULT_LIMIT})`,
      default: DEFAULT_LIMIT,
    })
  ),
};

const SingleQuery = Type.Object(QueryFields);
type SingleQueryT = Static<typeof SingleQuery>;

const QueryWithLabel = Type.Object({
  ...QueryFields,
  label: Type.Optional(
    Type.String({ description: "Short human-readable label for this query, used in the batch output header." })
  ),
});
type QueryWithLabelT = Static<typeof QueryWithLabel>;

const Params = Type.Object({
  ...QueryFields,
  queries: Type.Optional(
    Type.Array(QueryWithLabel, {
      description:
        "Run several related searches in ONE call instead of chaining multiple shell commands with `echo " +
        '"---"` separators. Each element has the same shape as the top-level params (pattern/filenamePattern/' +
        "directory/include/exclude/filesOnly/andPattern/...). Results are returned in labeled sections, one " +
        "per query. When `queries` is set, the top-level pattern/directory/etc. fields are ignored.",
    })
  ),
});
type ParamsT = Static<typeof Params>;

interface BuiltCommand {
  command: string;
  /** True when this command's raw output is a bare list of file paths (no need to grep-filter for filesOnly line format). */
  isFileList: boolean;
}

class BashGrepExtension {
  constructor(private pi: ExtensionAPI) {}

  async init() {
    this.pi.registerTool({
      name: "grep",
      label: "Grep",
      description:
        "Search text patterns in files using ripgrep or grep, with support for file-name globbing, " +
        "files-only results, a second narrowing pattern, and batched multi-query search.",
      promptSnippet:
        "Search text/regex patterns and file names across files, with files-only and batch modes",
      promptGuidelines: [
        "Use grep to search for specific text patterns or regular expressions across files.",
        "If you want to search for exact strings, use basic pattern matching.",
        "Use line numbers to locate specific matches within files.",
        "Use grep's `filesOnly` when you only need file paths, not match content — do not post-process full " +
          "match output down to file names yourself.",
        "Use grep's `filenamePattern` instead of a separate `find`/file-listing command when searching by " +
          'file name/path glob (e.g. filenamePattern: "*Jenkinsfile*"); combine it with `pattern` to search ' +
          "inside only files whose name matches (this replaces `find ... | xargs grep`), and omit `pattern` " +
          "to just list matching file paths (this replaces `find -iname ...`).",
        'Use grep\'s `include`/`exclude` to scope a content search by file type/location (e.g. include: "*.json"); ' +
          "prefer these over piping through a second command.",
        "Use grep's `andPattern` when a result must ALSO contain a second string, instead of piping into a " +
          "second grep (`grep pat dir | grep pat2`).",
        "Use grep's `queries` array to run several related searches in one call instead of chaining multiple " +
          'shell commands with `echo "---label---"` separators — each query gets its own labeled section in the result.',
        "Do NOT use grep's `queries` array for a single unrelated search, or when later queries depend on the " +
          "output of earlier ones (e.g. picking a directory found by query 1) — those still need separate calls.",
        `Output is capped at ${DEFAULT_LIMIT} match lines per query by default; raise or lower it with 'limit'. If the result says it was truncated, narrow the pattern or directory instead of retrying the same search.`,
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
          if (!q.pattern && !q.filenamePattern) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: query ${i + 1} needs at least one of 'pattern' or 'filenamePattern'.`,
                },
              ],
              details: { error: "missing pattern/filenamePattern", queryIndex: i },
            };
          }
        }

        const isBatch = !!params.queries && params.queries.length > 0;
        const sections: string[] = [];
        const commandsRun: string[] = [];

        for (const [i, q] of queries.entries()) {
          const built = this.buildCommand(q, ripgrepAvailable);
          commandsRun.push(built.command);
          const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : DEFAULT_LIMIT;
          const finalCommand = `${built.command} | head -n ${limit + 1}`;

          let resultText: string;
          try {
            resultText = await this.executeCommand(finalCommand, ctx, q.pattern ?? q.filenamePattern, limit);
          } catch (error) {
            resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
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
          details: { commands: commandsRun, tool, batch: isBatch, queryCount: queries.length },
        };
      },
      renderCall: (args, theme) => {
        const a = args as ParamsT;
        let text = theme.fg("toolTitle", theme.bold("grep "));
        if (a.queries && a.queries.length > 0) {
          text += theme.fg("accent", `${a.queries.length} queries`);
        } else if (a.filesOnly) {
          text += theme.fg("accent", `-l ${a.pattern ?? a.filenamePattern ?? ""}`);
        } else {
          text += theme.fg("accent", String(a.pattern ?? a.filenamePattern ?? ""));
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

  /** Short human-readable summary of a query for batch section headers. */
  private summarizeQuery(q: SingleQueryT): string {
    const parts: string[] = [];
    if (q.pattern) parts.push(`pattern=${q.pattern}`);
    if (q.filenamePattern) parts.push(`filenamePattern=${toArray(q.filenamePattern).join(",")}`);
    if (q.include) parts.push(`include=${toArray(q.include).join(",")}`);
    if (q.exclude) parts.push(`exclude=${toArray(q.exclude).join(",")}`);
    if (q.andPattern) parts.push(`andPattern=${q.andPattern}`);
    if (q.filesOnly) parts.push("filesOnly");
    if (q.directory) parts.push(`dir=${q.directory}`);
    if (q.file) parts.push(`file=${q.file}`);
    return parts.join(" ") || "(no filters)";
  }

  /**
   * Build the core search command (without the trailing `| head -n` limit, which
   * the caller appends once the per-query limit is known).
   *
   * NOTE: flags differ between the two tools. In ripgrep, -g is a glob filter and
   * it recurses by default; in grep, globs are --include/--exclude and recursion
   * needs an explicit -r. Both tools support -l for files-only and -i for case
   * insensitivity, so those are shared across branches.
   */
  private buildCommand(q: SingleQueryT, ripgrepAvailable: boolean): BuiltCommand {
    const namePatterns = toArray(q.filenamePattern);
    const includePatterns = toArray(q.include);
    const excludePatterns = toArray(q.exclude);
    const filesOnly = !!q.filesOnly;
    const hasContentPattern = !!q.pattern;
    const dirArg = q.directory ? shellQuote(q.directory) : ".";

    let command: string;
    let isFileList: boolean;

    // NOTE: name-glob matching mirrors `find -iname` (case-INSENSITIVE), matching the shell idioms this
    // tool replaces. In ripgrep that means `--iglob`, NOT `-g` (rg's `-i` only affects content matching,
    // not glob matching against file names — a bare `-g '*analytics*' -i` will silently miss
    // `*Analytics*`-cased files, which was caught empirically against a real repo during validation).
    // grep has no case-insensitive --include/--exclude, so the grep-fallback path always routes
    // name-based restriction through `find -iname ... -exec grep {} +` instead, for the same reason.
    const allNameGlobs = [...namePatterns, ...includePatterns];

    if (!hasContentPattern) {
      // Pure filename/path search: replaces `find <dir> -iname "*a*" -o -iname "*b*"`.
      isFileList = true;
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
      // Content search, optionally scoped by name/include/exclude globs, optionally files-only.
      // Combining filenamePattern + pattern replaces `find <dir> -iname "*X*" | xargs grep -l "<pat>"`.
      isFileList = filesOnly;
      command = "rg";
      if (filesOnly) command += " -l";
      if (q.regex === false) command += " -F";
      if (q.caseSensitive === false) command += " -i";
      if (!filesOnly && q.lineNumbers !== false) command += " -n";
      if (!filesOnly && q.context && q.context > 0) command += ` -C ${q.context}`;
      for (const p of allNameGlobs) command += ` --iglob ${shellQuote(p)}`;
      for (const p of excludePatterns) command += ` --iglob ${shellQuote("!" + p)}`;
      command += ` ${shellQuote(q.pattern!)}`;
      command += ` ${q.file ? shellQuote(q.file) : dirArg}`;
    } else if (allNameGlobs.length > 0 || excludePatterns.length > 0) {
      // grep fallback with name-glob restriction: `find -iname ... -exec grep ... {} +` — the exact
      // `find | xargs grep` idiom this tool replaces, chosen over --include/--exclude so name matching
      // stays case-insensitive like `-iname`, and over `xargs` to sidestep GNU/BSD `-r`/empty-input differences.
      isFileList = filesOnly;
      // `(`/`)` are shell metacharacters, so they must be backslash-escaped (`\(`/`\)`) to reach `find`
      // as literal grouping operators rather than opening a subshell (a real bug caught empirically:
      // an unescaped `(...)` here produced a shell syntax error that a too-broad catch below was
      // silently swallowing as "no matches found" instead of surfacing).
      const nameExpr =
        allNameGlobs.length > 0 ? "\\( " + allNameGlobs.map(findNameTest).join(" -o ") + " \\)" : "";
      let grepCmd = "grep";
      if (filesOnly) grepCmd += " -l";
      if (q.regex === false) grepCmd += " -F";
      else grepCmd += " -E";
      if (q.caseSensitive === false) grepCmd += " -i";
      if (!filesOnly && q.lineNumbers !== false) grepCmd += " -n";
      if (!filesOnly && q.context && q.context > 0) grepCmd += ` -C ${q.context}`;
      grepCmd += ` ${shellQuote(q.pattern!)}`;

      command = q.file
        ? `${grepCmd} ${shellQuote(q.file)}`
        : `find ${dirArg} -type f${nameExpr ? ` ${nameExpr}` : ""}${excludePatterns
            .map((p) => ` -not ${findNameTest(p)}`)
            .join("")} -exec ${grepCmd} {} +`;
    } else {
      // grep fallback with no name restriction: plain recursive grep.
      isFileList = filesOnly;
      command = "grep";
      if (filesOnly) command += " -l";
      if (q.regex === false) command += " -F";
      else command += " -E";
      if (q.caseSensitive === false) command += " -i";
      if (!filesOnly && q.lineNumbers !== false) command += " -n";
      if (!filesOnly && q.context && q.context > 0) command += ` -C ${q.context}`;
      command += ` ${shellQuote(q.pattern!)}`;
      command += q.file ? ` ${shellQuote(q.file)}` : ` -r ${dirArg}`;
    }

    // Narrowing filter: equivalent to piping into a second grep (`| grep andPattern`).
    if (q.andPattern) {
      let andCmd = "grep";
      if (q.caseSensitive === false) andCmd += " -i";
      andCmd += ` ${shellQuote(q.andPattern)}`;
      command += ` | ${andCmd}`;
    }

    return { command, isFileList };
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

  private async executeCommand(
    command: string,
    ctx: ExtensionContext,
    patternDescription: string | string[] | undefined,
    limit: number
  ): Promise<string> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execPromise = promisify(exec);

    try {
      const { stdout, stderr } = await execPromise(command, {
        cwd: ctx.cwd,
        maxBuffer: MAX_BUFFER_BYTES,
      });

      const truncatedStdout = this.truncate(stdout, limit);

      // If there's stderr (like grep warnings), include it in the result
      const result = truncatedStdout + (stderr ? `\nErrors: ${stderr}` : "");

      // If result is empty, indicate no matches found
      const desc = Array.isArray(patternDescription) ? patternDescription.join(", ") : patternDescription;
      return result.trim() || `No matches found for pattern: "${desc}"`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Every command we build ends with `| head`, which normalizes the pipeline's exit status to
      // head's (0) even when grep/rg/find found nothing — so a non-zero exit here means a REAL failure
      // (bad flag, shell syntax error, missing path), not "no matches". Never swallow it as empty.
      if (
        errorMessage.includes("No such file or directory") ||
        errorMessage.includes("Permission denied")
      ) {
        return `Error: ${errorMessage}`;
      }
      throw error;
    }
  }

  /**
   * Cut output down to `limit` lines and MAX_CHARS characters, appending an
   * explicit marker so the caller knows results are incomplete.
   */
  private truncate(stdout: string, limit: number): string {
    let text = stdout;
    let truncated = false;

    const lines = text.split("\n");
    if (lines.length > limit) {
      text = lines.slice(0, limit).join("\n");
      truncated = true;
    }

    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }

    if (truncated) {
      text +=
        `\n... [output truncated at ${limit} lines / ${MAX_CHARS} chars. ` +
        "More matches exist: narrow the pattern or directory, or raise 'limit'.]";
    }

    return text;
  }
}

export default function (pi: ExtensionAPI) {
  const ext = new BashGrepExtension(pi);
  return ext.init();
}
