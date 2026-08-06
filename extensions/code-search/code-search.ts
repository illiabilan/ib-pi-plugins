/**
 * Code Search Extension for Pi
 *
 * Fast, syntax-aware code navigation powered by tree-sitter (via web-tree-sitter
 * + prebuilt WASM grammars from tree-sitter-wasms — no native compilation needed).
 *
 * Capabilities:
 * - Indexes functions, classes, interfaces, types, enums, methods, variables,
 *   constants, and properties across the whole project
 * - Fuzzy / substring / wildcard symbol search
 * - Filter by symbol type and/or language
 * - `/code-search` interactive picker, `/code-index` manual rebuild
 * - `code_search` tool callable by the LLM
 *
 * Install:
 *   cp -r code-search ~/.pi/agent/extensions/
 *   cd ~/.pi/agent/extensions/code-search && npm install
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { glob } from "glob";
import { createRequire } from "node:module";
import { Text } from "@earendil-works/pi-tui";
import { LANGUAGES, languageForExtension, allGlobPatterns, type LanguageConfig } from "./queries.ts";

const require = createRequire(import.meta.url);

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
  "**/vendor/**",
  "**/target/**",
];

type SymbolType =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "const"
  | "property"
  | "import";

// How a symbol was extracted, so callers can weight trust accordingly.
// "ast" results come from real tree-sitter syntax parsing and can never
// match text inside comments/strings/call-sites — only actual declaration
// nodes. "regex" results are a line-based text fallback (used when a
// grammar fails to load or a file fails to parse) and behave like grep:
// they CAN match inside comments and string literals, so they're
// meaningfully less trustworthy and should be flagged as such to the LLM.
type SymbolSource = "ast" | "regex";

interface SymbolInfo {
  name: string;
  type: SymbolType;
  file: string;
  line: number; // 1-based
  column: number; // 0-based
  language: string;
  source: SymbolSource;
}

interface SearchIndex {
  all: SymbolInfo[];
  byFile: Map<string, SymbolInfo[]>;
}

const SYMBOL_ICONS: Record<SymbolType, string> = {
  function: "ƒ",
  method: "→",
  class: "C",
  interface: "I",
  type: "T",
  enum: "E",
  variable: "v",
  const: "K",
  property: "p",
  import: "⇲",
};

// Short ASCII tags for the LLM-facing tool result text (unicode icons above
// are only for TUI rendering). Kept terse since this repeats once per match.
const SYMBOL_TAGS: Record<SymbolType, string> = {
  function: "fn",
  method: "mth",
  class: "cls",
  interface: "ifc",
  type: "typ",
  enum: "enum",
  variable: "var",
  const: "const",
  property: "prop",
  import: "imp",
};

// When a grammar's queries produce multiple candidate types for the exact
// same source position (e.g. a const-assigned arrow function matching both
// a specific "function" pattern and the generic "variable" pattern), the
// lower-numbered (more specific/useful) type wins. See parse()'s
// bestByPosition resolution for why this can't rely on query pattern order.
const SYMBOL_TYPE_PRIORITY: Record<SymbolType, number> = {
  function: 0,
  method: 1,
  class: 2,
  interface: 3,
  enum: 4,
  type: 5,
  const: 6,
  property: 7,
  import: 8,
  variable: 9,
};

class TreeSitterRuntime {
  private ParserCtor: any;
  private LanguageCtor: any;
  private initialized = false;
  private languageCache: Map<string, any> = new Map();
  private queryCache: Map<string, any> = new Map();
  private wasmsBaseDir: string | null = null;

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    try {
      const webTreeSitter = require("web-tree-sitter");
      // web-tree-sitter@0.20.x exports the Parser class as module.exports.
      // Parser.Language is only attached after Parser.init() resolves.
      this.ParserCtor = webTreeSitter.default ?? webTreeSitter;
      await this.ParserCtor.init();
      this.LanguageCtor = this.ParserCtor.Language;

      // Locate prebuilt wasm grammars
      const wasmsPkg = require.resolve("tree-sitter-wasms/package.json");
      this.wasmsBaseDir = wasmsPkg.replace(/package\.json$/, "out");

      this.initialized = true;
      return true;
    } catch (err) {
      debugLog("tree-sitter unavailable, falling back to regex parsing:", (err as Error).message);
      return false;
    }
  }

  get available() {
    return this.initialized;
  }

  private async loadLanguage(config: LanguageConfig): Promise<any | null> {
    if (this.languageCache.has(config.wasm)) return this.languageCache.get(config.wasm);
    if (!this.wasmsBaseDir) return null;
    try {
      const wasmPath = `${this.wasmsBaseDir}/tree-sitter-${config.wasm}.wasm`;
      const lang = await this.LanguageCtor.load(wasmPath);
      this.languageCache.set(config.wasm, lang);
      return lang;
    } catch (err) {
      debugLog(`failed to load grammar "${config.wasm}":`, (err as Error).message);
      this.languageCache.set(config.wasm, null);
      return null;
    }
  }

  private getQuery(langKey: string, lang: any, queryText: string): any | null {
    const cacheKey = langKey;
    if (this.queryCache.has(cacheKey)) return this.queryCache.get(cacheKey);
    try {
      const query = lang.query(queryText);
      this.queryCache.set(cacheKey, query);
      return query;
    } catch (err) {
      debugLog(`failed to compile query for "${langKey}":`, (err as Error).message);
      this.queryCache.set(cacheKey, null);
      return null;
    }
  }

  async parse(langKey: string, config: LanguageConfig, content: string): Promise<SymbolInfo[] | null> {
    const lang = await this.loadLanguage(config);
    if (!lang) return null;

    const query = this.getQuery(langKey, lang, config.query);
    if (!query) return null;

    const parser = new this.ParserCtor();
    parser.setLanguage(lang);

    let tree: any;
    try {
      tree = parser.parse(content);
    } catch (err) {
      return null;
    }

    // Some grammars have patterns that can double-match the same node (e.g.
    // Kotlin's generic "class" pattern also matching "enum class"; or a
    // TypeScript arrow-function-valued const matching both a specific
    // "function" pattern and the generic "variable" pattern). Query pattern
    // *declaration order* is NOT a reliable tie-breaker: web-tree-sitter's
    // query.matches() can return a later-declared pattern's match before an
    // earlier, more specific one for the same span. Resolve deterministically
    // by explicit type priority instead, keyed by exact source position.
    // IMPORTANT: extract plain values (name/line/column) from each capture
    // node *while the tree is still alive*. Node objects are thin views into
    // the underlying WASM tree buffer; once tree.delete() runs (in the
    // finally block), any node references still held become use-after-free
    // and .text/.startPosition silently return garbage/empty values instead
    // of throwing — so this must not be deferred past the try block.
    const bestByPosition = new Map<string, { type: SymbolType; name: string; line: number; column: number }>();
    try {
      const matches = query.matches(tree.rootNode);
      for (const match of matches) {
        for (const capture of match.captures) {
          const type = capture.name as SymbolType;
          if (!(type in SYMBOL_ICONS)) continue;
          const posKey = `${capture.node.startPosition.row}:${capture.node.startPosition.column}`;
          const existing = bestByPosition.get(posKey);
          if (!existing || SYMBOL_TYPE_PRIORITY[type] < SYMBOL_TYPE_PRIORITY[existing.type]) {
            bestByPosition.set(posKey, {
              type,
              name: capture.node.text,
              line: capture.node.startPosition.row + 1,
              column: capture.node.startPosition.column,
            });
          }
        }
      }
    } finally {
      tree.delete?.();
    }

    const symbols: SymbolInfo[] = [];
    for (const { type, name, line, column } of bestByPosition.values()) {
      symbols.push({
        name,
        type,
        file: "", // filled by caller
        line,
        column,
        language: langKey,
        source: "ast",
      });
    }

    return symbols;
  }
}

// --- Regex fallback (used when tree-sitter fails to load or parse) ---

const REGEX_PATTERNS: Record<string, Array<{ regex: RegExp; type: SymbolType }>> = {
  typescript: [
    { regex: /\bfunction\s+(\w+)/g, type: "function" },
    { regex: /\bclass\s+(\w+)/g, type: "class" },
    { regex: /\binterface\s+(\w+)/g, type: "interface" },
    { regex: /\btype\s+(\w+)\s*=/g, type: "type" },
    { regex: /\benum\s+(\w+)/g, type: "enum" },
    { regex: /\bconst\s+(\w+)\s*[:=]/g, type: "const" },
    { regex: /\blet\s+(\w+)\s*[:=]/g, type: "variable" },
  ],
  javascript: [
    { regex: /\bfunction\s+(\w+)/g, type: "function" },
    { regex: /\bclass\s+(\w+)/g, type: "class" },
    { regex: /\bconst\s+(\w+)\s*=/g, type: "const" },
    { regex: /\blet\s+(\w+)\s*=/g, type: "variable" },
  ],
  python: [
    { regex: /^\s*def\s+(\w+)/gm, type: "function" },
    { regex: /^\s*class\s+(\w+)/gm, type: "class" },
  ],
  rust: [
    { regex: /\bfn\s+(\w+)/g, type: "function" },
    { regex: /\bstruct\s+(\w+)/g, type: "class" },
    { regex: /\btrait\s+(\w+)/g, type: "interface" },
    { regex: /\benum\s+(\w+)/g, type: "enum" },
  ],
  go: [
    { regex: /\bfunc\s+(?:\([^)]*\)\s*)?(\w+)/g, type: "function" },
    { regex: /\btype\s+(\w+)\s+struct/g, type: "class" },
  ],
  java: [
    { regex: /\bclass\s+(\w+)/g, type: "class" },
    { regex: /\binterface\s+(\w+)/g, type: "interface" },
  ],
  kotlin: [
    { regex: /\bfun\s+(\w+)/g, type: "function" },
    { regex: /\binterface\s+(\w+)/g, type: "interface" },
    { regex: /\benum\s+class\s+(\w+)/g, type: "enum" },
    { regex: /\bclass\s+(\w+)/g, type: "class" },
    { regex: /\bobject\s+(\w+)/g, type: "class" },
    { regex: /\bval\s+(\w+)/g, type: "variable" },
    { regex: /\bvar\s+(\w+)/g, type: "variable" },
  ],
};

function regexFallback(langKey: string, content: string): SymbolInfo[] {
  const patterns = REGEX_PATTERNS[langKey];
  if (!patterns) return [];
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { regex, type } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(lines[i]))) {
        symbols.push({
          name: match[1],
          type,
          file: "",
          line: i + 1,
          column: match.index,
          language: langKey,
          source: "regex",
        });
      }
    }
  }
  return symbols;
}

// --- Main extension ---

class CodeSearchExtension {
  private runtime = new TreeSitterRuntime();
  private index: SearchIndex = { all: [], byFile: new Map() };
  private isIndexing = false;
  private indexBuildPromise: Promise<void> | null = null;
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  // When each file's symbols were last parsed into the index (ms epoch),
  // and when the last *full* repo scan completed. Used to auto-refresh
  // individual files whose on-disk mtime has moved past their indexed time
  // (e.g. changed by git/another editor/a script — anything outside this
  // session's edit/write/bash tool calls, which are already handled via
  // the tool_result hook) and to surface index staleness to the LLM.
  private fileIndexedAt = new Map<string, number>();
  private lastFullIndexAt = 0;

  constructor(private pi: ExtensionAPI) {}

  async init() {
    await this.runtime.init();

    this.pi.registerTool({
      name: "code_search",
      label: "Code Search",
      description:
        "Search the codebase for symbol DECLARATIONS (functions, classes, interfaces, types, enums, methods, variables, " +
        "constants, properties, imports) using real syntax parsing (tree-sitter), not text matching. Each result shows " +
        "file:line:col plus the symbol's kind. Results are syntax-parsed by default, so they normally can't come from " +
        "comments, string literals, log tags, or call sites — only actual declaration sites in the AST. The rare exception " +
        "is explicitly labeled: a result tagged '[regex-fallback]' used text matching instead (parser unavailable for that " +
        "file/language) and, like grep, CAN be a false positive from a comment or string — unlabeled results carry no such " +
        "risk. Example: code_search({query: \"Foo\", symbolType: \"class\"}) finds the one place `Foo` is declared even if " +
        "`Foo` also appears in 100 imports, mocks, constructor calls, and comments elsewhere in the repo. Line numbers stay " +
        "accurate even after edits: files changed via edit/write/bash in this session are auto-reflected, and any returned " +
        "file that changed on disk since it was last indexed (e.g. git pull/checkout, another editor) is transparently " +
        "re-checked before the result is returned — no manual /code-index needed for files that actually appear in results.",
      promptSnippet:
        "Find symbol declarations (not usages/comments/strings) by name, with type/language filters and structural precision grep can't offer",
      promptGuidelines: [
        "Prefer code_search over grep/bash when the goal is finding where something is DECLARED, especially for common " +
        "names that also show up as usages, imports, mocks, constructor calls, or in comments/strings — code_search only " +
        "matches real declaration sites, so it can't be fooled by text that merely looks like a reference.",
        "Prefer code_search over grep/bash for bulk/inventory queries (e.g. 'every class matching *ViewModel') or when " +
        "searching across multiple languages at once — one code_search call replaces several hand-written per-language regexes.",
        "Trust an exact-name code_search match with the expected kind (fn/mth/cls/ifc/typ/enum/var/const/prop/imp shown per " +
        "result) and NO '[regex-fallback]' tag — do not re-verify it with a follow-up grep; the kind tag already " +
        "disambiguates declarations from usages, which text search cannot do. If a result IS tagged '[regex-fallback]', " +
        "treat it like a grep hit (i.e. verify with a file read if it matters) since that one specific result could be a " +
        "comment/string false positive — this tag is rare and only affects files whose language grammar failed to parse.",
        "If a code_search query spans related kinds (e.g. Kotlin free functions and Java class methods for the same name), " +
        "pass symbolType as a comma list like 'function,method' in ONE call instead of calling code_search multiple times " +
        "with different symbolType values.",
        "Prefer grep/bash instead of code_search for searching plain text content itself (log messages, config values, " +
        "comments, arbitrary strings) or when you already know an exact unique text pattern and don't need symbol-kind awareness.",
        "code_search defaults to 30 results (cap 100). For very common names, narrow with symbolType/language rather than " +
        "raising the limit — or omit symbolType/language and use the kind tag already shown in results instead of filtering " +
        "via multiple separate calls.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description: "Symbol name to search for. Supports partial/fuzzy matches and '*' wildcards.",
        }),
        symbolType: Type.Optional(
          Type.String({
            description:
              "Filter by symbol kind(s): function, method, class, interface, type, enum, variable, const, property, import. " +
              "Comma-separate to match several in one call (e.g. 'function,method' covers both Kotlin-style free functions " +
              "and Java-style class methods for the same query — prefer this over calling code_search twice). " +
              "Omit entirely to search all kinds at once; each result already shows its kind, so omitting is usually fine " +
              "and cheaper than multiple filtered calls.",
          }),
        ),
        language: Type.Optional(
          Type.String({
            description:
              "Filter by language: typescript, tsx, javascript, python, rust, go, java, cpp, c, ruby, php, kotlin.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 30, hard cap 100). Narrow with symbolType/language instead of raising this for common names.", default: 30 }),
        ),
      }),
      execute: async (_toolCallId, params, _signal, onUpdate, ctx) => {
        // If an index build is in progress (e.g. the debounced background
        // index kicked off at session_start hasn't finished yet on a large
        // repo), wait for it instead of silently searching an empty index.
        if (this.indexBuildPromise) {
          onUpdate?.({ content: [{ type: "text", text: "Waiting for code index to finish building..." }], details: {} });
          await this.indexBuildPromise;
        } else if (this.index.all.length === 0) {
          onUpdate?.({ content: [{ type: "text", text: "Building code index..." }], details: {} });
          await this.buildIndex(ctx);
        }
        return await this.search(params, ctx);
      },
      renderCall: (args, theme) => {
        let text = theme.fg("toolTitle", theme.bold("code_search "));
        text += theme.fg("accent", args.query);
        if (args.symbolType) text += theme.fg("dim", ` type=${args.symbolType}`);
        if (args.language) text += theme.fg("dim", ` lang=${args.language}`);
        return new Text(text, 0, 0);
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

        const details = result.details as { symbols: SymbolInfo[]; total: number } | undefined;
        if (!details) return new Text(theme.fg("error", "No results"), 0, 0);

        const header = theme.fg("toolOutput", `${details.total} symbol(s) found`);
        if (!expanded || details.symbols.length === 0) return new Text(header, 0, 0);

        const lines = [header, ""];
        for (const s of details.symbols.slice(0, 15)) {
          const flag = s.source === "regex" ? theme.fg("warning", " [regex-fallback]") : "";
          lines.push(`  ${SYMBOL_ICONS[s.type]} ${theme.fg("accent", s.name)}  ${s.file}:${s.line}${flag}`);
        }
        if (details.symbols.length > 15) lines.push(`  ... and ${details.symbols.length - 15} more`);
        return new Text(lines.join("\n"), 0, 0);
      },
    });

    this.pi.registerCommand("code-search", {
      description: "Search codebase symbols interactively",
      getArgumentCompletions: () => null,
      handler: async (args, ctx) => {
        if (this.index.all.length === 0) {
          this.safeSetStatus(ctx, "🔎 indexing...");
          await this.buildIndex(ctx);
        }
        const query = args?.trim();
        if (!query) {
          await this.showPicker(ctx);
          return;
        }
        const result = await this.search({ query }, ctx);
        this.setTransientStatus(ctx, `🔎 ${result.content[0]?.text?.split("\n")[0] ?? "No results"}`);
        await this.showPicker(ctx, query);
      },
    });

    this.pi.registerCommand("code-index", {
      description: "Rebuild the code search index",
      handler: async (_args, ctx) => {
        this.safeSetStatus(ctx, "🔎 rebuilding index...");
        await this.buildIndex(ctx);
        this.setTransientStatus(ctx, `📚 ${this.index.all.length} symbols`);
      },
    });

    this.pi.on("session_start", async (_event, ctx) => {
      this.scheduleReindex(ctx);
    });

    this.pi.on("resources_discover", async (_event, ctx) => {
      this.scheduleReindex(ctx);
    });

    // Keep the index fresh as files change mid-session. Without this, a
    // stale index can confidently report wrong line numbers (or miss new
    // symbols entirely) after any edit — verified empirically to be a real
    // failure mode, not a theoretical one.
    this.pi.on("tool_result", async (event, ctx) => {
      if (event.isError) return;
      const input = event.input as { path?: string } | undefined;
      if ((event.toolName === "edit" || event.toolName === "write") && input?.path) {
        // We know exactly which file changed — reparse just that one file
        // immediately rather than waiting on the debounced full rebuild.
        this.reindexSingleFile(input.path, ctx).catch((err) =>
          debugLog("single-file reindex failed:", err),
        );
      } else if (event.toolName === "bash") {
        // bash can touch arbitrary files (git checkout, codegen, mv, rm, sed,
        // etc.) that we can't attribute to a specific path, so fall back to a
        // debounced full rebuild as a safety net.
        this.scheduleReindex(ctx);
      }
    });

    // Cancel any pending debounced reindex so we never fire it against a
    // stale ctx after the session/runtime has been torn down.
    this.pi.on("session_shutdown", async () => {
      if (this.reindexTimer) {
        clearTimeout(this.reindexTimer);
        this.reindexTimer = null;
      }
      if (this.statusTimer) {
        clearTimeout(this.statusTimer);
        this.statusTimer = null;
      }
    });
  }

  private scheduleReindex(ctx: ExtensionContext) {
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
    this.reindexTimer = setTimeout(() => {
      this.buildIndex(ctx).catch((err) => debugLog("index build failed:", err));
    }, 300);
  }

  private safeSetStatus(ctx: ExtensionContext, text: string) {
    try {
      ctx.ui.setStatus?.("code-search", text);
    } catch {
      // ctx may be stale (session replaced/reloaded/shutdown); ignore.
    }
  }

  /**
   * Show a message in the footer status line, then revert to the steady-state
   * index summary. All user-facing messaging goes here rather than into the
   * chat/editor area so searches never inject text the user has to clear.
   */
  private setTransientStatus(ctx: ExtensionContext, text: string, ms = 4000) {
    this.safeSetStatus(ctx, text);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.safeSetStatus(ctx, `📚 ${this.index.all.length} symbols`);
    }, ms);
  }

  private async buildIndex(ctx: ExtensionContext): Promise<void> {
    if (this.indexBuildPromise) return this.indexBuildPromise;
    const promise = this.buildIndexInternal(ctx);
    this.indexBuildPromise = promise;
    try {
      await promise;
    } finally {
      this.indexBuildPromise = null;
    }
  }

  /** Parse a single absolute file path into symbols, or null if unsupported/unreadable. */
  private async parseFileAbs(absPath: string): Promise<SymbolInfo[] | null> {
    const ext = absPath.split(".").pop() ?? "";
    const langKey = languageForExtension(ext);
    if (!langKey) return null;

    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      return null; // file may have been deleted
    }

    // Skip huge files (avoid pathological parse times)
    if (content.length > 1_500_000) return null;

    let symbols: SymbolInfo[] | null = null;
    if (this.runtime.available) {
      try {
        symbols = await this.runtime.parse(langKey, LANGUAGES[langKey], content);
      } catch {
        symbols = null;
      }
    }
    return symbols ?? regexFallback(langKey, content);
  }

  /**
   * Re-parse exactly one file (after an edit/write we know changed it) and
   * splice its symbols into the live index in place, without touching
   * anything else. Cheap (single-file parse) so it runs synchronously on
   * every edit rather than being debounced, keeping the index continuously
   * accurate for the file the agent is actively working on.
   */
  private async reindexSingleFile(path: string, ctx: ExtensionContext): Promise<void> {
    const absPath = resolve(ctx.cwd, path);
    const relPath = relative(ctx.cwd, absPath);

    const symbols = await this.parseFileAbs(absPath);
    this.fileIndexedAt.set(relPath, Date.now());

    // Remove old entries for this file from the flat list, then splice in
    // the fresh ones (or leave it removed if the file is now unsupported /
    // unreadable, e.g. deleted).
    this.index.all = this.index.all.filter((s) => s.file !== relPath);
    if (symbols && symbols.length > 0) {
      for (const s of symbols) s.file = relPath;
      this.index.all.push(...symbols);
      this.index.byFile.set(relPath, symbols);
    } else {
      this.index.byFile.delete(relPath);
      this.fileIndexedAt.delete(relPath);
    }
  }

  /**
   * Check whether any of the given (already relative) files have changed on
   * disk since we last parsed them, and transparently re-parse those that
   * have. Returns true if anything was refreshed, so the caller knows a
   * result set computed before this check may now be stale and should be
   * recomputed. Cheap in the common case (one fs.stat per unique candidate
   * file, no reparse) — only pays the reparse cost when something actually
   * changed outside this session's own edit/write/bash tool calls.
   */
  private async refreshStaleFiles(relPaths: Iterable<string>, ctx: ExtensionContext): Promise<boolean> {
    let refreshedAny = false;
    const unique = new Set(relPaths);
    await Promise.all(
      Array.from(unique).map(async (relPath) => {
        const absPath = resolve(ctx.cwd, relPath);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(absPath)).mtimeMs;
        } catch {
          // File no longer exists (deleted externally) — drop it from the index.
          this.index.all = this.index.all.filter((s) => s.file !== relPath);
          this.index.byFile.delete(relPath);
          this.fileIndexedAt.delete(relPath);
          refreshedAny = true;
          return;
        }
        const indexedAt = this.fileIndexedAt.get(relPath) ?? 0;
        if (mtimeMs > indexedAt) {
          await this.reindexSingleFile(relPath, ctx);
          refreshedAny = true;
        }
      }),
    );
    return refreshedAny;
  }

  private async buildIndexInternal(ctx: ExtensionContext) {
    this.isIndexing = true;
    this.safeSetStatus(ctx, "🔎 indexing...");

    const start = Date.now();
    const newIndex: SearchIndex = { all: [], byFile: new Map() };
    const newFileIndexedAt = new Map<string, number>();

    try {
      const files = await glob(allGlobPatterns(), {
        cwd: ctx.cwd,
        ignore: IGNORE_PATTERNS,
        absolute: true,
        nodir: true,
      });

      for (const file of files) {
        const symbols = await this.parseFileAbs(file);
        if (!symbols) continue;

        const relPath = relative(ctx.cwd, file);
        for (const s of symbols) {
          s.file = relPath;
        }

        newIndex.all.push(...symbols);
        newIndex.byFile.set(relPath, symbols);
        newFileIndexedAt.set(relPath, Date.now());
      }
    } finally {
      this.index = newIndex;
      this.fileIndexedAt = newFileIndexedAt;
      this.lastFullIndexAt = Date.now();
      this.isIndexing = false;
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      // Status line only: console.* would be echoed into the transcript above
      // the editor, which is noise the user has to scroll past.
      this.setTransientStatus(ctx, `📚 ${newIndex.all.length} symbols in ${secs}s`);
      debugLog(`indexed ${newIndex.all.length} symbols in ${secs}s`);
    }
  }

  /**
   * Naive character-subsequence matching ("does text contain these chars
   * anywhere, in order") is what IDEs use for fuzzy symbol search, but only
   * because they also require the query to align with camelCase/word-boundary
   * humps for anything beyond a couple of characters. Without that
   * constraint, subsequence matching has terrible precision on identifiers:
   * a long descriptive name (test methods especially, e.g.
   * "whenOnCreate_sendsTimePickerModuleVisibleEvent") will contain almost
   * any short query's letters in order purely by chance. That flooded
   * real search results with noise on large codebases.
   *
   * Instead: extract the initials of each camelCase/snake_case/PascalCase
   * "hump" in the name (handleEvent -> "he", TrackOrderViewModel -> "tovm",
   * handle_click_event -> "hce") and only treat it as a fuzzy hit if the
   * query is a subsequence of those initials. This mirrors how VS Code /
   * IntelliJ "Go to Symbol" fuzzy search behaves and rejects the vast
   * majority of coincidental matches while still supporting abbreviations.
   */
  private humpInitials(name: string): string {
    const humps = name.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [name];
    return humps.map((h) => h[0]).join("").toLowerCase();
  }

  /** Is `query` a subsequence of `text`'s characters, in order? */
  private isSubsequence(text: string, query: string): boolean {
    let p = 0;
    for (let i = 0; i < text.length && p < query.length; i++) {
      if (text[i] === query[p]) p++;
    }
    return p === query.length;
  }

  private static readonly STRONG_MIN_SCORE = 200; // "contains" and above
  private static readonly MAX_WEAK_RESULTS = 5; // hard cap on hump-fuzzy matches, regardless of requested limit
  private static readonly MAX_LIMIT = 100;
  private static readonly DEFAULT_LIMIT = 30;

  private score(name: string, query: string): number {
    const n = name.toLowerCase();
    if (n === query) return 1000;
    if (n.startsWith(query)) return 500;
    if (n.includes(query)) return 200;
    // Weak fallback: match against camelCase/word-boundary initials only
    // (e.g. query "toe" matches "TrackOrderEvent" via humps "t","o","e"),
    // not raw subsequence of the whole name. See humpInitials() above for why.
    if (query.length >= 2 && this.isSubsequence(this.humpInitials(n), query)) return 50;
    return 0;
  }

  /** Pure, synchronous scoring pass over the current in-memory index. */
  private computeMatches(params: { query: string; symbolType?: string; language?: string; limit?: number }) {
    const rawQuery = params.query.trim();
    const query = rawQuery.toLowerCase();
    const limit = Math.max(1, Math.min(params.limit ?? CodeSearchExtension.DEFAULT_LIMIT, CodeSearchExtension.MAX_LIMIT));
    const isWildcard = query.includes("*");
    const wildcardRe = isWildcard ? new RegExp(`^${query.split("*").map(escapeRegExp).join(".*")}$`, "i") : null;

    let candidates = this.index.all;
    if (params.symbolType) {
      const wantedTypes = new Set(
        params.symbolType
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      );
      candidates = candidates.filter((s) => wantedTypes.has(s.type));
    }
    if (params.language) candidates = candidates.filter((s) => s.language === params.language);

    let scored = candidates
      .map((s) => ({
        symbol: s,
        score: wildcardRe ? (wildcardRe.test(s.name) ? 300 : 0) : this.score(s.name, query),
      }))
      .filter((r) => r.score > 0);

    // Always keep strong matches; cap weak hump-abbreviation matches to a
    // small fixed number regardless of how many exist or what limit was
    // requested, so they can only ever supplement (never flood) results.
    if (!wildcardRe) {
      const strong = scored.filter((r) => r.score >= CodeSearchExtension.STRONG_MIN_SCORE);
      const weak = scored
        .filter((r) => r.score < CodeSearchExtension.STRONG_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, CodeSearchExtension.MAX_WEAK_RESULTS);
      scored = [...strong, ...weak];
    }

    scored.sort((a, b) => b.score - a.score || a.symbol.name.length - b.symbol.name.length);

    const total = scored.length;
    const matched = scored.slice(0, limit).map((r) => r.symbol);
    return { rawQuery, total, matched };
  }

  private async search(
    params: { query: string; symbolType?: string; language?: string; limit?: number },
    ctx: ExtensionContext,
  ) {
    let { rawQuery, total, matched } = this.computeMatches(params);

    // Auto-heal: if any file among the results we're about to return has
    // changed on disk since we last parsed it (git pull, branch switch,
    // another editor, a codegen script — anything outside this session's
    // own edit/write/bash tool calls, which are already handled elsewhere),
    // re-parse just that file and recompute the match set once. Cheap when
    // nothing is stale (one fs.stat per unique result file, no reparse).
    const candidateFiles = matched.map((s) => s.file);
    const refreshed = candidateFiles.length > 0 ? await this.refreshStaleFiles(candidateFiles, ctx) : false;
    if (refreshed) {
      ({ rawQuery, total, matched } = this.computeMatches(params));
    }

    // Compact, grep-like output: one line per match, no blank-line file
    // headers, short ASCII type tags. Grouping by file saved little space
    // in practice (most queries have ~1 match per file) and cost an extra
    // line + blank line per unique file; a flat list is smaller and easier
    // for the model to scan/sort mentally.
    const lines: string[] = [];
    if (total === 0) {
      lines.push(`No symbols found matching "${rawQuery}".`);
      if (this.index.all.length === 0) {
        lines.push("Index is empty — it may still be building. Try again shortly or run /code-index.");
      }
    } else {
      const shown = matched.length;
      lines.push(
        `${total} match(es) for "${rawQuery}"${shown < total ? ` (showing ${shown}; add symbolType/language or refine query for more)` : ""}:`,
      );
      // Only annotate the exceptional case (regex fallback). AST-derived
      // results are the default/trusted path and stay unannotated to keep
      // output compact — silence implies "ast", an explicit tag flags the
      // lower-confidence exception.
      let hasRegexFallback = false;
      for (const s of matched) {
        const tag = s.source === "regex" ? " [regex-fallback, unverified: may match comments/strings]" : "";
        if (s.source === "regex") hasRegexFallback = true;
        lines.push(`${s.file}:${s.line}:${s.column}: ${SYMBOL_TAGS[s.type]} ${s.name}${tag}`);
      }
      if (hasRegexFallback) {
        lines.push(
          "Note: [regex-fallback] results used text matching (grammar unavailable/parse failed for that file), " +
            "not syntax parsing — unlike other results here, they CAN be false positives from comments or string literals. " +
            "Verify those specific ones by reading the file if it matters.",
        );
      }
    }

    // Soft nudge, shown only when the last *full* repo scan is old enough
    // that newly-added files/symbols elsewhere in the repo could exist
    // without this index knowing about them yet. Per-file mtime refresh
    // above catches changes to files that already appear in results; it
    // can't discover a brand-new file/symbol it never knew to look at —
    // only a full rescan can. Threshold is minutes, not seconds, to avoid
    // nagging on every call in a normal session.
    const indexAgeMs = this.lastFullIndexAt ? Date.now() - this.lastFullIndexAt : null;
    const STALE_FULL_INDEX_MS = 10 * 60 * 1000;
    if (indexAgeMs !== null && indexAgeMs > STALE_FULL_INDEX_MS) {
      const mins = Math.round(indexAgeMs / 60000);
      lines.push(
        `(Index last fully rebuilt ${mins}m ago — files changed by this session are already reflected above, but if you suspect other changes since then (git pull/checkout, external scripts), run /code-index to be sure.)`,
      );
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { symbols: matched, total, query: rawQuery },
    };
  }

  private async showPicker(ctx: ExtensionContext, initialQuery = "") {
    if (!ctx.hasUI) return;

    let symbols = this.index.all;
    if (initialQuery) {
      const q = initialQuery.toLowerCase();
      symbols = symbols
        .filter((s) => this.score(s.name, q) > 0)
        .sort((a, b) => this.score(b.name, q) - this.score(a.name, q));
    }

    if (symbols.length === 0) {
      this.setTransientStatus(ctx, "🔎 no symbols indexed");
      return;
    }

    // select() takes plain strings; encode file:line in the label itself.
    const labels = symbols
      .slice(0, 200)
      .map((s) => `${SYMBOL_ICONS[s.type]} ${s.name}  (${s.type})  ${s.file}:${s.line}`);

    const choice = await ctx.ui.select("Select a symbol", labels);
    if (choice) {
      this.setTransientStatus(ctx, `🔎 ${choice}`);
    }
  }
}

/**
 * Diagnostics are opt-in via PI_CODE_SEARCH_DEBUG=1. Unconditional console.*
 * output shows up in the transcript above the editor, so all normal messaging
 * goes to the footer status line instead.
 */
function debugLog(...args: unknown[]): void {
  if (!process.env.PI_CODE_SEARCH_DEBUG) return;
  console.warn("[code-search]", ...args);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function (pi: ExtensionAPI) {
  const ext = new CodeSearchExtension(pi);
  return ext.init();
}

export type { SymbolInfo, SymbolType };
