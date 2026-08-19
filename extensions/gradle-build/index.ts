/**
 * gradle_build — Gradle/Android build, test and lint runner with a real output parser.
 *
 * Replaces the `./gradlew ... 2>&1 | grep -E "..." | head -N` bash idiom: instead of the agent
 * re-inventing an ad-hoc parser (and paying for 10-100 KB of "> Task :x UP-TO-DATE" noise), this
 * tool streams Gradle output, parses it, and returns only what a failure investigation needs:
 *
 *   - BUILD SUCCESSFUL/FAILED + duration + failed task names
 *   - Kotlin/Java/kapt diagnostics as file:line:col: severity: message (deduped, capped)
 *   - failed tests with their assertion + project stack frames (framework noise dropped)
 *   - ktlint/detekt/checkstyle/android-lint violations grouped by rule with counts
 *   - the "* What went wrong:" cause chain
 *
 * The parser is exported (`parseGradleOutput`) so it can be unit-tested against recorded real
 * Gradle output without running Gradle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/* ------------------------------------------------------------------ caps --- */

/** Default wall-clock budget for one Gradle invocation. */
const DEFAULT_TIMEOUT_SEC = 900;
/** How many diagnostics/violations/test failures we keep in memory (counted beyond that). */
const MAX_COLLECT = 2000;
/** How many items of a category we print in `failures` mode. */
const MAX_SHOW = 25;
/** Ring buffer of raw (ANSI-stripped) lines kept for outputMode:"raw". */
const RAW_TAIL_LINES = 600;
/** Hard cap on characters returned to the model. */
const MAX_CHARS = 30_000;
/** Hard cap on characters returned in outputMode:"raw". */
const MAX_RAW_CHARS = 24_000;
/** Default number of trailing raw lines shown in outputMode:"raw" (like `| tail -200`). */
const DEFAULT_RAW_LINES = 200;
/** Bail out of accumulating a single line longer than this (protects against binary spew). */
const MAX_LINE_CHARS = 8_000;
/** Largest ktlint/detekt report file we are willing to read+parse. */
const MAX_REPORT_BYTES = 512 * 1024;
/** Max stack frames kept per failed test. */
const MAX_TEST_FRAMES = 4;

/* --------------------------------------------------------------- helpers --- */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

/** Strip ANSI/OSC escape sequences (Gradle's rich console) from a chunk of output. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Collapse a carriage-return progress line down to its final state.
 * Gradle's rich console redraws `<=====------> 45% EXECUTING` in place with \r; only the text
 * after the last \r is the line's real content.
 */
function collapseCr(line: string): string {
  const i = line.lastIndexOf("\r");
  return i === -1 ? line : line.slice(i + 1);
}

/**
 * Quote an argument for the human/agent-readable command echo.
 * Args are passed to execve directly (no shell), but the echoed command is often copy-pasted, and
 * an unquoted `--tests *Foo*` would be glob-expanded by the shell.
 */
function displayQuote(arg: string): string {
  return /[^\w@%+=:,./-]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** `features/subscriptions` | `features:subscriptions` | `:features:subscriptions` -> `:features:subscriptions`. */
function normalizeModule(m: string): string {
  let s = m.trim().replace(/^@/, "");
  if (!s) return "";
  s = s.replace(/\/+$/, "").replace(/\//g, ":");
  if (!s.startsWith(":")) s = ":" + s;
  return s;
}

/** Strip a leading @ (some models add it) and resolve relative to a base dir. */
function resolvePath(base: string, p: string | undefined): string {
  if (!p) return base;
  const cleaned = p.replace(/^@/, "");
  return isAbsolute(cleaned) ? cleaned : resolve(base, cleaned);
}

/* ---------------------------------------------------------- parser types --- */

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** Absolute or project-relative file path, or undefined for location-less diagnostics. */
  file?: string;
  line?: number;
  col?: number;
  message: string;
  /** How many identical occurrences were collapsed into this one. */
  count: number;
  /** Which task was executing when we saw it (best effort). */
  task?: string;
}

export interface Violation {
  file: string;
  line?: number;
  col?: number;
  rule: string;
  message: string;
  /**
   * Provenance/confidence of this violation:
   *  - "console"            : printed by the analyzer during THIS run (highest confidence)
   *  - "report-file"        : read from a report file Gradle pointed at, written during this run
   *  - "report-file-stale"  : read from a report file that predates this run (the task was
   *                           UP-TO-DATE / did not rewrite it) — may describe an older state
   */
  source: "console" | "report-file" | "report-file-stale";
  tool: "ktlint" | "detekt" | "checkstyle" | "android-lint" | "unknown";
}

export interface TestFailure {
  suite: string;
  test: string;
  /** First detail line — usually `ExceptionClass: message` or `ExceptionClass at File.kt:NN`. */
  assertion?: string;
  /** Non-framework stack frames only. */
  frames: string[];
}

export interface ParsedBuild {
  status: "success" | "failed" | "unknown";
  /** Gradle's own reported duration string, e.g. "1m 20s". */
  duration?: string;
  failedTasks: string[];
  /** "861 actionable tasks: 685 executed, 151 from cache, 25 up-to-date" */
  taskSummary?: string;
  /** Number of `> Task :x` headers seen (i.e. tasks that actually ran/were reported). */
  tasksSeen: number;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Count of collected-then-dropped items because MAX_COLLECT was hit. */
  droppedDiagnostics: number;
  violations: Violation[];
  droppedViolations: number;
  testFailures: TestFailure[];
  droppedTestFailures: number;
  /** e.g. { total: 72, failed: 1, skipped: 0 } aggregated over all test tasks. */
  testTotals?: { total: number; failed: number; skipped: number };
  /** "* What went wrong:" cause chains, one entry per reported failure. */
  causes: string[];
  /** Infrastructure-level problems (daemon, offline cache, unknown task, JVM) worth surfacing verbatim. */
  problems: string[];
  /** ktlint/detekt report files Gradle told us about (violations live there, not on the console). */
  reportFiles: string[];
  /** True when the build failed only because warnings were promoted to errors. */
  werror: boolean;
  /** Last N raw lines, ANSI-stripped and CR-collapsed, for outputMode:"raw". */
  rawTail: string[];
  /** Total lines of Gradle output seen (rawTail may hold only the tail). */
  totalLines: number;
}

/* ------------------------------------------------------------- patterns --- */

/** `e: file:///abs/File.kt:67:54 Unresolved reference 'isFalse'.` (Kotlin 1.9+/2.x) */
const KOTLIN_URI_RE = /^([ew]): (?:file:\/\/)?(\/[^\s:]*[^\s:]|[A-Za-z]:[^\s:]+):(\d+):(\d+)[ :]\s*(.*)$/;
/** `e: /abs/File.kt: (67, 54): message` (older Kotlin) */
const KOTLIN_PAREN_RE = /^([ew]): (?:file:\/\/)?(.+?): \((\d+), (\d+)\):\s*(.*)$/;
/** `e: warnings found and -Werror specified` (no location) */
const KOTLIN_BARE_RE = /^([ew]): (.*)$/;
/** `/abs/File.java:12: error: cannot find symbol` and `error: [kapt] ...` */
const JAVAC_RE = /^(\S+\.(?:java|kt)):(\d+):(?:(\d+):)? ?(error|warning): (.*)$/;
const JAVAC_BARE_RE = /^(error|warning): (.*)$/;
/** ktlint/detekt console: `/abs/File.kt:3:1: Imports must be ordered ... [ImportOrdering]` */
const KTLINT_RE = /^(\S.*?\.(?:kt|kts|java)):(\d+):(\d+): (.*?)(?: \[([\w.:$-]+)\])?$/;
/** ktlint report file rows: `/abs/File.kt:3:1: message (standard:import-ordering)` */
const KTLINT_REPORT_RE = /^(\S.*?\.(?:kt|kts|java)):(\d+):(\d+): (.*?)(?: \(([\w.:$-]+)\))?$/;
/** checkstyle: `[ant:checkstyle] [ERROR] /abs/File.java:12:5: message [RuleName]` */
const CHECKSTYLE_RE = /^\[ant:checkstyle\] \[(ERROR|WARN|WARNING|INFO)\] (.+?):(\d+)(?::(\d+))?: (.*?)(?: \[(\w+)\])?$/;
/** Android lint text output: `/abs/File.kt:12: Error: message [RuleId]` */
const ANDROID_LINT_RE = /^(\S.*?):(\d+): (Error|Warning|Information): (.*?)(?: \[([\w.]+)\])?$/;
/** `> Task :features:subscriptions:detekt FAILED` */
const TASK_RE = /^> Task (\S+)(?: (FAILED|UP-TO-DATE|SKIPPED|NO-SOURCE|FROM-CACHE))?\s*$/;
/** `SomeTest > some test name FAILED` (also `Class > Nested > test FAILED`) */
const TEST_RESULT_RE = /^(\S[^>]*?) > (.+?) (FAILED|PASSED|SKIPPED)$/;
/**
 * `SomeTest > some test name STANDARD_OUT` — everything indented under this is output the TEST
 * printed, not Gradle's own. It must never be parsed as diagnostics (a test that logs
 * "e: file:///..." would otherwise fabricate a compile error — real bug found in validation).
 */
const TEST_STREAM_RE = /^(\S[^>]*?) > (.+?) (STANDARD_OUT|STANDARD_ERROR)$/;
/** `72 tests completed, 1 failed, 2 skipped` */
const TEST_TOTALS_RE = /^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?/;
const BUILD_RESULT_RE = /^BUILD (SUCCESSFUL|FAILED) in (.+?)\s*$/;
const ACTIONABLE_RE = /^\d+ actionable tasks?: .*$/;
const EXEC_FAILED_RE = /^(?:> )?Execution failed for task '(.+?)'\.$/;

/**
 * Stack frames that tell you nothing about your own bug.
 * The optional `app//` / `java.base@17/` prefixes are JPMS/classloader markers that JUnit 5 and
 * modern JVMs print in front of the class name (missing them once kept junit frames — real bug).
 */
const FRAMEWORK_FRAME_RE =
  /^\s*at (?:[\w.$]*\/\/)?(?:[\w.]+@[\w.+-]+\/)?(?:org\.junit|junit\.|org\.opentest4j|org\.testng|org\.hamcrest|org\.gradle|worker\.org\.gradle|jdk\.internal|jdk\.proxy|java\.base|java\.lang\.reflect|java\.util\.concurrent|sun\.reflect|org\.mockito|net\.bytebuddy|io\.mockk|org\.robolectric|io\.kotest|kotlin\.test|kotlinx\.coroutines\.test|org\.jetbrains\.kotlin|com\.google\.common\.truth|org\.assertj|kotlin\.coroutines\.jvm\.internal)/;

/** Infra-level problems worth quoting verbatim even in `failures` mode. */
const PROBLEM_PATTERNS: RegExp[] = [
  /^(?:> )?Task '.*' not found in (?:project|root project) .*$/,
  /^Cannot locate tasks that match .*$/,
  /^(?:> )?No cached version of .* available for offline mode.*$/,
  /^(?:> )?No matching (?:variant|tests found) .*$/,
  /^(?:> )?Could not (?:resolve|download|connect|create|find|determine|read|open|start) .*$/,
  /^(?:> )?Unable to start the daemon process.*$/,
  /^(?:> )?Gradle could not start your build\..*$/,
  /^(?:> )?Value '.*' given for org\.gradle\.java\.home .*$/,
  /^(?:> )?Java home supplied .* is invalid.*$/,
  /^(?:> )?Could not open .* generic class cache.*$/,
  /^(?:> )?Unsupported class file major version.*$/,
  /^(?:> )?A problem occurred (?:configuring|evaluating) .*$/,
  /^(?:> )?Plugin .* not found.*$/,
  /^(?:> )?Build file '.*' line: \d+$/,
  /^(?:> )?Could not compile (?:build file|settings file) .*$/,
  /^FAILURE: Build completed with \d+ failures?\.$/,
  /^(?:> )?Process 'command '.*'' finished with non-zero exit value \d+$/,
  /^(?:> )?startup failed:.*$/,
  /^(?:> )?Timeout waiting to (?:lock|connect) .*$/,
];

/* ------------------------------------------------------------ the parser --- */

/**
 * Incremental, bounded-memory Gradle output parser.
 *
 * Feed it chunks (`push`) or whole text (`parseGradleOutput`), then call `finish()`.
 * Every collection is capped; overflow is counted, never accumulated.
 */
export class GradleParser {
  private buf = "";
  private currentTask?: string;
  private pendingTest?: TestFailure;
  /** true while inside a "* What went wrong:" block. */
  private inCause = false;
  private causeLines: string[] = [];
  private collectingReports = false;
  /** true while consuming the indented block of a test's captured stdout/stderr. */
  private inTestStream = false;
  private diagMap = new Map<string, Diagnostic>();
  private violMap = new Map<string, Violation>();
  private testKeys = new Set<string>();

  private out: ParsedBuild = {
    status: "unknown",
    failedTasks: [],
    tasksSeen: 0,
    errors: [],
    warnings: [],
    droppedDiagnostics: 0,
    violations: [],
    droppedViolations: 0,
    testFailures: [],
    droppedTestFailures: 0,
    causes: [],
    problems: [],
    reportFiles: [],
    werror: false,
    rawTail: [],
    totalLines: 0,
  };

  /** Feed a chunk of raw stdout/stderr. Safe to call with partial lines. */
  push(chunk: string): void {
    this.buf += stripAnsi(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line.replace(/\s+$/, ""));
    }
    // A pathological single line (binary spew, huge progress redraw) must not grow the buffer forever.
    if (this.buf.length > MAX_LINE_CHARS) {
      const keep = collapseCr(this.buf);
      this.buf = keep.length > MAX_LINE_CHARS ? keep.slice(-MAX_LINE_CHARS) : keep;
    }
  }

  /** Flush the trailing partial line and return the parse result. */
  finish(): ParsedBuild {
    if (this.buf.trim()) this.line(this.buf.replace(/\s+$/, ""));
    this.buf = "";
    this.flushCause();
    this.flushTest();
    this.out.errors = [...this.diagMap.values()].filter((d) => d.severity === "error");
    this.out.warnings = [...this.diagMap.values()].filter((d) => d.severity === "warning");
    this.out.violations = [...this.violMap.values()];
    return this.out;
  }

  /* ---- per-line dispatch ---- */

  private line(rawLine: string): void {
    const line = collapseCr(rawLine);
    this.out.totalLines++;
    if (this.out.rawTail.length >= RAW_TAIL_LINES) this.out.rawTail.shift();
    this.out.rawTail.push(line);

    const trimmedRight = line;
    const t = line.trim();
    const indented = /^\s/.test(line);

    // --- captured test stdout/stderr block: consume verbatim, parse nothing ---
    if (this.inTestStream) {
      if (indented || t === "") return;
      this.inTestStream = false;
    }
    if (TEST_STREAM_RE.test(t) && !t.startsWith(">")) {
      this.inTestStream = true;
      return;
    }

    // --- ktlint/detekt report-file pointers ---
    // Checked FIRST because Gradle prints them *inside* the "* What went wrong:" block, and the
    // cause-block collector would otherwise swallow them (real bug: report ingestion never ran).
    if (this.collectingReports) {
      const rf = /^-\s+(\/.*\.(?:txt|xml|html|json))$/.exec(t);
      if (rf) {
        if (this.out.reportFiles.length < 20 && !this.out.reportFiles.includes(rf[1])) {
          this.out.reportFiles.push(rf[1]);
        }
        return;
      }
      this.collectingReports = false;
    }
    if (/(?:found code style violations|Please see the following reports)/i.test(t)) {
      this.collectingReports = true;
      return;
    }

    // --- test failure detail block (indented lines directly under `Test > name FAILED`) ---
    if (this.pendingTest) {
      if (/^\s+\S/.test(trimmedRight) && !TASK_RE.test(t)) {
        this.testDetail(t);
        return;
      }
      this.flushTest();
      // fall through: this line is something else
    }

    // --- "* What went wrong:" cause block ---
    if (this.inCause) {
      // A cause block is a contiguous run of non-blank lines; anything else ends it.
      // (Getting this wrong once swallowed the trailing "BUILD FAILED in 6s" line — real bug.)
      if (
        t === "" ||
        /^\* (Try|Get more help|Where|Exception is)/.test(t) ||
        t.startsWith("====") ||
        /^(BUILD (SUCCESSFUL|FAILED)|FAILURE:|> Task |\d+ actionable)/.test(t)
      ) {
        this.flushCause();
        if (t === "" || t.startsWith("*") || t.startsWith("====")) return;
        // fall through so BUILD FAILED / > Task lines are still parsed normally
      } else {
        this.causeLines.push(t.replace(/^>\s*/, ""));
        this.maybeProblem(t);
        if (this.causeLines.length > 12) this.flushCause();
        return;
      }
    }
    if (t === "* What went wrong:") {
      this.inCause = true;
      this.causeLines = [];
      return;
    }

    // --- build result / summaries ---
    let m = BUILD_RESULT_RE.exec(t);
    if (m) {
      this.out.status = m[1] === "SUCCESSFUL" ? "success" : "failed";
      this.out.duration = m[2];
      return;
    }
    if (ACTIONABLE_RE.test(t)) {
      this.out.taskSummary = t;
      return;
    }
    m = TEST_TOTALS_RE.exec(t);
    if (m) {
      const cur = this.out.testTotals ?? { total: 0, failed: 0, skipped: 0 };
      cur.total += Number(m[1]);
      cur.failed += Number(m[2] ?? 0);
      cur.skipped += Number(m[3] ?? 0);
      this.out.testTotals = cur;
      return;
    }

    // --- task headers ---
    m = TASK_RE.exec(t);
    if (m) {
      this.out.tasksSeen++;
      this.currentTask = m[1];
      if (m[2] === "FAILED") this.addFailedTask(m[1]);
      return;
    }
    m = EXEC_FAILED_RE.exec(t);
    if (m) {
      this.addFailedTask(m[1]);
      // keep going: the cause block usually follows
    }

    // --- test results ---
    m = TEST_RESULT_RE.exec(t);
    if (m && !t.startsWith(">") && !t.startsWith("*")) {
      if (m[3] === "FAILED") this.startTest(m[1].trim(), m[2].trim());
      return;
    }

    // --- lint/analyzer violations and compiler diagnostics ---
    // Both are only ever emitted at column 0 by Gradle/kotlinc/javac/ktlint/detekt/checkstyle
    // (verified against 68 recorded real Gradle outputs), so indented look-alikes — stack frames,
    // nested failure causes, captured test output — are never treated as diagnostics.
    if (!indented) {
      if (this.violationLine(t)) return;
      if (this.diagnosticLine(t)) return;
    }

    // --- infra problems ---
    this.maybeProblem(t);
  }

  /* ---- collectors ---- */

  private addFailedTask(task: string): void {
    if (!this.out.failedTasks.includes(task) && this.out.failedTasks.length < 50) {
      this.out.failedTasks.push(task);
    }
    if (this.out.status === "unknown") this.out.status = "failed";
  }

  private maybeProblem(t: string): void {
    if (!t || this.out.problems.length >= 25) return;
    for (const re of PROBLEM_PATTERNS) {
      if (re.test(t)) {
        const clean = t.replace(/^>\s*/, "");
        if (!this.out.problems.includes(clean)) this.out.problems.push(clean);
        return;
      }
    }
  }

  private startTest(suite: string, test: string): void {
    const key = `${suite}|${test}`;
    if (this.testKeys.has(key)) {
      this.pendingTest = undefined;
      return;
    }
    this.testKeys.add(key);
    this.pendingTest = { suite, test, frames: [] };
  }

  private testDetail(t: string): void {
    const p = this.pendingTest!;
    if (!p.assertion) {
      p.assertion = t;
      return;
    }
    if (/^at /.test(t)) {
      if (FRAMEWORK_FRAME_RE.test("    " + t)) return;
      if (p.frames.length < MAX_TEST_FRAMES) p.frames.push(t);
      return;
    }
    // Continuation of a multi-line assertion message (Truth/AssertJ facts).
    if (p.frames.length === 0 && p.assertion.length < 600) p.assertion += "\n      " + t;
  }

  private flushTest(): void {
    const p = this.pendingTest;
    this.pendingTest = undefined;
    if (!p) return;
    if (this.out.testFailures.length >= MAX_COLLECT) {
      this.out.droppedTestFailures++;
      return;
    }
    this.out.testFailures.push(p);
  }

  private flushCause(): void {
    this.inCause = false;
    const text = this.causeLines
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" > ");
    this.causeLines = [];
    if (text && !this.out.causes.includes(text) && this.out.causes.length < 15) {
      this.out.causes.push(text);
    }
  }

  private addDiag(d: Omit<Diagnostic, "count">): void {
    const key = `${d.severity}|${d.file ?? ""}|${d.line ?? ""}|${d.col ?? ""}|${d.message}`;
    const existing = this.diagMap.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    if (this.diagMap.size >= MAX_COLLECT) {
      this.out.droppedDiagnostics++;
      return;
    }
    this.diagMap.set(key, { ...d, count: 1 });
  }

  private addViolation(v: Violation): void {
    const key = `${v.tool}|${v.file}|${v.line ?? ""}|${v.col ?? ""}|${v.rule}|${v.message}`;
    if (this.violMap.has(key)) return;
    if (this.violMap.size >= MAX_COLLECT) {
      this.out.droppedViolations++;
      return;
    }
    this.violMap.set(key, v);
  }

  /** Analyzer violations: checkstyle / ktlint / detekt / android lint. Returns true if consumed. */
  private violationLine(t: string): boolean {
    let m = CHECKSTYLE_RE.exec(t);
    if (m) {
      this.addViolation({
        file: m[2],
        line: Number(m[3]),
        col: m[4] ? Number(m[4]) : undefined,
        rule: m[6] ?? (m[1] === "ERROR" ? "checkstyle-error" : "checkstyle-warning"),
        message: m[5],
        source: "console",
        tool: "checkstyle",
      });
      return true;
    }
    // ktlint/detekt console format requires a trailing [Rule]; without it a `File.kt:1:2: msg`
    // line is far more likely to be a compiler diagnostic, so we do not claim it here.
    m = KTLINT_RE.exec(t);
    if (m && m[5]) {
      this.addViolation({
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        rule: m[5],
        message: m[4],
        source: "console",
        tool: this.toolFromTask("ktlint"),
      });
      return true;
    }
    m = ANDROID_LINT_RE.exec(t);
    if (m && m[5]) {
      this.addViolation({
        file: m[1],
        line: Number(m[2]),
        rule: m[5],
        message: m[4],
        source: "console",
        tool: "android-lint",
      });
      return true;
    }
    return false;
  }

  /** Guess the analyzer from the currently executing task name. */
  private toolFromTask(fallback: Violation["tool"]): Violation["tool"] {
    const task = (this.currentTask ?? "").toLowerCase();
    if (task.includes("detekt")) return "detekt";
    if (task.includes("ktlint")) return "ktlint";
    if (task.includes("checkstyle")) return "checkstyle";
    if (task.includes("lint")) return "android-lint";
    return fallback;
  }

  /** Compiler diagnostics: Kotlin (e:/w:) and javac/kapt. Returns true if consumed. */
  private diagnosticLine(t: string): boolean {
    let m = KOTLIN_URI_RE.exec(t);
    if (m) {
      this.addDiag({
        severity: m[1] === "e" ? "error" : "warning",
        file: m[2],
        line: Number(m[3]),
        col: Number(m[4]),
        message: m[5].trim(),
        task: this.currentTask,
      });
      return true;
    }
    m = KOTLIN_PAREN_RE.exec(t);
    if (m) {
      this.addDiag({
        severity: m[1] === "e" ? "error" : "warning",
        file: m[2],
        line: Number(m[3]),
        col: Number(m[4]),
        message: m[5].trim(),
        task: this.currentTask,
      });
      return true;
    }
    m = JAVAC_RE.exec(t);
    if (m) {
      this.addDiag({
        severity: m[4] === "error" ? "error" : "warning",
        file: m[1],
        line: Number(m[2]),
        col: m[3] ? Number(m[3]) : undefined,
        message: m[5].trim(),
        task: this.currentTask,
      });
      return true;
    }
    m = KOTLIN_BARE_RE.exec(t);
    if (m) {
      const msg = m[2].trim();
      if (/warnings found and -Werror specified/i.test(msg)) this.out.werror = true;
      this.addDiag({ severity: m[1] === "e" ? "error" : "warning", message: msg, task: this.currentTask });
      return true;
    }
    m = JAVAC_BARE_RE.exec(t);
    if (m) {
      // Skip Gradle/JVM chatter that happens to start with "warning:".
      if (/^Sharing is only supported|^unknown enum constant/i.test(m[2])) return true;
      this.addDiag({ severity: m[1] === "error" ? "error" : "warning", message: m[2].trim(), task: this.currentTask });
      return true;
    }
    return false;
  }

  /**
   * Merge violations from a ktlint/detekt report file Gradle pointed us at.
   * Some repos configure the console reporter off, so the console shows only
   * "KtLint found code style violations. Please see the following reports:".
   */
  ingestReportFile(path: string, text: string, tool: Violation["tool"], stale = false): number {
    let added = 0;
    for (const raw of text.split("\n")) {
      const t = collapseCr(stripAnsi(raw)).trim();
      if (!t) continue;
      const m = KTLINT_REPORT_RE.exec(t) ?? KTLINT_RE.exec(t);
      if (!m) continue;
      const before = this.violMap.size;
      this.addViolation({
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        rule: m[5] ?? "unknown-rule",
        message: m[4],
        source: stale ? "report-file-stale" : "report-file",
        tool,
      });
      if (this.violMap.size > before) added++;
    }
    if (added > 0) {
      this.out.violations = [...this.violMap.values()];
    }
    return added;
  }
}

/** Parse a complete Gradle output string (used by tests and by outputMode:"raw" post-processing). */
export function parseGradleOutput(text: string): ParsedBuild {
  const p = new GradleParser();
  p.push(text);
  return p.finish();
}

/* -------------------------------------------------------------- renderer --- */

interface RenderOpts {
  projectDir: string;
  command: string;
  outputMode: "failures" | "summary" | "raw";
  rawLines?: number;
  includeWarnings: boolean;
  timedOut?: number;
  exitCode: number | null;
  killed: boolean;
  elapsedSec: number;
  note?: string;
}

/**
 * Shorten a path for display: strip file:// and the project dir prefix.
 * Compares against the REAL path of the project dir too, because Kotlin/Gradle report
 * symlink-resolved paths (on macOS /tmp/x is reported as /private/tmp/x) and a naive
 * relative() against the caller-supplied dir then yields a useless absolute path.
 */
function shortPath(projectDir: string, file: string): string {
  const f = file.replace(/^file:\/\//, "");
  if (isAbsolute(f)) {
    for (const base of [projectDir, realPathOf(projectDir)]) {
      const rel = relative(base, f);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
  }
  return f;
}

const realPathCache = new Map<string, string>();
function realPathOf(p: string): string {
  const hit = realPathCache.get(p);
  if (hit) return hit;
  let r = p;
  try {
    r = realpathSync(p);
  } catch {
    /* not on disk (tests) — use as-is */
  }
  realPathCache.set(p, r);
  return r;
}

function fmtDiag(projectDir: string, d: Diagnostic): string {
  const loc = d.file ? `${shortPath(projectDir, d.file)}${d.line ? `:${d.line}` : ""}${d.col ? `:${d.col}` : ""}: ` : "";
  const dup = d.count > 1 ? ` (x${d.count})` : "";
  return `  ${loc}${d.severity}: ${d.message}${dup}`;
}

/** Build the text the model sees. */
export function renderReport(parsed: ParsedBuild, o: RenderOpts): string {
  const L: string[] = [];
  // Gradle can die before printing a BUILD result line (bad JVM, daemon failure, kill): fall back
  // to the exit code so the headline still tells the agent pass/fail rather than "UNKNOWN".
  const statusWord =
    parsed.status === "success"
      ? "BUILD SUCCESSFUL"
      : parsed.status === "failed"
        ? "BUILD FAILED"
        : o.exitCode === 0 && !o.timedOut
          ? "BUILD COMPLETED (no BUILD result line in output)"
          : "BUILD FAILED (no BUILD result line: Gradle exited before finishing)";
  const dur = parsed.duration ? ` in ${parsed.duration}` : ` (~${o.elapsedSec}s wall clock)`;

  if (o.timedOut !== undefined) {
    L.push(`TIMED OUT after ${o.timedOut}s — partial results below (Gradle was killed; a daemon may still be finishing).`);
  }
  L.push(
    `${statusWord}${dur}` +
      (parsed.status === "unknown" && o.exitCode !== null ? ` (gradle exit ${o.exitCode})` : "") +
      (parsed.status === "unknown" && o.exitCode === null && o.killed ? " (killed)" : "") +
      (parsed.failedTasks.length ? ` — failed: ${parsed.failedTasks.slice(0, 6).join(", ")}` : ""),
  );
  if (parsed.failedTasks.length > 6) L.push(`(+${parsed.failedTasks.length - 6} more failed tasks)`);
  L.push(`cmd: ${o.command}${o.projectDir ? `  (cwd ${o.projectDir})` : ""}`);
  if (o.note) L.push(o.note);

  const errCount = parsed.errors.reduce((n, d) => n + d.count, 0);
  const warnCount = parsed.warnings.reduce((n, d) => n + d.count, 0);
  const testInfo = parsed.testTotals;

  // One-line "what happened" summary, always present.
  const bits: string[] = [];
  if (parsed.tasksSeen) bits.push(`${parsed.tasksSeen} tasks reported`);
  if (testInfo) bits.push(`${testInfo.total} tests (${testInfo.failed} failed${testInfo.skipped ? `, ${testInfo.skipped} skipped` : ""})`);
  else if (parsed.testFailures.length) bits.push(`${parsed.testFailures.length} failed tests`);
  if (errCount) bits.push(`${errCount} compile errors`);
  if (warnCount) bits.push(`${warnCount} warnings`);
  if (parsed.violations.length) bits.push(`${parsed.violations.length} lint violations`);
  if (parsed.taskSummary) bits.push(parsed.taskSummary);
  if (bits.length) L.push(`summary: ${bits.join(", ")}`);

  if (o.outputMode === "summary") {
    if (parsed.causes.length) L.push(`cause: ${parsed.causes[0]}`);
    if (parsed.problems.length) L.push(`problem: ${parsed.problems[0]}`);
    L.push(`(outputMode:'failures' for the actual errors, 'raw' for full Gradle output)`);
    return L.join("\n");
  }

  if (o.outputMode === "raw") {
    const want = Math.min(Math.max(o.rawLines ?? DEFAULT_RAW_LINES, 10), RAW_TAIL_LINES);
    const tail = parsed.rawTail.slice(-want);
    L.push("");
    L.push(
      parsed.totalLines > tail.length
        ? `--- raw output (last ${tail.length} of ${parsed.totalLines} lines; rawLines up to ${RAW_TAIL_LINES} for more) ---`
        : `--- raw output (${parsed.totalLines} lines) ---`,
    );
    let raw = tail.join("\n");
    if (raw.length > MAX_RAW_CHARS) raw = raw.slice(-MAX_RAW_CHARS);
    L.push(raw);
    return L.join("\n");
  }

  /* ---- failures mode ---- */

  const showWarnings = o.includeWarnings || parsed.werror;

  if (parsed.problems.length) {
    L.push("");
    L.push(`Build problems (${parsed.problems.length}):`);
    for (const p of parsed.problems.slice(0, 8)) L.push(`  ${p}`);
  }

  if (parsed.errors.length) {
    const shown = parsed.errors.slice(0, MAX_SHOW);
    L.push("");
    L.push(`Compile errors (${errCount}${shown.length < parsed.errors.length ? `, showing ${shown.length}` : ""}):`);
    for (const d of shown) L.push(fmtDiag(o.projectDir, d));
    const hidden = parsed.errors.length - shown.length + parsed.droppedDiagnostics;
    if (hidden > 0) L.push(`  ... ${hidden} more (outputMode:'raw' to see all)`);
  }

  if (parsed.warnings.length) {
    if (showWarnings) {
      const shown = parsed.warnings.slice(0, MAX_SHOW);
      L.push("");
      L.push(
        `Warnings (${warnCount}${shown.length < parsed.warnings.length ? `, showing ${shown.length}` : ""})` +
          (parsed.werror ? " — build failed with -Werror, so these ARE the errors:" : ":"),
      );
      for (const d of shown) L.push(fmtDiag(o.projectDir, d));
      const hidden = parsed.warnings.length - shown.length;
      if (hidden > 0) L.push(`  ... ${hidden} more (outputMode:'raw' to see all)`);
    } else {
      L.push("");
      L.push(`Warnings: ${warnCount} suppressed (pass includeWarnings:true to list them)`);
    }
  }

  if (parsed.testFailures.length) {
    L.push("");
    const shown = parsed.testFailures.slice(0, MAX_SHOW);
    L.push(
      `Failed tests (${parsed.testFailures.length}${testInfo ? ` of ${testInfo.total}` : ""}` +
        `${shown.length < parsed.testFailures.length ? `, showing ${shown.length}` : ""}):`,
    );
    for (const tf of shown) {
      L.push(`  ${tf.suite} > ${tf.test}`);
      if (tf.assertion) L.push(`      ${tf.assertion}`);
      for (const f of tf.frames) L.push(`      ${f}`);
    }
    const hidden = parsed.testFailures.length - shown.length + parsed.droppedTestFailures;
    if (hidden > 0) L.push(`  ... ${hidden} more failed tests (outputMode:'raw' to see all)`);
  }

  if (parsed.violations.length) {
    L.push("");
    const byRule = new Map<string, Violation[]>();
    for (const v of parsed.violations) {
      const k = `${v.tool}/${v.rule}`;
      const arr = byRule.get(k);
      if (arr) arr.push(v);
      else byRule.set(k, [v]);
    }
    const rules = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
    let ruleIndex = 0;
    const fromReport = parsed.violations.some((v) => v.source === "report-file");
    const fromStaleReport = parsed.violations.some((v) => v.source === "report-file-stale");
    L.push(
      `Lint violations (${parsed.violations.length} across ${rules.length} rule${rules.length === 1 ? "" : "s"})` +
        (fromStaleReport
          ? " [read from a report file that PREDATES this run (task was up-to-date) — may be stale; " +
            "re-run with extraArgs:['--rerun-tasks'] to refresh]"
          : fromReport
            ? " [some read from Gradle's report file written by this run, not the console]"
            : "") +
        ":",
    );
    let printed = 0;
    for (const [rule, items] of rules) {
      ruleIndex++;
      L.push(`  [${rule}] ${items.length}`);
      for (const v of items.slice(0, 3)) {
        L.push(`    ${shortPath(o.projectDir, v.file)}:${v.line ?? "?"}${v.col ? `:${v.col}` : ""}: ${v.message}`);
        printed++;
      }
      if (items.length > 3) L.push(`    ... +${items.length - 3} more in this rule`);
      if (printed >= MAX_SHOW && ruleIndex < rules.length) {
        L.push(`  ... ${rules.length - ruleIndex} more rules (outputMode:'raw' for all)`);
        break;
      }
    }
    if (parsed.droppedViolations) L.push(`  ... ${parsed.droppedViolations} violations dropped (collection cap)`);
  }

  if (parsed.reportFiles.length && parsed.violations.length === 0) {
    L.push("");
    L.push("Violation reports (console reporter is off for these tasks):");
    for (const r of parsed.reportFiles.slice(0, 6)) L.push(`  ${shortPath(o.projectDir, r)}`);
  }

  if (parsed.causes.length) {
    L.push("");
    L.push("Gradle failure cause:");
    for (const c of parsed.causes.slice(0, 4)) L.push(`  ${c}`);
  }

  const nothingFound =
    !parsed.errors.length &&
    !parsed.testFailures.length &&
    !parsed.violations.length &&
    !parsed.causes.length &&
    !parsed.problems.length;
  if (parsed.status === "failed" && nothingFound) {
    L.push("");
    L.push("No diagnostics were recognised in the output — this is a parser gap or an unusual failure.");
    L.push("Re-run with outputMode:'raw' to see the tail of Gradle's own output.");
  } else if (parsed.status === "success" && o.outputMode === "failures") {
    L.push("");
    L.push(
      warnCount && !showWarnings
        ? "No failures. (includeWarnings:true to see the warnings, outputMode:'raw' for full output.)"
        : "No failures. (outputMode:'raw' for full Gradle output.)",
    );
  } else {
    L.push("");
    L.push("More detail: re-run with outputMode:'raw' (full Gradle output tail) or 'summary' (counts only).");
  }

  let text = L.join("\n");
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + `\n... [truncated at ${MAX_CHARS} chars — narrow modules/tests or use outputMode:'summary']`;
  }
  return text;
}

/* ------------------------------------------------------------ execution --- */

const Params = Type.Object({
  action: StringEnum(["compile", "test", "lint", "raw"] as const, {
    description:
      "compile = compile sources; test = run unit tests (with optional --tests filters); " +
      "lint = ktlint/detekt/checkstyle style checks; raw = run exactly the Gradle tasks/flags you pass in extraArgs.",
  }),
  modules: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Gradle module paths, e.g. [':features:subscriptions'] (also accepts 'features/subscriptions'). " +
        "Omit to run the task at the root project (slow on big builds). Ignored for action:'raw'.",
    }),
  ),
  tests: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Test filters passed as --tests, e.g. ['*SubscriptionCheckoutAnalyticsTest*']. Only for action:'test'. " +
        "Applied per test task, so it works with several modules at once.",
    }),
  ),
  variant: Type.Optional(
    Type.String({
      description:
        "Android build variant in Gradle task casing, e.g. 'GrubhubRelease' or 'Debug'. " +
        "compile -> :mod:compile<Variant>Sources, test -> :mod:test<Variant>UnitTest. " +
        "Omit for plain JVM modules (compile -> :mod:classes, test -> :mod:test).",
    }),
  ),
  offline: Type.Optional(Type.Boolean({ description: "Pass --offline (default false).", default: false })),
  lintTasks: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Override the lint task names for action:'lint' (default: auto-detected repo tasks such as " +
        "ktlintStep/detektStep/checkstyleStep, else ktlintCheck/detekt).",
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Extra Gradle args appended verbatim (e.g. ['-PsomeFlag=1','--rerun-tasks']). " +
        "For action:'raw' this is where the task names go, e.g. ['help'] or [':app:assembleGrubhubDebug'].",
    }),
  ),
  outputMode: Type.Optional(
    StringEnum(["failures", "summary", "raw"] as const, {
      description:
        "failures (default) = only errors/failed tests/violations + one-line summary; " +
        "summary = counts only; raw = tail of the full Gradle output (use when the parser found nothing).",
    }),
  ),
  rawLines: Type.Optional(
    Type.Number({
      description: `With outputMode:'raw', how many trailing Gradle output lines to return (default ${DEFAULT_RAW_LINES}, max ${RAW_TAIL_LINES}) — replaces \`| tail -N\`.`,
      default: DEFAULT_RAW_LINES,
    }),
  ),
  includeWarnings: Type.Optional(
    Type.Boolean({
      description:
        "List compiler warnings too (default false: warnings are counted but not listed). " +
        "Warnings are listed automatically when the build failed via -Werror.",
      default: false,
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `Kill Gradle after this many seconds and return partial parsed results (default ${DEFAULT_TIMEOUT_SEC}).`,
      default: DEFAULT_TIMEOUT_SEC,
    }),
  ),
  projectDir: Type.Optional(
    Type.String({
      description: "Directory containing gradlew (default: cwd; the tool also searches parent directories).",
    }),
  ),
});
type ParamsT = Static<typeof Params>;

/** Tasks that change more than build output — worth a confirmation when a UI is attached. */
const DANGEROUS_TASK_RE = /^(clean|publish|uninstall|install[A-Z]|.*[:.]clean$|.*publish.*|.*uninstall.*)$/;

interface RunResult {
  parsed: ParsedBuild;
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  elapsedSec: number;
  spawnError?: string;
}

/** Children we started, so session_shutdown can never leave a Gradle launcher behind. */
const liveChildren = new Set<ChildProcess>();

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  // Gradle's launcher forwards SIGTERM to the daemon as a build cancellation; SIGKILL does not.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 5000).unref?.();
}

/** Walk up from `dir` looking for an executable gradlew. */
function findGradlew(dir: string): { cmd: string; cwd: string; kind: "wrapper" | "system" } | { error: string } {
  let cur = resolve(dir);
  for (let i = 0; i < 6; i++) {
    const w = join(cur, "gradlew");
    if (existsSync(w)) return { cmd: w, cwd: cur, kind: "wrapper" };
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fallback to a system Gradle so the tool still works in wrapper-less projects.
  const paths = (process.env.PATH ?? "").split(":");
  for (const p of paths) {
    if (p && existsSync(join(p, "gradle"))) return { cmd: join(p, "gradle"), cwd: resolve(dir), kind: "system" };
  }
  return {
    error:
      `No gradlew found in ${resolve(dir)} or up to 5 parent directories, and no 'gradle' on PATH. ` +
      `Pass projectDir pointing at the directory that contains gradlew.`,
  };
}

/** Cache of detected lint task names per project dir (cheap file scan, no Gradle call). */
const lintTaskCache = new Map<string, { tasks: string[]; detected: boolean }>();

export function detectLintTasks(projectDir: string): { tasks: string[]; detected: boolean } {
  const cached = lintTaskCache.get(projectDir);
  if (cached) return cached;
  const candidates = ["ktlintStep", "detektStep", "checkstyleStep"];
  const found: string[] = [];
  const filesToScan: string[] = [];
  for (const rel of ["build.gradle", "build.gradle.kts"]) {
    const p = join(projectDir, rel);
    if (existsSync(p)) filesToScan.push(p);
  }
  const buildSrc = join(projectDir, "buildSrc", "src", "main");
  if (existsSync(buildSrc)) {
    // Bounded, shallow scan: buildSrc convention plugins are where these aggregate tasks live.
    const stack = [buildSrc];
    let budget = 400;
    while (stack.length && budget-- > 0) {
      const d = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(d);
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(d, e);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        else if (/\.(kt|kts|gradle|groovy|java)$/.test(e) && st.size < 512 * 1024) filesToScan.push(full);
      }
    }
  }
  for (const f of filesToScan.slice(0, 400)) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const c of candidates) {
      if (!found.includes(c) && text.includes(c)) found.push(c);
    }
    if (found.length === candidates.length) break;
  }
  const result = found.length
    ? { tasks: candidates.filter((c) => found.includes(c)), detected: true }
    : { tasks: ["ktlintCheck", "detekt"], detected: false };
  lintTaskCache.set(projectDir, result);
  return result;
}

/** Turn params into the Gradle argv (task list + flags). */
export function buildArgs(p: ParamsT, lintTasks: string[]): string[] {
  const modules = (p.modules ?? []).map(normalizeModule).filter(Boolean);
  const args: string[] = [];
  const variant = p.variant?.trim();
  const V = variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : "";

  const taskFor = (mod: string, task: string) => (mod ? `${mod}:${task}` : task);

  if (p.action === "compile") {
    const task = V ? `compile${V}Sources` : "classes";
    if (modules.length) for (const m of modules) args.push(taskFor(m, task));
    else args.push(task);
  } else if (p.action === "test") {
    const task = V ? `test${V}UnitTest` : "test";
    const targets = modules.length ? modules.map((m) => taskFor(m, task)) : [task];
    for (const t of targets) {
      args.push(t);
      // --tests is a task option: repeat it per test task so multi-module runs filter correctly.
      for (const filter of p.tests ?? []) args.push("--tests", filter);
    }
  } else if (p.action === "lint") {
    if (modules.length) {
      for (const m of modules) for (const t of lintTasks) args.push(taskFor(m, t));
    } else {
      for (const t of lintTasks) args.push(t);
    }
  }
  // action 'raw': tasks come from extraArgs verbatim. 'tests' filters are ignored for non-test
  // actions (the caller is told so via a note in the report).

  if (p.offline) args.push("--offline");
  if (p.extraArgs?.length) args.push(...p.extraArgs);
  // Plain console keeps output line-oriented (no ANSI redraw); the parser handles both anyway.
  if (!args.some((a) => a.startsWith("--console"))) args.push("--console=plain");
  return args;
}

async function runGradle(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutSec: number,
  signal: AbortSignal | undefined,
  onLine: (parsed: GradleParser) => void,
): Promise<RunResult> {
  const parser = new GradleParser();
  const start = Date.now();

  return await new Promise<RunResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd,
        // Own process group so a timeout can take the whole Gradle launcher + JVM down.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb", GRADLE_OPTS: process.env.GRADLE_OPTS ?? "" },
      });
    } catch (e) {
      resolvePromise({
        parsed: parser.finish(),
        exitCode: null,
        killed: false,
        timedOut: false,
        elapsedSec: 0,
        spawnError: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    liveChildren.add(child);

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(5, timeoutSec) * 1000);

    const onAbort = () => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });

    let lastProgress = 0;
    const feed = (buf: Buffer) => {
      parser.push(buf.toString("utf8"));
      const now = Date.now();
      if (now - lastProgress > 1500) {
        lastProgress = now;
        onLine(parser);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);

    const done = (code: number | null, killed: boolean, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
      resolvePromise({
        parsed: parser.finish(),
        exitCode: code,
        killed,
        timedOut,
        elapsedSec: Math.round((Date.now() - start) / 1000),
        spawnError,
      });
    };

    child.on("error", (e) => done(null, false, e.message));
    child.on("close", (code, sig) => done(code, sig !== null));
  });
}

/* ------------------------------------------------------------ extension --- */

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    for (const c of liveChildren) killTree(c);
    liveChildren.clear();
  });

  pi.registerTool({
    name: "gradle_build",
    label: "Gradle",
    description:
      "Run Gradle/Android compile, unit tests, or lint (ktlint/detekt/checkstyle) and return a PARSED failure " +
      "report instead of raw build logs: BUILD SUCCESSFUL/FAILED + duration, Kotlin/Java diagnostics as " +
      "file:line:col: error/warning: message (deduped), failed tests with their assertion and non-framework " +
      "stack frames, and lint violations grouped by rule. Replaces the " +
      "`./gradlew :mod:task 2>&1 | grep -E \"...\" | head -N` bash pipeline, which returns 10-100 KB of " +
      "`> Task ... UP-TO-DATE` noise and needs a hand-written parser every time.\n" +
      "Example: action:'test', modules:[':features:subscriptions'], variant:'GrubhubRelease', " +
      "tests:['*SubscriptionCheckoutAnalyticsTest*'], offline:true -> " +
      "`./gradlew :features:subscriptions:testGrubhubReleaseUnitTest --tests '*SubscriptionCheckoutAnalyticsTest*' --offline`, " +
      "reported as one status line plus only the failed tests.",
    promptSnippet:
      "Run Gradle compile/test/lint and get parsed errors, failed tests and lint violations instead of raw build output",
    promptGuidelines: [
      "Use gradle_build instead of running ./gradlew through bash: it already parses BUILD SUCCESSFUL/FAILED, " +
        "compile diagnostics, failed tests and lint violations, so never pipe Gradle through grep/head/tail yourself.",
      "With gradle_build always scope the work: pass modules (e.g. [':features:subscriptions']), variant " +
        "(e.g. 'GrubhubRelease') and, for tests, tests:['*SomeTest*'] — an unscoped root-project build is very slow.",
      "gradle_build defaults to outputMode:'failures' (only failures + a one-line summary). Escalate to " +
        "outputMode:'raw' only when the report says the parser recognised nothing, or when you need Gradle's own " +
        "output; use outputMode:'summary' when you just want pass/fail and counts.",
      "gradle_build hides compiler warnings by default and prints a suppressed count; pass includeWarnings:true " +
        "when you are chasing warnings (it lists them automatically when the build failed via -Werror).",
      "Use gradle_build action:'raw' with extraArgs for anything that is not compile/test/lint (e.g. " +
        "extraArgs:[':app:assembleGrubhubDebug'] or ['dependencies','--configuration','releaseRuntimeClasspath']).",
      "Trust gradle_build lint violations printed with no provenance tag (they came from this run's console " +
        "output). A block tagged '[read from a report file that PREDATES this run ...]' may describe older code " +
        "because the lint task was UP-TO-DATE — re-run it with extraArgs:['--rerun-tasks'] before acting on those.",
      "If gradle_build reports 'No diagnostics were recognised in the output', do not guess: re-run the same call " +
        "with outputMode:'raw' (optionally rawLines up to 600) and read Gradle's own output.",
      "If gradle_build reports a timeout, it returns partial parsed results and the Gradle daemon may still be " +
        "running; re-run with a narrower module/test filter or a larger timeoutSec rather than immediately retrying " +
        "the same command.",
    ],
    parameters: Params,
    execute: async (_toolCallId, rawParams, signal, onUpdate, ctx: ExtensionContext) => {
      const p = rawParams as ParamsT;
      const outputMode = p.outputMode ?? "failures";
      const baseDir = resolvePath(ctx.cwd, p.projectDir);

      if (!existsSync(baseDir)) {
        throw new Error(`projectDir does not exist: ${baseDir}`);
      }

      const found = findGradlew(baseDir);
      if ("error" in found) {
        return {
          content: [{ type: "text", text: `Error: ${found.error}` }],
          details: { error: found.error, projectDir: baseDir },
        };
      }

      if (p.action === "raw" && !(p.extraArgs?.length ?? 0)) {
        const msg =
          "Error: action:'raw' needs the Gradle tasks/flags in extraArgs, e.g. extraArgs:[':app:assembleGrubhubDebug'].";
        return { content: [{ type: "text", text: msg }], details: { error: msg } };
      }

      const lint = p.action === "lint" ? (p.lintTasks?.length ? { tasks: p.lintTasks, detected: true } : detectLintTasks(found.cwd)) : { tasks: [], detected: false };
      const args = buildArgs(p, lint.tasks);
      const printable = `${found.kind === "wrapper" ? "./gradlew" : "gradle"} ${args.map(displayQuote).join(" ")}`;

      // Ask before running tasks that do more than write into build/ — only when a UI exists.
      const risky = args.filter((a) => !a.startsWith("-") && DANGEROUS_TASK_RE.test(a.split(":").pop() ?? a));
      let note: string | undefined;
      if (risky.length) {
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm("Run destructive Gradle task?", `${printable}\n\nin ${found.cwd}`);
          if (!ok) {
            return {
              content: [{ type: "text", text: "Cancelled by user (destructive Gradle task not run)." }],
              details: { cancelled: true, command: printable },
            };
          }
        } else {
          note = `note: ran potentially destructive task(s) ${risky.join(", ")} without confirmation (no UI attached).`;
        }
      }
      if (p.action !== "test" && (p.tests?.length ?? 0) > 0) {
        note = `${note ? note + "\n" : ""}note: 'tests' filters are ignored for action:'${p.action}'.`;
      }
      if (p.action === "lint" && !lint.detected && !p.lintTasks?.length) {
        note = `${note ? note + "\n" : ""}note: lint tasks ktlintCheck/detekt are a fallback guess (no *Step tasks found in buildSrc/build.gradle); pass lintTasks if the build uses different names.`;
      } else if (p.action === "lint" && lint.detected && !p.lintTasks?.length) {
        note = `${note ? note + "\n" : ""}note: lint tasks ${lint.tasks.join(", ")} auto-detected from this repo's build scripts.`;
      }

      onUpdate?.({
        content: [{ type: "text", text: `Running ${printable}` }],
        details: { command: printable, projectDir: found.cwd, phase: "starting" },
      });

      const timeoutSec = p.timeoutSec && p.timeoutSec > 0 ? Math.floor(p.timeoutSec) : DEFAULT_TIMEOUT_SEC;
      const runStartedAt = Date.now();
      const run = await runGradle(found.cmd, args, found.cwd, timeoutSec, signal, (parser) => {
        // Cheap progress: last task header seen so far.
        const tail = (parser as unknown as { out: ParsedBuild }).out;
        const last = tail.rawTail.filter((l) => l.startsWith("> Task ")).pop();
        onUpdate?.({
          content: [{ type: "text", text: `${printable}\n${last ?? `${tail.totalLines} lines...`}` }],
          details: { command: printable, phase: "running", lines: tail.totalLines },
        });
      });

      if (run.spawnError) {
        const text =
          `Error: could not run Gradle (${run.spawnError}).\n` +
          `cmd: ${printable}\ncwd: ${found.cwd}\n` +
          (run.spawnError.includes("EACCES") ? "gradlew may not be executable (chmod +x gradlew)." : "");
        return { content: [{ type: "text", text }], details: { error: run.spawnError, command: printable } };
      }

      // Merge violations from report files Gradle pointed at (ktlint with the console reporter off).
      // Done in a throwaway parser so its own caps/dedup apply, then appended to the real result.
      let reportViolations = 0;
      if (run.parsed.reportFiles.length && run.parsed.violations.length === 0 && outputMode !== "raw") {
        const merged = new GradleParser();
        for (const f of run.parsed.reportFiles) {
          if (!f.endsWith(".txt")) continue;
          try {
            const st = statSync(f);
            if (st.size > MAX_REPORT_BYTES) continue;
            const tool: Violation["tool"] = /detekt/i.test(f) ? "detekt" : /checkstyle/i.test(f) ? "checkstyle" : "ktlint";
            // A report older than this invocation was not rewritten by it (task UP-TO-DATE), so its
            // contents may describe an older state of the code: tag it instead of pretending it is fresh.
            const stale = st.mtimeMs < runStartedAt - 1000;
            reportViolations += merged.ingestReportFile(f, readFileSync(f, "utf8"), tool, stale);
          } catch {
            /* report file gone or unreadable — ignore */
          }
        }
        if (reportViolations > 0) {
          const extra = merged.finish().violations;
          run.parsed.violations = [...run.parsed.violations, ...extra];
        }
      }

      const text = renderReport(run.parsed, {
        projectDir: found.cwd,
        command: printable,
        outputMode,
        rawLines: p.rawLines,
        includeWarnings: p.includeWarnings ?? false,
        timedOut: run.timedOut ? timeoutSec : undefined,
        exitCode: run.exitCode,
        killed: run.killed,
        elapsedSec: run.elapsedSec,
        note,
      });

      return {
        content: [{ type: "text", text }],
        details: {
          command: printable,
          projectDir: found.cwd,
          gradle: found.kind,
          action: p.action,
          outputMode,
          status: run.parsed.status,
          duration: run.parsed.duration,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          elapsedSec: run.elapsedSec,
          failedTasks: run.parsed.failedTasks,
          errorCount: run.parsed.errors.reduce((n, d) => n + d.count, 0),
          warningCount: run.parsed.warnings.reduce((n, d) => n + d.count, 0),
          testTotals: run.parsed.testTotals,
          testFailures: run.parsed.testFailures.length,
          violations: run.parsed.violations.length,
          violationsFromReportFile: reportViolations,
          violationSources: [...new Set(run.parsed.violations.map((v) => v.source))],
          linesParsed: run.parsed.totalLines,
        },
      };
    },
    renderCall: (rawArgs, theme) => {
      const a = rawArgs as ParamsT;
      const mods = (a.modules ?? []).map(normalizeModule).join(" ");
      const bits = [a.action, mods || "(root)", a.variant ?? "", (a.tests ?? []).join(" ")].filter(Boolean).join(" ");
      return new Text(theme.fg("toolTitle", theme.bold("gradle ")) + theme.fg("accent", bits), 0, 0);
    },
    renderResult: (result, { expanded, isPartial }, theme) => {
      const first = result.content[0];
      const content = (first && "text" in first ? first.text : undefined) ?? "";
      if (isPartial) return new Text(theme.fg("warning", content || "Running Gradle..."), 0, 0);
      if (content.startsWith("Error:")) return new Text(theme.fg("error", content), 0, 0);
      const lines = content.split("\n");
      const head = lines[0] ?? "";
      const colored = head.startsWith("BUILD SUCCESSFUL")
        ? theme.fg("success", head)
        : head.startsWith("BUILD FAILED") || head.startsWith("TIMED OUT")
          ? theme.fg("error", head)
          : theme.fg("warning", head);
      if (!expanded && lines.length > 20) {
        return new Text([colored, ...lines.slice(1, 20)].join("\n") + `\n... and ${lines.length - 20} more lines`, 0, 0);
      }
      return new Text([colored, ...lines.slice(1)].join("\n"), 0, 0);
    },
  });
}
