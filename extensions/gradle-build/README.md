# gradle_build — Gradle/Android build, test & lint with a real output parser

A pi tool extension that runs Gradle and returns a **parsed failure report** instead of a build log.

It exists because in 266 real pi sessions, 60 bash commands ran `./gradlew` and **59 of them piped
the output through `grep`/`head`/`tail`** — Gradle was the single biggest source of >10 KB bash
results, and the agent re-invented an ad-hoc parser every single time.

```
before:  ./gradlew :features:subscriptions:compileGrubhubReleaseSources --offline 2>&1 \
           | grep -E "^e:|error:|BUILD|warning: .*(unused|never used)" | head -25

after:   gradle_build({ action: "compile", modules: [":features:subscriptions"],
                        variant: "GrubhubRelease", offline: true })
```

Measured on a real 100-module Gradle build whose raw output is 57 KB / 1155 lines: the tool returns
a **1.4 KB** report containing every compile error, every failed test with its assertion and
non-framework stack frames, and the Gradle failure cause.

## Install

Copy or symlink this directory into `~/.pi/agent/extensions/gradle-build/` (global) or
`.pi/extensions/gradle-build/` (project-local). No npm dependencies — everything it imports
(`typebox`, `@earendil-works/pi-*`, node built-ins) is provided by pi.

Quick test without installing:

```bash
pi -e /path/to/extensions/gradle-build/index.ts --mode json \
   -p "compile :features:alpha offline and report what's broken"
```

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `action` | `'compile' \| 'test' \| 'lint' \| 'raw'` | required | What to run (task names are derived, see below) |
| `modules` | `string[]` | `[]` (root project) | `[':features:subscriptions']`; also accepts `features/subscriptions` |
| `tests` | `string[]` | – | `--tests` filters, e.g. `['*SubscriptionCheckoutAnalyticsTest*']` (only `action:'test'`; repeated per test task so multi-module runs filter correctly) |
| `variant` | `string` | – | Android variant in task casing, e.g. `'GrubhubRelease'`, `'Debug'` |
| `offline` | `boolean` | `false` | `--offline` |
| `lintTasks` | `string[]` | auto-detected | Override lint task names for `action:'lint'` |
| `extraArgs` | `string[]` | – | Appended verbatim; for `action:'raw'` this is where the tasks go |
| `outputMode` | `'failures' \| 'summary' \| 'raw'` | `'failures'` | How much to return (see below) |
| `rawLines` | `number` | `200` (max 600) | With `outputMode:'raw'`, how many trailing lines — replaces `\| tail -N` |
| `includeWarnings` | `boolean` | `false` | List compiler warnings (auto-listed when the build failed via `-Werror`) |
| `timeoutSec` | `number` | `900` | Kill Gradle and return *partial parsed* results with a `TIMED OUT after Ns` marker |
| `projectDir` | `string` | `cwd` | Directory containing `gradlew` (parents are searched too; falls back to `gradle` on PATH) |

### Task derivation

| action | with `variant` | without `variant` |
|---|---|---|
| `compile` | `:mod:compile<Variant>Sources` | `:mod:classes` |
| `test` | `:mod:test<Variant>UnitTest` (+ `--tests` filters) | `:mod:test` |
| `lint` | auto-detected repo tasks (`ktlintStep`/`detektStep`/`checkstyleStep` if they appear in `buildSrc`/root build scripts), else `ktlintCheck`/`detekt`; override with `lintTasks` | same |
| `raw` | tasks/flags come from `extraArgs` verbatim | same |

`--console=plain` is added unless you pass your own `--console`.

### Output modes

- **`failures`** (default) — status line + a one-line summary + only what is broken: compile
  diagnostics (`file:line:col: error/warning: message`, deduped with `(xN)`), failed tests with
  assertion + project stack frames, lint violations grouped by rule, Gradle's `* What went wrong:`
  cause chain, and infra problems (daemon, offline cache misses, unknown tasks). Nothing is said
  about successful tasks beyond the summary. Always ends with how to get more.
- **`summary`** — status, duration, counts only.
- **`raw`** — status line + the last `rawLines` lines of Gradle's own output (ANSI stripped,
  `\r` progress redraws collapsed). Use when the report says the parser recognised nothing.

## What the parser handles

- `BUILD SUCCESSFUL/FAILED in <duration>`, `N actionable tasks: ...`, failed task names,
  `Execution failed for task ':x'.` and multi-failure (`FAILURE: Build completed with N failures.`) blocks
- Kotlin `e:`/`w:` diagnostics in both the `file:///path.kt:LINE:COL msg` and the older
  `path.kt: (LINE, COL): msg` form, plus location-less ones like `e: warnings found and -Werror specified`
  (which flips warnings from "suppressed" to "these ARE the errors")
- javac/kapt `path.java:LINE: error|warning: msg` and bare `error: [kapt] ...`
- Failed tests (`Suite > test FAILED`), their assertion message, `N tests completed, M failed`,
  and stack frames with JUnit4/JUnit5/Gradle/Mockito/MockK/Robolectric/Truth/AssertJ frames dropped
  (including `app//`-prefixed JPMS frames)
- ktlint/detekt console violations (`path:L:C: msg [Rule]`), checkstyle (`[ant:checkstyle] [ERROR] ...`),
  Android lint (`path:L: Error: msg [RuleId]`), grouped by rule with per-rule counts
- ktlint/detekt **report files**: when a repo turns the console reporter off, Gradle only prints
  "KtLint found code style violations. Please see the following reports:" — the tool reads the `.txt`
  report and reports the violations, tagged with their provenance
- ANSI colour codes and `\r` progress redraws; 60 k-line / 8 MB outputs (bounded memory, ~2 MB overhead);
  timeouts and aborts (child runs in its own process group and is SIGTERM'd then SIGKILL'd, so no orphans)

### Provenance / trust markers

Lint violations carry a `source` in `details.violationSources`:

| source | meaning |
|---|---|
| `console` | printed by the analyzer during this run — trust it |
| `report-file` | read from a report file written by this run |
| `report-file-stale` | read from a report file **older than this run** (task was UP-TO-DATE) — may describe older code; re-run with `extraArgs:['--rerun-tasks']` |

The stale case is also called out in the text output, so the agent's trust can be conditional.

## Bash idioms this replaces

| bash | tool call |
|---|---|
| `./gradlew :m:compileGrubhubReleaseSources --offline 2>&1 \| grep -E "^e:\|error:\|BUILD" \| head -25` | `{action:'compile', modules:[':m'], variant:'GrubhubRelease', offline:true}` |
| `./gradlew :m:testGrubhubReleaseUnitTest --tests '*FooTest*' 2>&1 \| grep -E "FAILED\|error:\|BUILD" \| head` | `{action:'test', modules:[':m'], variant:'GrubhubRelease', tests:['*FooTest*']}` |
| `./gradlew :m:ktlintStep :m:checkstyleStep :m:detektStep 2>&1 \| grep -E "FAILED\|BUILD\|\.kt:[0-9]+\|error\|warning"` | `{action:'lint', modules:[':m']}` |
| `./gradlew :m:compileGrubhubDebugUnitTestKotlin -q 2>&1 \| tail -40` | `{action:'compile', modules:[':m'], variant:'GrubhubDebugUnitTest'}` or `outputMode:'raw', rawLines:40` |
| `./gradlew :app:assembleGrubhubDebug 2>&1 \| grep ...` | `{action:'raw', extraArgs:[':app:assembleGrubhubDebug']}` |
| `./gradlew ... 2>&1 \| grep -c FAILED` | `outputMode:'summary'` (counts) or `details.errorCount` / `details.testFailures` |

## Safety

- Destructive-ish tasks (`clean`, `publish*`, `uninstall*`, `install*`) trigger a `ctx.ui.confirm`
  when a UI is attached; in headless/JSON mode they run but the report says so explicitly.
- The tool never writes source files; it only runs Gradle in `projectDir`.
- `session_shutdown` kills any Gradle child still running.

## Testing / hacking

The parser is exported, so it can be exercised without running Gradle:

```js
import { parseGradleOutput, buildArgs, detectLintTasks } from "./index.ts";
const parsed = parseGradleOutput(fs.readFileSync("recorded-gradle-output.txt", "utf8"));
```

It was validated against 68 real `./gradlew` outputs recorded from real pi sessions plus synthetic
format cases for javac/checkstyle/android-lint/JUnit5/daemon failures (see the Validation section of
the build report).
