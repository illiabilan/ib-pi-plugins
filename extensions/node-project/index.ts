/**
 * node_project — npm / tsc workflow tool for Pi.
 *
 * Replaces the long, error-prone npm/npx/tsc bash pipelines the agent otherwise
 * retypes from memory on every task, e.g.:
 *
 *   npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
 *     --skipLibCheck --esModuleInterop --allowImportingTsExtensions a.ts b.ts
 *        -> { action: "typecheck", files: ["a.ts", "b.ts"] }
 *
 *   npm install --no-save typescript 2>&1 | tail -2   (then npm uninstall --no-save)
 *        -> { action: "install", packages: ["typescript"], noSave: true }
 *
 *   npm install web-tree-sitter@0.20.8 tree-sitter-wasms --silent 2>&1 | tail -3
 *        -> { action: "install", packages: ["web-tree-sitter@0.20.8", "tree-sitter-wasms"] }
 *
 *   npm test 2>&1 | tail -30   /   npm run build 2>&1 | tail -20
 *        -> { action: "test" } / { action: "build" }   (failures-first, summary parsed)
 *
 *   cat package.json | jq .scripts ; node -v ; npm -v ; ls node_modules
 *        -> { action: "info" }
 *
 * Every result states which tsc/tsconfig/flags were actually used, so the caller can
 * tell a real code error from a broken environment.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Max diagnostics echoed back verbatim; the rest collapse into per-file counts. */
const MAX_DIAGNOSTICS = 40;
/** Max npm warn lines echoed back. */
const MAX_WARNINGS = 5;
/** Max npm error lines echoed back on a failed install. */
const MAX_ERROR_LINES = 12;
/** Tail size used when a test/build failure has no recognizable framework summary. */
const MAX_TAIL_LINES = 40;
/** Cap on characters returned for outputMode:"raw". */
const MAX_RAW_CHARS = 12_000;
/** Cap on bytes captured from a child process. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
/** npx spec used when no local typescript is installed. Pinned to 5.x: `npx tsc` alone
 *  resolves the deprecated stub `tsc` package (which never compiles), and typescript@7
 *  changes diagnostic codes/exit codes. */
const NPX_TS_SPEC = "typescript@5";

/** Default flags for a single-file TS check of a Pi extension (no tsconfig present). */
const DEFAULT_TSC_FLAGS = [
  "--noEmit",
  "--target",
  "es2022",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
  "--skipLibCheck",
  "--esModuleInterop",
  "--allowImportingTsExtensions",
];

const DEFAULT_TIMEOUTS: Record<string, number> = {
  install: 300,
  typecheck: 180,
  test: 600,
  build: 600,
  outdated: 120,
  info: 60,
};

const actionEnum = ["install", "typecheck", "test", "build", "outdated", "info"] as const;
type Action = (typeof actionEnum)[number];

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "install=npm install (summary only); typecheck=tsc --noEmit with correct flags (diagnostics only); " +
        "test/build=run the package.json script, failures first; outdated=npm outdated; " +
        "info=resolved project facts (scripts, deps, node/npm/tsc versions, node_modules presence)",
    },
  ),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Directory to run in (absolute, or relative to cwd). Defaults to cwd. The nearest package.json/tsconfig.json " +
        "at or above this directory is discovered automatically.",
    }),
  ),
  packages: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'For install: package specs, e.g. ["web-tree-sitter@0.20.8", "tree-sitter-wasms"]. Omit to install from ' +
        "package.json. For info: report the installed version of these specific packages instead of `npm ls <pkg>`.",
    }),
  ),
  dev: Type.Optional(Type.Boolean({ description: "install as devDependencies (--save-dev). Default false." })),
  noSave: Type.Optional(
    Type.Boolean({
      description:
        "install with --no-save (temporary tool, package.json untouched). The result includes the exact cleanup " +
        "command. Default false.",
    }),
  ),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "For typecheck: check only these files (relative to projectDir or absolute). Omit to check the whole " +
        "project via its tsconfig.json.",
    }),
  ),
  tsconfig: Type.Optional(
    Type.String({
      description:
        "For typecheck: explicit tsconfig path. Omit to auto-discover the nearest tsconfig.json; if none exists, " +
        "Pi-extension defaults are used (target es2022, module esnext, moduleResolution bundler, skipLibCheck, " +
        "esModuleInterop, allowImportingTsExtensions, noEmit).",
    }),
  ),
  script: Type.Optional(
    Type.String({
      description:
        'For test/build: package.json script name to run when it is not literally "test"/"build" (e.g. "test:unit").',
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Extra CLI args appended verbatim, e.g. ["--legacy-peer-deps"] for install or ["--strict"] for typecheck.',
    }),
  ),
  outputMode: Type.Optional(
    Type.Union([Type.Literal("diagnostics"), Type.Literal("summary"), Type.Literal("raw")], {
      description:
        "diagnostics (default) = only what is actionable (tsc diagnostics / npm resolution summary / test " +
        "failures); summary = one-to-few lines, counts only; raw = also append the (capped) raw child output. " +
        "Use raw only when the parsed output looks wrong or incomplete.",
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: "Kill the child process after this many seconds (defaults: install 300, typecheck 180, test/build 600).",
    }),
  ),
});

type Params = Static<typeof schema>;

type RunResult = {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
  timedOut: boolean;
  /** True when the agent/user aborted the turn while the child was running. */
  aborted: boolean;
  spawnError?: string;
  truncated: boolean;
};

/* ------------------------------------------------------------------ helpers */

function shellish(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/[\s"'$*?|<>&;()]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: process.env.CI ?? "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      return resolve({
        command: shellish(cmd, args),
        code: null,
        stdout: "",
        stderr: "",
        combined: "",
        durationMs: Date.now() - started,
        timedOut: false,
        aborted: false,
        spawnError: e?.message ?? String(e),
        truncated: false,
      });
    }

    let out = "";
    let err = "";
    let combined = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (chunk: string, which: "out" | "err") => {
      if (combined.length > MAX_CAPTURE_BYTES) {
        truncated = true;
        return;
      }
      if (which === "out") out += chunk;
      else err += chunk;
      combined += chunk;
    };

    child.stdout?.on("data", (d) => append(String(d), "out"));
    child.stderr?.on("data", (d) => append(String(d), "err"));

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // SIGKILL fallback if it ignores SIGTERM (npm scripts spawning children do).
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        command: shellish(cmd, args),
        code,
        stdout: out,
        stderr: err,
        combined,
        durationMs: Date.now() - started,
        timedOut,
        aborted: signal?.aborted === true && !timedOut,
        spawnError,
        truncated,
      });
    };

    child.on("error", (e: any) => finish(null, e?.message ?? String(e)));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Walk up from `start` looking for `name`; returns the containing dir or null.
 *
 * The walk stops at $HOME when `start` is inside $HOME: without that bound, a stray
 * ~/package.json (or ~/tsconfig.json) would silently become "the project", and
 * `npm install` would then run in the user's home directory instead of the intended one.
 */
function findUp(start: string, name: string): string | null {
  const home = homedir();
  const bounded = start === home || start.startsWith(home + sep);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, name))) return dir;
    if (bounded && dir === home) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(path: string): any | null {
  try {
    // Tolerate trailing commas / // comments (tsconfig is JSONC).
    const raw = readFileSync(path, "utf8");
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * Locate the type packages that pi provides ambiently to extensions
 * (@earendil-works/*, typebox, @types/node). Extensions are loaded by jiti from
 * arbitrary directories that usually have no node_modules, so a plain tsc run
 * reports every pi import as TS2307 and silently checks nothing real.
 */
function findPiTypeRoots(): { nodeModules: string; agentPkg: string | null } | null {
  const candidates: string[] = [];
  try {
    // @ts-ignore - available under jiti/ESM at runtime
    const resolved = import.meta.resolve?.("@earendil-works/pi-tui");
    if (typeof resolved === "string") candidates.push(fileURLToPath(resolved));
  } catch {
    /* fall through to path probing */
  }
  const argvPi = process.argv[1];
  if (argvPi) candidates.push(argvPi);

  for (const candidate of candidates) {
    // .../pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js -> .../node_modules
    const marker = `${sep}node_modules${sep}`;
    const idx = candidate.lastIndexOf(marker);
    if (idx >= 0) {
      const nm = candidate.slice(0, idx + marker.length - 1);
      if (existsSync(join(nm, "@earendil-works")) || existsSync(join(nm, "typebox"))) {
        const agentDir = join(dirname(nm), "package.json");
        const agentPkg = existsSync(agentDir) ? dirname(nm) : null;
        return { nodeModules: nm, agentPkg };
      }
    }
    // /opt/homebrew/bin/pi (symlink) -> walk up for a node_modules with our markers
    const holder = findUp(dirname(candidate), join("node_modules", "typebox"));
    if (holder) {
      const nm = join(holder, "node_modules");
      return { nodeModules: nm, agentPkg: existsSync(join(holder, "package.json")) ? holder : null };
    }
  }
  return null;
}

/* -------------------------------------------------------- tsc diagnostics */

type Diag = {
  file: string | null;
  line: number | null;
  col: number | null;
  severity: string;
  code: string;
  message: string;
  /** First indented follow-up line, kept only when the headline message is uninformative on its own. */
  detail?: string;
};

const DIAG_RE = /^(?:(.*?)\((\d+),(\d+)\):\s*)?(error|warning|message)\s+(TS\d+):\s*(.*)$/;
/** tsc's `--pretty` layout (`src/x.ts:1:14 - error TS2322: ...`), used when a build script forces it. */
const DIAG_RE_PRETTY = /^(.*?):(\d+):(\d+)\s+-\s+(error|warning|message)\s+(TS\d+):\s*(.*)$/;

/** Parse `--pretty false` tsc output into structured diagnostics. Also used for build
 *  scripts, which very often just run tsc. */
function parseDiagnostics(text: string, baseDir: string): Diag[] {
  const diags: Diag[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\s/.test(line)) {
      // Indented continuation. Keep the first one only when the headline carries no information
      // on its own ("No overload matches this call.", "...because:").
      const prev = diags[diags.length - 1];
      if (prev && prev.detail === undefined && /No overload matches this call\.|:$/.test(prev.message)) {
        prev.detail = line.trim().slice(0, 200);
      }
      continue;
    }
    const trimmed = line.trim();
    const m = DIAG_RE.exec(trimmed) ?? DIAG_RE_PRETTY.exec(trimmed);
    if (!m) continue;
    const [, file, ln, col, severity, code, message] = m;
    diags.push({
      file: file ? normalizePath(file, baseDir) : null,
      line: ln ? Number(ln) : null,
      col: col ? Number(col) : null,
      severity,
      code,
      message: message.trim(),
    });
  }
  return diags;
}

/** tsc prints paths relative to its cwd; re-anchor them to projectDir so the caller
 *  gets `index.ts` or an absolute path, never `../../../Users/...`. */
function normalizePath(p: string, baseDir: string): string {
  const abs = isAbsolute(p) ? p : resolvePath(baseDir, p);
  const rel = relative(baseDir, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

/** Per-diagnostic line cap: deep generic mismatches can produce very long single messages. */
const MAX_DIAG_CHARS = 500;

function fmtDiag(d: Diag): string {
  const loc = d.file ? `${d.file}:${d.line ?? 0}:${d.col ?? 0}` : "<project>";
  const sev = d.severity === "error" ? "" : `${d.severity} `;
  const line = `${loc} ${sev}${d.code} ${d.message}${d.detail ? ` [${d.detail}]` : ""}`;
  return line.length > MAX_DIAG_CHARS ? `${line.slice(0, MAX_DIAG_CHARS)}... [message truncated]` : line;
}

/** Bare-specifier "cannot find module" diagnostics are environment problems (missing
 *  node_modules), not code bugs — relative ones (./x.ts) are real code bugs. */
const UNRESOLVED_CODES = new Set(["TS2307", "TS2591", "TS7016", "TS2688", "TS2792"]);

function isEnvUnresolved(d: Diag): string | null {
  if (!UNRESOLVED_CODES.has(d.code)) return null;
  const m = /'([^']+)'/.exec(d.message);
  const spec = m?.[1];
  if (!spec) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null; // real missing file
  return spec;
}

/* --------------------------------------------------- npm output summarizing */

function uniq(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

/** "pkg@1.2.3" -> "pkg", "@scope/pkg@1.2.3" -> "@scope/pkg". */
function pkgName(spec: string): string {
  return spec.replace(/(?!^)@[^@/]*$/, "");
}

function stripNpmPrefix(line: string): string {
  return line.replace(/^npm (error|warn|notice|ERR!|WARN)\s*/i, "").trim();
}

/**
 * npm dumps a full JS stack trace and object dump for network failures. Keep only the lines that
 * identify the failure (code/errno/404/ERESOLVE/reason) and drop stack frames and object-property
 * dumps, most-informative-first.
 */
function pickNpmErrorLines(lines: string[]): string[] {
  const cleaned = uniq(
    lines
      .filter((l) => /^npm (error|ERR!)/i.test(l.trim()))
      .map((l) => stripNpmPrefix(l.trim()))
      .filter(
        (l) =>
          l &&
          !/^A complete log of this run/.test(l) &&
          !/^at\s/.test(l) && // stack frames
          !/^[{}]/.test(l) &&
          !/^[a-zA-Z_$][\w$]*:\s.*,$/.test(l) && // object-property dump lines
          !/^\.\.\.$/.test(l),
      ),
  );
  const IMPORTANT = /^(code|errno|syscall)\b|^404|ERESOLVE|EACCES|EPERM|ENOSPC|Could not resolve|Conflicting peer|FetchError|network|Invalid|Unsupported engine|notarget|No matching version/i;
  const important = cleaned.filter((l) => IMPORTANT.test(l));
  const rest = cleaned.filter((l) => !IMPORTANT.test(l));
  return [...important, ...rest].slice(0, MAX_ERROR_LINES);
}

function classifyNpmFailure(text: string): string | null {
  if (/E404|404 Not Found/.test(text)) return "package or version does not exist (E404)";
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|offline mode/i.test(text))
    return "network unreachable / registry offline";
  if (/ERESOLVE/.test(text)) return 'peer dependency conflict (ERESOLVE) — retry with extraArgs:["--legacy-peer-deps"]';
  if (/EACCES|EPERM/.test(text)) return "permission denied writing to node_modules or the npm cache";
  if (/ENOSPC/.test(text)) return "no disk space left";
  if (/ELSPROBLEMS|EUSAGE|ENOLOCK/.test(text)) return "npm usage/lockfile problem";
  return null;
}

/* ----------------------------------------------------- test/build parsing */

type TestSummary = { framework: string; lines: string[]; failures: string[] };

/**
 * Attach the first nearby reason line (assertion message / expected-vs-actual) to each failure
 * headline. Without it the agent has the failing test NAME but not WHY, and immediately re-runs with
 * outputMode:"raw" — observed in a real trace, so the reason is now included up front.
 */
function withReasons(lines: string[], headlineRe: RegExp, limit: number): string[] {
  const REASON = /(Error|AssertionError|expect|Expected|Received|actual|expected|Timeout|throw)/;
  // Reporters (node:test's spec reporter especially) print each failure headline twice: once inline
  // and once in a trailing "failing tests:" block with the details. Key on the headline and keep the
  // richer copy so the list is not duplicated.
  const byHeadline = new Map<string, string>();
  for (let i = 0; i < lines.length && byHeadline.size <= limit; i++) {
    const line = lines[i]!;
    if (!headlineRe.test(line)) continue;
    const headline = line.trim();
    const reasonParts: string[] = [];
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      // Stop at the next failure headline: continuing past it attached one test's assertion
      // message to a different test (caught empirically with vitest's compact list output).
      if (headlineRe.test(lines[j]!)) break;
      const cand = lines[j]!.trim();
      // Skip stack frames, source-excerpt pointers and bare diff headers ("- Expected").
      if (!cand || /^at\s/.test(cand) || /^❯\s/.test(cand) || /^[-+]\s*(Expected|Received)$/.test(cand)) continue;
      if (REASON.test(cand)) {
        reasonParts.push(cand.slice(0, 200));
        // Frameworks split the reason across two lines ("expect(received).toBe(expected)" then
        // "Expected: 5 / Received: 4"); keep at most two so the value diff is visible.
        if (reasonParts.length >= 2) break;
      }
    }
    const reason = reasonParts.join(" | ");
    const entry = `${headline}${reason ? ` — ${reason}` : ""}`;
    const prev = byHeadline.get(headline);
    if (prev === undefined || (!prev.includes(" — ") && reason)) byHeadline.set(headline, entry);
  }
  return [...byHeadline.values()].slice(0, limit);
}

function parseTestOutput(text: string): TestSummary | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split(/\r?\n/);
  const pick = (re: RegExp, limit = 6) => lines.filter((l) => re.test(l)).map((l) => l.trim()).slice(0, limit);

  // vitest
  const vitestSummary = pick(/^\s*(Test Files|Tests|Duration)\s{2,}/);
  if (vitestSummary.length) {
    // vitest lists each failure twice: a compact "× name 3ms" line (no reason) and a
    // "FAIL file > name" block followed by the assertion. Prefer the latter; fall back to the
    // compact lines only when no FAIL block was printed.
    const failBlocks = withReasons(lines, /^\s*FAIL\s/, 25);
    return {
      framework: "vitest",
      lines: vitestSummary,
      failures: failBlocks.length ? failBlocks : withReasons(lines, /^\s*(✗|×)\s/, 25),
    };
  }
  // jest
  const jestSummary = pick(/^(Tests|Test Suites|Snapshots):\s/);
  if (jestSummary.length) {
    return {
      framework: "jest",
      lines: jestSummary,
      failures: uniq([...withReasons(lines, /^\s*●\s+(?!Console)/, 25), ...pick(/^FAIL\s/, 10)]),
    };
  }
  // node:test, TAP reporter
  const nodeTap = pick(/^#\s*(tests|pass|fail|cancelled|skipped)\s/);
  if (nodeTap.length) {
    return { framework: "node:test (tap)", lines: nodeTap, failures: withReasons(lines, /^not ok\s/, 25) };
  }
  // node:test, default "spec" reporter (node >= 20): "ℹ tests 3" / "ℹ fail 2" / "✖ name (1ms)".
  // Matched before the generic tails so a failing `node --test` run does not fall through to a
  // 40-line stack-trace dump (caught empirically on a real node:test project).
  const nodeSpec = pick(/^\s*ℹ\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s/, 8);
  if (nodeSpec.length) {
    return {
      framework: "node:test",
      lines: nodeSpec.filter((l) => !/^ℹ\s*(cancelled|skipped|todo|suites)\s+0$/.test(l)),
      failures: withReasons(lines, /^\s*✖\s(?!failing tests:)/, 25),
    };
  }
  // mocha / tap
  const mochaSummary = pick(/^\s*\d+ (passing|failing|pending)\b/);
  if (mochaSummary.length) {
    return {
      framework: "mocha",
      lines: mochaSummary,
      failures: withReasons(lines, /^\s*\d+\)\s/, 25),
    };
  }
  return null;
}

function tail(text: string, n: number): string {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-n).join("\n");
}

function capRaw(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (clean.length <= MAX_RAW_CHARS) return clean;
  return (
    clean.slice(0, MAX_RAW_CHARS) + `\n... [raw output truncated at ${MAX_RAW_CHARS} chars of ${clean.length}]`
  );
}

/* ------------------------------------------------------------------- tool */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "node_project",
    label: "Node Project",
    description: `Run npm/tsc workflows (install, typecheck, test, build, outdated, info) and get back only the actionable part of the output instead of the npm/tsc firehose.

Replaces these bash idioms:
  npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --esModuleInterop --allowImportingTsExtensions a.ts
      -> {"action":"typecheck","files":["a.ts"]}            (flags are built in; nothing to remember)
  npm install pkg@1.2.3 --silent 2>&1 | tail -3            -> {"action":"install","packages":["pkg@1.2.3"]}
  npm install --no-save typescript ... npm uninstall --no-save typescript
                                                            -> {"action":"install","packages":["typescript"],"noSave":true}
  npm test 2>&1 | tail -30 / npm run build 2>&1 | tail -20 -> {"action":"test"} / {"action":"build"}
  cat package.json | jq .scripts; node -v; npm -v; ls node_modules -> {"action":"info"}

typecheck returns ONLY diagnostics as "file:line:col TSxxxx message" (deduped, capped at ${MAX_DIAGNOSTICS}) plus a count; a clean run is one line. It uses the project's tsconfig.json when one exists (or extends it when 'files' is given) and Pi-extension defaults otherwise, and always reports which in a "config:" line.
Note: plain \`npx tsc\` in bash resolves the deprecated stub \`tsc\` npm package and never compiles anything — node_project resolves a local node_modules/.bin/tsc first and falls back to \`npx -p ${NPX_TS_SPEC}\`, reported in a "tsc:" line.

Each result also reports the exact command it ran ("cmd:") so it can be reproduced or escalated to bash if needed.`,
    promptSnippet: "Run npm install / tsc typecheck / npm test / npm run build with parsed, capped output",
    promptGuidelines: [
      "Use node_project instead of bash for npm install, npx tsc, npm test, npm run build, npm outdated, and for reading package.json scripts — it returns only diagnostics/summaries, so no `| tail -3` or `--silent` is needed.",
      "Use node_project {action:'typecheck', files:[...]} to type-check TypeScript instead of retyping tsc flags in bash: the correct Pi-extension flags (target es2022, module esnext, moduleResolution bundler, skipLibCheck, esModuleInterop, allowImportingTsExtensions, noEmit) are built in, and an existing tsconfig.json is used instead of them.",
      "Read node_project's 'config:', 'tsc:' and 'types:' lines before trusting a typecheck result: types:pi-runtime-fallback means @earendil-works/*, typebox and node types were resolved from pi's own installation because the directory has no node_modules — real code errors are still reported, but a project-specific dependency version may differ from what the extension actually runs against.",
      "Treat node_project's 'unresolved imports' section as an environment problem (missing node_modules), not a code bug; run node_project {action:'install'} in that directory before reading those as real errors. Diagnostics for relative specifiers (./x.ts) ARE real code bugs and are reported as normal errors.",
      "Never report a typecheck as clean when node_project prints '⚠ INCOMPLETE CHECK' (details.checkComplete=false): unresolved imports make everything from them `any`, so real type errors are invisible. Install the dependencies and re-run instead.",
      "Only 'node_project ... ✓ typecheck clean' with no unresolved-imports section means the files really type-check.",
      "Use node_project {action:'install', noSave:true} for a throwaway tool (e.g. typescript) and run the printed cleanup command afterwards; use dev:true for real devDependencies.",
      "If node_project's parsed output looks wrong, incomplete, or a test failure has no recognizable framework summary, re-run the same call with outputMode:'raw' before falling back to bash.",
      "Do not use node_project for arbitrary shell work (git, node one-liners, running a built binary, npm commands other than the six actions) — use bash for those.",
    ],
    parameters: schema,
    async execute(_toolCallId, params: Params, signal, onUpdate, ctx: ExtensionContext) {
      const action = params.action as Action;
      const outputMode = params.outputMode ?? "diagnostics";
      const cwdBase = ctx.cwd ?? process.cwd();
      const requestedDir = params.projectDir
        ? isAbsolute(params.projectDir)
          ? params.projectDir
          : resolvePath(cwdBase, params.projectDir)
        : cwdBase;

      const fin = (text: string, details: Record<string, unknown>, isError = false) => ({
        content: [{ type: "text" as const, text }],
        details: { action, projectDir: requestedDir, ...details },
        isError,
      });

      if (!existsSync(requestedDir)) {
        return fin(`Error: directory not found: ${requestedDir}`, { error: "missing-dir" }, true);
      }

      const pkgDir = findUp(requestedDir, "package.json");
      const pkgJsonPath = pkgDir ? join(pkgDir, "package.json") : null;
      const pkgJson = pkgJsonPath ? readJson(pkgJsonPath) : null;
      const timeoutMs = Math.max(1, params.timeoutSec ?? DEFAULT_TIMEOUTS[action] ?? 300) * 1000;
      const extra = params.extraArgs ?? [];

      onUpdate?.({
        content: [{ type: "text", text: `node_project ${action} in ${requestedDir}...` }],
        details: { action, projectDir: requestedDir },
      });

      /* ------------------------------------------------------------ info */
      if (action === "info") {
        const lines: string[] = [];
        const nm = pkgDir ? join(pkgDir, "node_modules") : null;
        lines.push(`projectDir: ${requestedDir}`);
        if (pkgJsonPath && pkgJson) {
          lines.push(
            `package.json: ${pkgJsonPath} (${pkgJson.name ?? "<unnamed>"}@${pkgJson.version ?? "?"}` +
              `${pkgJson.type ? `, type=${pkgJson.type}` : ""})`,
          );
          const scripts = pkgJson.scripts ?? {};
          const scriptNames = Object.keys(scripts);
          lines.push(
            scriptNames.length
              ? `scripts: ${scriptNames.map((s) => `${s}="${String(scripts[s]).slice(0, 80)}"`).join(", ")}`
              : "scripts: (none)",
          );
          const deps = Object.keys(pkgJson.dependencies ?? {});
          const devDeps = Object.keys(pkgJson.devDependencies ?? {});
          lines.push(`dependencies (${deps.length}): ${deps.join(", ") || "-"}`);
          lines.push(`devDependencies (${devDeps.length}): ${devDeps.join(", ") || "-"}`);
        } else {
          lines.push(`package.json: NOT FOUND at or above ${requestedDir}`);
        }
        lines.push(
          `node_modules: ${nm && existsSync(nm) ? nm : "absent (run node_project {action:'install'} first)"}`,
        );
        const lock = pkgDir
          ? ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].find((f) =>
              existsSync(join(pkgDir, f)),
            )
          : undefined;
        lines.push(`lockfile: ${lock ?? "none"}`);
        const tsconfigDir = findUp(requestedDir, "tsconfig.json");
        lines.push(`tsconfig.json: ${tsconfigDir ? join(tsconfigDir, "tsconfig.json") : "none (typecheck uses Pi-extension defaults)"}`);
        const ts = resolveTsc(requestedDir, pkgDir);
        lines.push(`tsc: ${ts.label}`);
        const [nodeV, npmV] = await Promise.all([
          runProcess(process.execPath, ["--version"], requestedDir, 15_000, signal),
          runProcess("npm", ["--version"], requestedDir, 30_000, signal),
        ]);
        lines.push(`node: ${nodeV.stdout.trim() || "?"}   npm: ${npmV.stdout.trim() || npmV.spawnError || "?"}`);
        if (params.packages?.length && pkgDir) {
          for (const spec of params.packages) {
            const name = pkgName(spec);
            const p = join(pkgDir, "node_modules", name, "package.json");
            const j = readJson(p);
            lines.push(`installed ${name}: ${j?.version ? `${j.version} (${p})` : "NOT installed"}`);
          }
        }
        return fin(lines.join("\n"), { packageJson: pkgJsonPath, nodeModules: nm && existsSync(nm) });
      }

      /* -------------------------------------------------------- typecheck */
      if (action === "typecheck") {
        return typecheck(params, requestedDir, pkgDir, outputMode, timeoutMs, extra, signal, fin);
      }

      /* ----------------------------------------------------------- npm ops */
      if (!pkgJsonPath) {
        return fin(
          `Error: no package.json found at or above ${requestedDir}. npm ${action} needs one — ` +
            `check projectDir, or use node_project {action:'typecheck'} which does not require a package.json.`,
          { error: "no-package-json" },
          true,
        );
      }
      const runDir = pkgDir!;

      if (action === "install") {
        const pkgs = params.packages ?? [];
        if (ctx.hasUI && pkgs.length && !params.noSave) {
          const approved = await ctx.ui.confirm(
            "npm install",
            `${runDir}\n\nnpm install ${pkgs.join(" ")}${params.dev ? " --save-dev" : ""}\n\nThis modifies package.json and node_modules.`,
          );
          if (!approved)
            return fin(`User declined the install of ${pkgs.join(", ")}. Nothing was installed.`, { declined: true }, true);
        }
        const args = ["install", ...pkgs];
        if (params.dev) args.push("--save-dev");
        if (params.noSave) args.push("--no-save");
        args.push("--no-fund", "--no-progress");
        args.push(...extra);

        const r = await runProcess("npm", args, runDir, timeoutMs, signal);
        return fin(summarizeInstall(r, runDir, pkgs, params, outputMode), {
          command: r.command,
          exitCode: r.code,
          durationMs: r.durationMs,
          timedOut: r.timedOut,
        }, (r.code ?? 1) !== 0);
      }

      if (action === "outdated") {
        const r = await runProcess("npm", ["outdated", "--json", ...extra], runDir, timeoutMs, signal);
        const header = `cmd: ${r.command}   (dir: ${runDir})`;
        if (r.spawnError) return fin(`${header}\nError: could not run npm: ${r.spawnError}`, { error: "spawn" }, true);
        let parsed: any = null;
        try {
          parsed = JSON.parse(r.stdout.trim() || "{}");
        } catch {
          /* npm printed non-JSON (usually an error) */
        }
        if (!parsed) {
          return fin(`${header}\nCould not parse npm outdated output:\n${tail(r.combined, 15)}`, { exitCode: r.code }, true);
        }
        const names = Object.keys(parsed);
        if (!names.length) return fin(`${header}\n✓ all dependencies up to date`, { outdated: 0 });
        const rows = names
          .slice(0, 40)
          .map((n) => `${n}  ${parsed[n].current ?? "-"} -> ${parsed[n].wanted ?? "-"} (latest ${parsed[n].latest ?? "-"})`);
        const more = names.length > 40 ? `\n... and ${names.length - 40} more` : "";
        return fin(`${header}\n${names.length} outdated package(s):\n${rows.join("\n")}${more}`, {
          outdated: names.length,
        });
      }

      // test / build
      const scriptName = params.script ?? action;
      const scripts = pkgJson?.scripts ?? {};
      if (!scripts[scriptName]) {
        const available = Object.keys(scripts);
        return fin(
          `Error: no "${scriptName}" script in ${pkgJsonPath}. Available scripts: ` +
            `${available.length ? available.join(", ") : "(none)"}. Pass script:"<name>" to run a different one.`,
          { error: "missing-script", available },
          true,
        );
      }
      if (!existsSync(join(runDir, "node_modules"))) {
        onUpdate?.({
          content: [{ type: "text", text: "warning: node_modules is absent; the script will probably fail" }],
          details: { action },
        });
      }
      const r = await runProcess("npm", ["run", scriptName, ...(extra.length ? ["--", ...extra] : [])], runDir, timeoutMs, signal);
      return fin(summarizeScript(r, runDir, scriptName, scripts[scriptName], outputMode), {
        command: r.command,
        script: scriptName,
        exitCode: r.code,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
      }, (r.code ?? 1) !== 0);
    },

    renderCall(args: Params, theme) {
      const bits = [
        args.packages?.length ? args.packages.join(" ") : undefined,
        args.files?.length ? args.files.join(" ") : undefined,
        args.script,
        args.projectDir,
        args.noSave ? "--no-save" : undefined,
        args.dev ? "--save-dev" : undefined,
      ].filter(Boolean) as string[];
      return new Text(
        `${theme.fg("accent", "node_project")} ${theme.bold(String(args.action))}` +
          (bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const first = result.content[0];
      const text = (first && "text" in first ? first.text : "") ?? "";
      if (isPartial) return new Text(theme.fg("warning", text || "Running..."), 0, 0);
      // ToolRenderResultOptions carries no isError flag, so derive it from details/text.
      const d = (result.details ?? {}) as Record<string, unknown>;
      const isError =
        Boolean(d.error) ||
        (typeof d.exitCode === "number" && d.exitCode !== 0) ||
        /^(Error:|FAILED)/m.test(text);
      const lines = text.split("\n");
      if (!expanded && lines.length > 14) {
        return new Text(
          `${lines.slice(0, 14).join("\n")}\n${theme.fg("dim", `... and ${lines.length - 14} more lines`)}`,
          0,
          0,
        );
      }
      return new Text(isError ? theme.fg("error", text) : text, 0, 0);
    },
  });
}

/* ------------------------------------------------------- tsc resolution */

type TscChoice = { cmd: string; args: string[]; label: string; source: "local" | "npx" };

function resolveTsc(startDir: string, pkgDir: string | null): TscChoice {
  for (const base of [startDir, pkgDir].filter(Boolean) as string[]) {
    const holder = findUp(base, join("node_modules", ".bin", "tsc"));
    if (holder) {
      const bin = join(holder, "node_modules", ".bin", "tsc");
      const version = readJson(join(holder, "node_modules", "typescript", "package.json"))?.version;
      return {
        cmd: bin,
        args: [],
        label: `local ${bin}${version ? ` (typescript ${version})` : ""}`,
        source: "local",
      };
    }
  }
  return {
    cmd: "npx",
    args: ["--yes", "-p", NPX_TS_SPEC, "tsc"],
    label: `npx -p ${NPX_TS_SPEC} tsc (no local typescript found; plain \`npx tsc\` would hit the deprecated stub package)`,
    source: "npx",
  };
}

/* ------------------------------------------------------------ typecheck */

async function typecheck(
  params: Params,
  requestedDir: string,
  pkgDir: string | null,
  outputMode: string,
  timeoutMs: number,
  extra: string[],
  signal: AbortSignal | undefined,
  fin: (text: string, details: Record<string, unknown>, isError?: boolean) => any,
) {
  const files = (params.files ?? []).map((f) => (isAbsolute(f) ? f : resolvePath(requestedDir, f)));
  for (const f of files) {
    if (!existsSync(f)) {
      return fin(`Error: file not found: ${f} (projectDir=${requestedDir})`, { error: "missing-file" }, true);
    }
  }

  let tsconfigPath: string | null = null;
  if (params.tsconfig) {
    tsconfigPath = isAbsolute(params.tsconfig) ? params.tsconfig : resolvePath(requestedDir, params.tsconfig);
    if (!existsSync(tsconfigPath)) {
      return fin(`Error: tsconfig not found: ${tsconfigPath}`, { error: "missing-tsconfig" }, true);
    }
  } else {
    const searchStart = files.length ? dirname(files[0]!) : requestedDir;
    const holder = findUp(searchStart, "tsconfig.json");
    tsconfigPath = holder ? join(holder, "tsconfig.json") : null;
  }

  const ts = resolveTsc(requestedDir, pkgDir);
  const cmdArgs = [...ts.args, "--pretty", "false"];
  let configLine: string;
  let typesLine: string | null = null;
  let tmpDir: string | null = null;
  let piTypes: ReturnType<typeof findPiTypeRoots> = null;

  try {
    if (tsconfigPath && files.length === 0) {
      // Pure passthrough: the project's own config decides everything.
      cmdArgs.push("--noEmit", "-p", tsconfigPath);
      configLine = `config: ${tsconfigPath} (project tsconfig, used as-is; --noEmit forced)`;
      // composite/incremental projects write a .tsbuildinfo even under --noEmit, which would
      // mutate a repo the caller only asked to *check* (caught empirically). Redirect it to tmp.
      if (configWantsBuildInfo(tsconfigPath)) {
        tmpDir = mkdtempSync(join(tmpdir(), "pi-node-project-"));
        cmdArgs.push("--tsBuildInfoFile", join(tmpDir, "check.tsbuildinfo"));
        configLine += "; .tsbuildinfo redirected to a temp dir so the project is not modified";
      }
    } else if (tsconfigPath && files.length > 0) {
      // Respect the project's compilerOptions but restrict the program to `files`.
      tmpDir = mkdtempSync(join(tmpdir(), "pi-node-project-"));
      const cfgPath = join(tmpDir, "tsconfig.json");
      // `include` from the base config is UNIONed with `files`, not replaced by it — without an
      // explicit empty `include` the generated program silently checks the whole project and reports
      // diagnostics for files the caller did not ask about (caught empirically).
      writeFileSync(
        cfgPath,
        JSON.stringify(
          { extends: tsconfigPath, compilerOptions: { noEmit: true }, files, include: [], exclude: [] },
          null,
          2,
        ),
      );
      cmdArgs.push("-p", cfgPath);
      if (configWantsBuildInfo(tsconfigPath)) cmdArgs.push("--tsBuildInfoFile", join(tmpDir, "check.tsbuildinfo"));
      configLine = `config: ${tsconfigPath} (project tsconfig, extended to check only the ${files.length} requested file(s))`;
    } else if (files.length > 0) {
      // No tsconfig anywhere: Pi-extension defaults.
      // PI_NODE_PROJECT_NO_TYPE_FALLBACK=1 disables the fallback (debugging / forcing the degraded path).
      const needsPiTypes =
        !process.env.PI_NODE_PROJECT_NO_TYPE_FALLBACK &&
        filesImportPiRuntime(files) &&
        !resolvableFrom(files, "@earendil-works/pi-coding-agent");
      piTypes = needsPiTypes ? findPiTypeRoots() : null;
      if (piTypes) {
        tmpDir = mkdtempSync(join(tmpdir(), "pi-node-project-"));
        const cfgPath = join(tmpDir, "tsconfig.json");
        const nm = piTypes.nodeModules;
        const paths: Record<string, string[]> = {
          "@earendil-works/*": [join(nm, "@earendil-works", "*")],
          typebox: [join(nm, "typebox")],
          "typebox/*": [join(nm, "typebox", "*")],
        };
        if (piTypes.agentPkg) paths["@earendil-works/pi-coding-agent"] = [piTypes.agentPkg];
        const nodeTypes = existsSync(join(nm, "@types", "node"));
        writeFileSync(
          cfgPath,
          JSON.stringify(
            {
              compilerOptions: {
                noEmit: true,
                target: "es2022",
                module: "esnext",
                moduleResolution: "bundler",
                skipLibCheck: true,
                esModuleInterop: true,
                allowImportingTsExtensions: true,
                baseUrl: "/",
                paths,
                ...(nodeTypes ? { types: ["node"], typeRoots: [join(nm, "@types")] } : {}),
              },
              files,
            },
            null,
            2,
          ),
        );
        cmdArgs.push("-p", cfgPath);
        configLine =
          "config: none found — Pi-extension defaults (target es2022, module esnext, moduleResolution bundler, " +
          "skipLibCheck, esModuleInterop, allowImportingTsExtensions, noEmit)";
        typesLine =
          `types: pi-runtime-fallback — @earendil-works/*${nodeTypes ? ", node" : ""}, typebox resolved from pi's own install ` +
          `(${piTypes.nodeModules}) because they are not resolvable from these files' node_modules. Real code errors ARE ` +
          "checked (pi API misuse included); versions may differ from a locally installed copy.";
      } else {
        cmdArgs.push(...DEFAULT_TSC_FLAGS, ...files);
        configLine =
          "config: none found — Pi-extension defaults (target es2022, module esnext, moduleResolution bundler, " +
          "skipLibCheck, esModuleInterop, allowImportingTsExtensions, noEmit)";
      }
    } else {
      return fin(
        `Error: no tsconfig.json found at or above ${requestedDir} and no 'files' given. ` +
          "Pass files:[...] to type-check specific files, or tsconfig:'path/to/tsconfig.json'.",
        { error: "nothing-to-check" },
        true,
      );
    }
    cmdArgs.push(...extra);

    const r = await runProcess(ts.cmd, cmdArgs, requestedDir, timeoutMs, signal);
    const header = [
      `cmd: ${r.command}   (dir: ${requestedDir})`,
      `tsc: ${ts.label}`,
      configLine,
      ...(typesLine ? [typesLine] : []),
    ].join("\n");

    if (r.spawnError) {
      return fin(
        `${header}\nError: could not run tsc: ${r.spawnError}. ` +
          (ts.source === "npx" ? "Is npm/npx on PATH and is the registry reachable?" : "Is the local tsc binary executable?"),
        { error: "spawn", tscSource: ts.source },
        true,
      );
    }
    if (r.timedOut) {
      return fin(`${header}\nError: tsc timed out after ${Math.round(timeoutMs / 1000)}s (raise timeoutSec).`, {
        error: "timeout",
      }, true);
    }
    if (r.aborted) {
      return fin(`${header}\nCANCELLED: the turn was aborted, so tsc was killed before finishing. No verdict.`, {
        error: "aborted",
      }, true);
    }

    const diags = parseDiagnostics(r.combined, requestedDir);
    const real: Diag[] = [];
    const unresolved = new Map<string, number>();
    for (const d of diags) {
      const spec = isEnvUnresolved(d);
      if (spec) unresolved.set(spec, (unresolved.get(spec) ?? 0) + 1);
      else real.push(d);
    }

    const seen = new Set<string>();
    const deduped = real.filter((d) => {
      const key = fmtDiag(d);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const errorCount = deduped.filter((d) => d.severity === "error").length;

    const out: string[] = [header];
    const summaryOnly = outputMode === "summary";

    if (deduped.length === 0 && unresolved.size === 0) {
      if (r.code !== 0) {
        // tsc failed but printed nothing we recognized — never claim success.
        out.push(`tsc exited ${r.code} with no parsable diagnostics. Raw output:\n${tail(r.combined, 20) || "(empty)"}`);
        return fin(out.join("\n"), { exitCode: r.code, diagnostics: 0, unparsed: true }, true);
      }
      out.push(
        `✓ typecheck clean — 0 errors${files.length ? ` in ${files.length} file(s)` : ""} (${(r.durationMs / 1000).toFixed(1)}s)`,
      );
      return fin(out.join("\n"), {
        exitCode: r.code,
        diagnostics: 0,
        errors: 0,
        tscSource: ts.source,
        typeSource: piTypes ? "pi-runtime-fallback" : "project",
        tsconfig: tsconfigPath,
      });
    }

    if (unresolved.size) {
      const specs = [...unresolved.keys()].sort();
      out.push(
        `unresolved imports (${specs.length}, ENVIRONMENT not code): ${specs.slice(0, 15).map((s) => `'${s}'`).join(", ")}` +
          (specs.length > 15 ? `, +${specs.length - 15} more` : "") +
          `\n  hint: node_modules is missing these — run node_project {action:"install"${
            pkgDir ? `, projectDir:"${pkgDir}"` : ""
          }} first; these are not code errors.`,
      );
      if (deduped.length === 0) {
        // Everything imported is `any`, so tsc cannot check the code that uses it. Saying
        // "no errors" here would be a false pass (verified empirically: two real type errors
        // vanished once the imports stopped resolving).
        out.push(
          "⚠ INCOMPLETE CHECK: 0 code diagnostics, but the imports above are unresolved, so everything " +
            "coming from them is `any` and was NOT type-checked. Do not report this as a clean typecheck — " +
            "install the dependencies (or check from a directory where they resolve) and re-run.",
        );
      }
    }

    if (deduped.length) {
      out.push(`${errorCount} error(s)${deduped.length !== errorCount ? `, ${deduped.length - errorCount} warning(s)` : ""}:`);
      if (!summaryOnly) {
        const shown = deduped.slice(0, MAX_DIAGNOSTICS);
        out.push(shown.map(fmtDiag).join("\n"));
        if (deduped.length > MAX_DIAGNOSTICS) {
          const perFile = new Map<string, number>();
          for (const d of deduped) {
            const k = d.file ?? "<project>";
            perFile.set(k, (perFile.get(k) ?? 0) + 1);
          }
          const counts = [...perFile.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([f, n]) => `${f} (${n})`)
            .join(", ");
          out.push(
            `... ${deduped.length - MAX_DIAGNOSTICS} more diagnostics suppressed (${deduped.length} total). ` +
              `Per-file counts: ${counts}. Fix the shown ones first, then re-run.`,
          );
        }
      }
    }

    if (outputMode === "raw") out.push(`--- raw tsc output ---\n${capRaw(r.combined)}`);

    return fin(
      out.join("\n"),
      {
        exitCode: r.code,
        diagnostics: deduped.length,
        errors: errorCount,
        unresolvedImports: unresolved.size,
        checkComplete: unresolved.size === 0,
        tscSource: ts.source,
        typeSource: unresolved.size ? "degraded-unresolved-imports" : piTypes ? "pi-runtime-fallback" : "project",
      },
      true,
    );
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Does this tsconfig (or anything it extends) enable composite/incremental? Those projects emit a
 * .tsbuildinfo file into the project even with --noEmit, so we redirect it instead of writing there.
 */
function configWantsBuildInfo(configPath: string, depth = 0): boolean {
  if (depth > 5) return false;
  const cfg = readJson(configPath);
  if (!cfg) return false;
  const co = cfg.compilerOptions ?? {};
  if (co.composite === true || co.incremental === true || typeof co.tsBuildInfoFile === "string") return true;
  const ext = cfg.extends;
  const parents = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext : [];
  for (const p of parents) {
    if (typeof p !== "string" || !p.startsWith(".")) continue; // package-style extends: not resolved here
    const resolved = resolvePath(dirname(configPath), p.endsWith(".json") ? p : `${p}.json`);
    if (existsSync(resolved) && configWantsBuildInfo(resolved, depth + 1)) return true;
  }
  return false;
}

/** Does any target file import pi's ambient packages? (cheap textual check) */
function filesImportPiRuntime(files: string[]): boolean {
  for (const f of files) {
    try {
      const src = readFileSync(f, "utf8");
      if (/from\s+["'](@earendil-works\/|typebox)/.test(src) || /require\(["'](@earendil-works\/|typebox)/.test(src))
        return true;
    } catch {
      /* unreadable -> assume not */
    }
  }
  return false;
}

/** Is `pkg` resolvable by walking up node_modules from any of these files? */
function resolvableFrom(files: string[], pkg: string): boolean {
  for (const f of files) {
    if (findUp(dirname(f), join("node_modules", pkg, "package.json"))) return true;
  }
  return false;
}

/* -------------------------------------------------------------- install */

function summarizeInstall(r: RunResult, runDir: string, pkgs: string[], params: Params, outputMode: string): string {
  const header = `cmd: ${r.command}   (dir: ${runDir})`;
  if (r.spawnError) return `${header}\nError: could not run npm: ${r.spawnError} (is npm on PATH?)`;
  if (r.timedOut) return `${header}\nError: npm install timed out after ${Math.round(r.durationMs / 1000)}s (raise timeoutSec).`;
  if (r.aborted)
    return (
      `${header}\nCANCELLED after ${(r.durationMs / 1000).toFixed(1)}s: the turn was aborted mid-install. ` +
      `node_modules in ${runDir} may be in a partial state — re-run install before trusting it.`
    );

  const lines = r.combined.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const out = [header];

  if ((r.code ?? 1) !== 0) {
    const kind = classifyNpmFailure(r.combined);
    out.push(`FAILED (exit ${r.code})${kind ? `: ${kind}` : ""}`);
    const errLines = pickNpmErrorLines(lines);
    out.push(errLines.length ? errLines.join("\n") : tail(r.combined, 15) || "(no output)");
    if (outputMode === "raw") out.push(`--- raw npm output ---\n${capRaw(r.combined)}`);
    return out.join("\n");
  }

  const resolution = uniq(
    lines
      .map((l) => l.trim())
      .filter((l) => /^(added|removed|changed|up to date|audited)\b/.test(l) || /^(added|removed|changed)\b.*packages/.test(l)),
  );
  const vulns = uniq(lines.map((l) => l.trim()).filter((l) => /vulnerabilit(y|ies)/.test(l))).slice(0, 3);
  const warns = uniq(
    lines
      .filter((l) => /^npm (warn|WARN)/i.test(l.trim()))
      .map((l) => stripNpmPrefix(l.trim()))
      .filter((l) => /deprecated|ERESOLVE|peer|engine|SKIPPING|unsupported/i.test(l)),
  );

  out.push(
    `✓ npm install ok (exit 0, ${(r.durationMs / 1000).toFixed(1)}s)${pkgs.length ? ` — ${pkgs.join(", ")}` : ""}`,
  );
  if (resolution.length) out.push(resolution.join("\n"));
  else out.push("(npm printed no resolution summary — nothing changed)");
  if (vulns.length) out.push(vulns.join("\n"));
  if (outputMode !== "summary" && warns.length) {
    out.push(
      `warnings that matter (${warns.length}):\n` +
        warns
          .slice(0, MAX_WARNINGS)
          .map((w) => `  ${w.slice(0, 200)}`)
          .join("\n") +
        (warns.length > MAX_WARNINGS ? `\n  ... +${warns.length - MAX_WARNINGS} more (outputMode:"raw" to see all)` : ""),
    );
  }
  if (params.noSave) {
    out.push(
      `noSave: package.json and the lockfile were NOT modified; the files are only in node_modules. ` +
        `Cleanup when done (bash, in ${runDir}): npm uninstall --no-save ${pkgs.map(pkgName).join(" ")}`,
    );
  }
  if (outputMode === "raw") out.push(`--- raw npm output ---\n${capRaw(r.combined)}`);
  return out.join("\n");
}

/* ---------------------------------------------------------- test / build */

function summarizeScript(r: RunResult, runDir: string, scriptName: string, scriptBody: string, outputMode: string): string {
  const header = `cmd: ${r.command}   (dir: ${runDir}, script "${scriptName}": ${String(scriptBody).slice(0, 120)})`;
  if (r.spawnError) return `${header}\nError: could not run npm: ${r.spawnError} (is npm on PATH?)`;

  const out = [header];
  const failed = (r.code ?? 1) !== 0 || r.timedOut;
  const parsed = parseTestOutput(r.combined);
  const diags = parseDiagnostics(r.combined, runDir);

  if (r.timedOut) out.push(`TIMED OUT after ${(r.durationMs / 1000).toFixed(0)}s (raise timeoutSec)`);
  if (r.aborted) {
    return `${header}\nCANCELLED after ${(r.durationMs / 1000).toFixed(1)}s: the turn was aborted, so the script was killed mid-run. Nothing about pass/fail can be concluded.`;
  }

  if (failed) {
    out.push(`FAILED: npm run ${scriptName} exited ${r.code} (${(r.durationMs / 1000).toFixed(1)}s)`);
    if (parsed?.failures.length) {
      out.push(
        `failing tests (${parsed.framework}):\n` + parsed.failures.slice(0, 25).map((f) => `  ${f.slice(0, 300)}`).join("\n"),
      );
    }
    if (diags.length) {
      const seen = new Set<string>();
      const uniqueDiags = diags.filter((d) => {
        const k = fmtDiag(d);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      out.push(
        `compiler diagnostics (${uniqueDiags.length}):\n` +
          uniqueDiags.slice(0, MAX_DIAGNOSTICS).map(fmtDiag).join("\n") +
          (uniqueDiags.length > MAX_DIAGNOSTICS ? `\n... ${uniqueDiags.length - MAX_DIAGNOSTICS} more` : ""),
      );
    }
    if (parsed) out.push(`summary (${parsed.framework}):\n  ${parsed.lines.join("\n  ")}`);
    if (!parsed && !diags.length) {
      out.push(`no recognized test/compiler summary — last ${MAX_TAIL_LINES} output lines:\n${tail(r.combined, MAX_TAIL_LINES)}`);
    }
    if (outputMode === "raw") out.push(`--- raw output ---\n${capRaw(r.combined)}`);
    return out.join("\n");
  }

  out.push(`✓ npm run ${scriptName} ok (exit 0, ${(r.durationMs / 1000).toFixed(1)}s)`);
  if (parsed) out.push(`summary (${parsed.framework}):\n  ${parsed.lines.join("\n  ")}`);
  else if (outputMode !== "summary") {
    const t = tail(r.combined, 5);
    if (t) out.push(`last output lines:\n${t}`);
  }
  if (outputMode === "raw") out.push(`--- raw output ---\n${capRaw(r.combined)}`);
  return out.join("\n");
}
