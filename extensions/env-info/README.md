# env-info

Registers the `env_info` tool: probe the local environment (installed CLIs, environment
variables, runtime, pi's own install, project dependency versions) in **one tool call
with always-on secret redaction**, instead of a shell round trip.

Install: symlink or copy this directory into `~/.pi/agent/extensions/env-info`
(or load ad hoc with `pi -e /path/to/extensions/env-info/index.ts`).

## Why it exists

In 266 real pi sessions (1539 bash commands), 28+ commands were pure environment
probes — `which`/`command -v` (18), env-var inspection (10) — plus one-offs like
`readlink ~/.pi/agent/extensions/grep` and `node -e "console.log(require('./package.json'))"`.
Worse, the agent had to invent secret masking on the fly, e.g.
`env | grep -i "API_KEY" | sed 's/=.*/=SET/'`. **That approach leaks:** in a real
head-to-head run for this extension, the bash path wrote a masking loop that
accidentally expanded the values (`${!var}`) and printed two API keys verbatim into
the transcript *and* the persisted session JSONL, while intending to hide them
("- not shown"). `env_info` makes that failure mode impossible.

## Bash idioms it replaces

| bash | env_info |
|---|---|
| `which gh`, `command -v node`, `type -p rg` | `{"action":"tools","tools":["gh","node","rg"]}` |
| `which gh && gh --version`, `for t in ...; do ...; done` | same call — path + version for every tool, in parallel |
| `env \| grep -i API_KEY \| sed 's/=.*/=SET/'` | `{"action":"env","envPattern":"API_KEY"}` |
| `echo $JAVA_HOME`, `printenv JIRA_API_TOKEN` | `{"action":"env","envVars":["JAVA_HOME","JIRA_API_TOKEN"]}` |
| `node -v`, `uname -sm`, `echo $SHELL`, `pwd` | `{"action":"runtime"}` |
| `pi --version`, `ls ~/.pi/agent/extensions`, `readlink ~/.pi/agent/extensions/grep` | `{"action":"pi"}` |
| `node -e "console.log(require('./package.json'))"`, `cat package.json \| jq .devDependencies` | `{"action":"package","projectDir":"."}` |
| `npm view <pkg> version` | `{"action":"package","packages":["<pkg>"],"includeLatest":true}` |

Still needs bash: running a tool's real subcommands (`gh auth status`, `adb devices`),
arbitrary file reads. The tool description says so explicitly, and this was verified —
asked "am I logged in to the GitHub CLI?", the agent correctly used bash, not `env_info`.

## Parameters

| param | type | applies to | meaning |
|---|---|---|---|
| `action` | `"tools" \| "env" \| "runtime" \| "pi" \| "package"` | required | which probe to run |
| `tools` | `string[]` | tools | bare command names (`gh`, `gradle`, `adb`). Names with `/`, spaces or a leading `-` are **rejected, not executed**. Max 24/call. Default: `git node npm python3 rg gh java gradle docker` |
| `includeToolVersions` | `boolean` (default `true`) | tools | `false` = presence/path only, no child processes |
| `versionTimeoutMs` | `number` (default 5000, max 20000) | tools | per-probe timeout; a hang is reported as `?timeout`, never as absent |
| `envVars` | `string[]` | env | exact names; unset names are reported as `unset` |
| `envPattern` | `string` | env | case-insensitive regex over variable **names** (`"API_KEY\|TOKEN"`, `"^JIRA_"`). Invalid regex throws with a usage hint. Max 200 vars reported |
| `projectDir` | `string` | package | project dir (default cwd); relative paths resolve against cwd |
| `packages` | `string[]` | package | dependency names (scoped names OK). Omit to list all declared deps (max 80) |
| `includePackageVersions` | `boolean` | package | resolve installed versions from `node_modules` (default: `true` when `packages` is given, else `false`) |
| `includeLatest` | `boolean` (default `false`) | package | **network**: query `registry.npmjs.org` for the newest published version |

`action=env` with neither `envVars` nor `envPattern` reports a default common set
(PATH, HOME, SHELL, JAVA_HOME, CI, …).

## Secret redaction (always on, not a parameter)

A value is withheld when **any** of these hold:

1. **Name** matches `KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PWD$|PASSPHRASE|CREDENTIAL|CREDS|COOKIE|AUTH|BEARER|PRIVATE|SIGNING|SALT|OTP|SESSION_ID` → `reason: secret-name`.
2. **Value** matches a known credential shape → `reason: credential-pattern:<label>`
   (`ghp_`/`github_pat_`, `sk-`/`sk-ant-`, `xox*-`, `AKIA`/`ASIA`, `ATATT`, `AIza`,
   JWT `eyJ…`, PEM private keys, `scheme://user:password@host`).
3. **Value looks high-entropy** (≥20 chars, letters+digits, no dotted-identifier shape,
   Shannon entropy ≥ 3.3 bits/char) → `reason: high-entropy-value`. A small allowlist
   (`PATH`, `HOME`, `LS_COLORS`, `JAVA_HOME`, …) is exempt from *this rule only* — a
   `ghp_…` inside `PATH` is still redacted by rule 2.

Redacted entries report `set`, `len=<chars>[/bytes]`, `fp=<8 hex>` and, only when the
value is ≥20 chars, a 2-character prefix (short secrets get **no** prefix). `fp` is
`HMAC-SHA256(random-per-process-salt, value)`: stable within one pi process (so
"did this value change?" is answerable), not reversible, not comparable across
sessions or machines.

Over-redaction is deliberate: on this machine `action=env` with `envPattern:"."`
redacted 6 of 64 variables — both real credentials plus 4 harmless ones
(`SSH_AUTH_SOCK`, `KITTY_PUBLIC_KEY`, `PI_SESSION_ID`, `LaunchInstanceID`). A useless
redaction is an annoyance; a leaked token in a session log is an incident. Every
redaction carries its `reason`, so the agent can see *why*.

Non-secret values are still escaped (`\n`, `\t`, control chars → `\xNN`) and capped at
400 chars, so a hostile variable value cannot inject fake lines into the tool output.

## Provenance / confidence tags

Anything with more than one code path says which one produced it:

- `versionStatus`: `ok` (trust the version) | `timeout` | `no-version-output` | `failed`
  | `not-executable` | `skipped` | `aborted`. Only `ABSENT` means "not installed".
- `kind`: `binary` | `shell-builtin` | `shell-builtin+binary` (macOS `cd` is both;
  `command -v` prefers the builtin, `which` reports the binary).
- `versionSource`: which flag produced the version (`--version`, `-version`, `version`).
- pi `versionSource`: `running-process` (read from the package.json of the pi CLI that
  is actually executing — authoritative) | `imported-module` | `unknown`. If a bundled
  `@earendil-works/pi-coding-agent` copy disagrees with the running CLI, the mismatch
  is printed.
- package `installedSource`: `node_modules` | `none`; `latestSource: registry.npmjs.org`
  for `includeLatest` (with `latestError` when the network call fails).
- `rangeCheck`: `ok` | `mismatch` | `unknown` | `not-installed` | `not-declared` —
  only `^`, `~` and exact ranges are judged; anything else reports `unknown` rather
  than guessing.
- `envSource` (runtime): `login-shell-like` | `uncertain` | `minimal-like`, with the
  individual markers listed. This aligns with the jira extension's
  `config_source: env` vs `shell-profile` notion: a non-login-shell environment is
  exactly when env-configured extensions lose their credentials.

## Error convention

pi's agent loop derives "this tool call failed" from a **thrown** exception and ignores
an `isError` field on a returned result (verified in
`pi-agent-core/dist/agent-loop.js`). So `env_info` throws for invalid input (unknown
action, malformed `envPattern`) and returns a normal, explanatory result for
"the fact you asked about is absent" (tool not installed, no `package.json` in the
directory) — those are answers, not failures.

## Testing

```bash
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --skipLibCheck --esModuleInterop --allowImportingTsExtensions --strict index.ts

node verify.mjs        # 119 assertions: ground truth vs `command -v`, redaction
                       # contract, hang/timeout, non-executable, builtins, unicode,
                       # empty/short secrets, huge values, range checks, abort, renderers
node smoke-test.mjs '{"action":"tools","tools":["gh","kubectl"]}'
node size.mjs "$PWD/index.ts"   # LLM-facing text budget (description+guidelines+schema)
```

`verify.mjs` creates its fixtures under `/tmp/envx-bin` and `/tmp/envx-pkg-*`
(a hanging `--version`, a `chmod 000` binary, a version-on-stderr binary).

## Cost note (measured, claude-sonnet-5)

The tool's schema + description + guidelines add **~1650 tokens** to the cached system
prompt (one `cacheWrite`, then `cacheRead` per turn). A single probe costs ~535 new
tokens via `env_info` vs ~847 via bash (the model has to author a shell script), so
break-even is roughly 4 probes in a 20-turn session. Below that, `env_info` is a small
net token cost and its value is the leak prevention and the semantics
(`ABSENT` vs `?timeout` vs `NOT-EXEC`), not token savings.

Free-text paths are scrubbed too: `scrubText()` strips credential-shaped substrings
from anything env_info echoes from an external source (settings.json extension/package
specs — a `git:x-access-token:<TOKEN>@github.com/...` spec would otherwise be printed
verbatim — and a tool's own `--version` banner).
