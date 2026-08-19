# node_project — npm / tsc workflow tool for Pi

One tool call instead of the npm/tsc bash pipelines the agent otherwise retypes from memory every
session, with the output parsed down to what is actually actionable (diagnostics, resolution
summaries, failing tests) instead of the npm/tsc firehose.

Measured on 266 real Pi sessions: **102 of 1539 shell commands were npm/npx/tsc** (`npm install` 65,
`npx tsc --noEmit ...` 37), almost all of them hand-typed long flag soup piped through
`tail`/`head`/`--silent` because the raw output is noisy.

## Install

```
cp -r extensions/node-project ~/.pi/agent/extensions/node-project
```
or load it explicitly:
```
pi -e /abs/path/to/extensions/node-project/index.ts
```
No runtime dependencies (only pi's ambient `typebox` / `@earendil-works/pi-tui`).

## Parameters

| param | type | applies to | meaning |
|---|---|---|---|
| `action` | `install` \| `typecheck` \| `test` \| `build` \| `outdated` \| `info` | — | what to run (required) |
| `projectDir` | string | all | dir to run in (absolute, or relative to cwd; default cwd). The nearest `package.json` / `tsconfig.json` at or above it is discovered automatically, and the upward search stops at `$HOME` so a stray `~/package.json` can never become "the project" |
| `packages` | string[] | install, info | install: specs like `["web-tree-sitter@0.20.8","tree-sitter-wasms"]` (omit to install from package.json). info: report the installed version of these packages |
| `dev` | boolean | install | `--save-dev` |
| `noSave` | boolean | install | `--no-save` + prints the exact cleanup command |
| `files` | string[] | typecheck | check only these files (relative to `projectDir` or absolute) |
| `tsconfig` | string | typecheck | explicit tsconfig path (default: auto-discover) |
| `script` | string | test, build | package.json script name when it is not literally `test`/`build` (e.g. `test:unit`) |
| `extraArgs` | string[] | all | args appended verbatim (e.g. `["--legacy-peer-deps"]`, `["--strict"]`) |
| `outputMode` | `diagnostics` (default) \| `summary` \| `raw` | all | `diagnostics` = only actionable output; `summary` = counts only; `raw` = also append the capped raw child output |
| `timeoutSec` | number | all | kill the child after N seconds (defaults: install 300, typecheck 180, test/build 600, outdated 120, info 60) |

Every result starts with a `cmd:` line containing the exact command that ran, plus (for typecheck)
`tsc:`, `config:` and — when applicable — `types:` provenance lines.

## Bash idioms it replaces

| instead of | call |
|---|---|
| `npx --yes tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --esModuleInterop --allowImportingTsExtensions a.ts b.ts` | `{"action":"typecheck","files":["a.ts","b.ts"]}` |
| `npx tsc --noEmit -p tsconfig.json 2>&1 \| head -40` | `{"action":"typecheck"}` |
| `npm install pkg@1.2.3 --silent 2>&1 \| tail -3` | `{"action":"install","packages":["pkg@1.2.3"]}` |
| `npm install --no-save typescript 2>&1 \| tail -2` … `npm uninstall typescript --no-save` | `{"action":"install","packages":["typescript"],"noSave":true}` (cleanup command printed in the result) |
| `npm install -D vitest 2>&1 \| tail -3` | `{"action":"install","packages":["vitest"],"dev":true}` |
| `npm test 2>&1 \| tail -30` | `{"action":"test"}` |
| `npm run build 2>&1 \| tail -20` | `{"action":"build"}` |
| `npm run test:unit 2>&1 \| tail -20` | `{"action":"test","script":"test:unit"}` |
| `npm outdated \|\| true` | `{"action":"outdated"}` |
| `cat package.json \| jq .scripts; node -v; npm -v; ls node_modules; ls node_modules/x/package.json` | `{"action":"info","packages":["x"]}` |

## What it does that a hand-typed command does not

- **`npx tsc` is a trap.** The `tsc` npm package is a deprecated stub: `npx --yes tsc --noEmit x.ts`
  prints "This is not the tsc command you are looking for" and never compiles anything. This tool
  prefers a local `node_modules/.bin/tsc` and otherwise runs `npx --yes -p typescript@5 tsc`,
  reporting which in the `tsc:` line (`local .../tsc (typescript 5.9.3)` vs `npx -p typescript@5`).
- **Pi extensions type-check for real.** A pi extension directory usually has no `node_modules`, so a
  plain tsc run reports every `@earendil-works/*` / `typebox` / `node:*` import as TS2307 and
  silently checks nothing. When the target files import pi's ambient packages and they are not
  resolvable locally, this tool generates a temp tsconfig that maps them to pi's own installation and
  says so via `types: pi-runtime-fallback`. That is what makes real pi-API bugs (e.g.
  `theme.dim(...)`, an `onUpdate` partial missing `details`) visible.
- **Respects your tsconfig.** With a tsconfig present and no `files`, it is a pure
  `tsc --noEmit -p <your tsconfig>`. With `files`, it generates a temp config that `extends` yours and
  sets `files` **plus `include: []`** — without the empty include, TS unions your `include` with
  `files` and reports diagnostics for files you did not ask about.
- **Never writes into the project.** `--noEmit` is always forced, and for `composite`/`incremental`
  projects (which emit a `.tsbuildinfo` even under `--noEmit`) the build-info file is redirected to a
  temp dir, so checking a read-only repo leaves it untouched.
- **Diagnostics are deduped, normalized and capped**: `file:line:col TSxxxx message`, paths relative
  to `projectDir`, max 40 shown (then per-file counts), max 500 chars per diagnostic. A clean run is
  a single `✓ typecheck clean` line.
- **Environment vs code errors are separated.** Unresolved *bare* imports (missing node_modules) are
  grouped into one `unresolved imports (N, ENVIRONMENT not code)` line with an install hint;
  unresolved *relative* specifiers (`./agents.ts`) stay real errors.
- **It refuses to fake a clean bill of health.** If imports are unresolved and there are 0 code
  diagnostics, everything from those imports is `any`, so the output says
  `⚠ INCOMPLETE CHECK` and `details.checkComplete=false` instead of "0 errors". (Verified: two real
  type errors disappear when the imports stop resolving.)
- **npm failures are classified**, not dumped: `E404 package does not exist`, `network unreachable /
  registry offline`, `ERESOLVE peer conflict (retry with extraArgs:["--legacy-peer-deps"])`,
  `EACCES`, `ENOSPC`. Stack traces and object dumps are stripped.
- **Test failures come first, with reasons**: jest / vitest / node:test (both the spec and TAP
  reporters) / mocha summaries are parsed, each failing test is listed with its assertion message,
  and build scripts that run `tsc` get their diagnostics parsed the same way as `typecheck`. If
  nothing is recognized, you get the last 40 lines (what `| tail -30` would have given you).
- **Missing script → the list of available scripts**, instead of an opaque npm error.

## Result `details` (machine-readable)

`action`, `projectDir`, `command`, `exitCode`, `durationMs`, `timedOut`, and per action:
`diagnostics`, `errors`, `unresolvedImports`, `checkComplete`, `tscSource` (`local` | `npx`),
`typeSource` (`project` | `pi-runtime-fallback` | `degraded-unresolved-imports`), `tsconfig`,
`script`, `outdated`, `available` (scripts), `error` (`missing-dir` | `no-package-json` |
`missing-script` | `missing-file` | `missing-tsconfig` | `nothing-to-check` | `timeout` | `spawn`).

## Safety

- `install` with named packages asks for confirmation in interactive sessions (`ctx.hasUI`); it runs
  unattended in `--mode json` / print mode.
- No shell is used (`spawn` with an argv array), so package names and paths cannot be word-split or
  interpreted as shell syntax.
- Child processes are killed (SIGTERM then SIGKILL) on `timeoutSec` and on session abort.

## Escape hatches / debugging

- `outputMode:"raw"` appends the (capped) raw child output — use it before falling back to bash.
- `PI_NODE_PROJECT_NO_TYPE_FALLBACK=1` disables the pi-types fallback mapping, forcing the degraded
  path (used to test the `⚠ INCOMPLETE CHECK` behavior).
- Anything outside these six actions (git, arbitrary node one-liners, `npm ci`, `npm publish`) is
  intentionally not covered — use `bash`.
