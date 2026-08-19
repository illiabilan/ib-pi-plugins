# pi-plugins

A collection of Pi extensions, tools, skills, agents, and prompts —
organized to mirror Pi's own resource layout
(`~/.pi/agent/{extensions,skills,agents,prompts}`).

```
pi-plugins/
├── extensions/     # Pi extensions (tools, widgets, infrastructure)
│   ├── active-subagents-widget/
│   ├── archive-inspect/
│   ├── bash-guardrail/
│   ├── code-search/
│   ├── code_viewer/
│   ├── diff/
│   ├── env-info/
│   ├── file-ops/
│   ├── file-write-plus/
│   ├── gh/
│   ├── git/
│   ├── gradle-build/
│   ├── grep/
│   ├── jira/
│   ├── list-files/
│   ├── multi-file-read/
│   ├── node-project/
│   ├── path-stats/
│   ├── pi-trace/
│   ├── podman-sandbox/
│   ├── process/
│   ├── subagent/
│   └── token-stats/
├── skills/         # SKILL.md packages, loaded on-demand
│   ├── agentic-tool-validation-loop/
│   ├── pi-extension-builder/
│   └── pi-agent-builder/
├── agents/         # Subagent definitions (used by extensions/subagent)
│   ├── pi-builder.md
│   ├── agent-builder.md
│   └── code_writer.md
└── prompts/        # Prompt templates (/command expansions)
    ├── build-tool.md
    └── build-agent.md
```

## What's here

### Extensions

#### `extensions/code-search`
Fast, syntax-aware code navigation via tree-sitter. Registers a `code_search`
tool the LLM can call to find symbol declarations (functions, classes,
interfaces, etc.) across a codebase, with precision that plain-text search
(grep) can't match for ambiguous names, comment/string false positives, or
mid-session file edits. See `extensions/code-search/README.md`.

#### `extensions/active-subagents-widget`
TUI widget that displays currently active subagent delegations in real-time.
Shows active subagent tasks, their agents, and status. Includes full validation
reports and test documentation.

#### `extensions/code_viewer`
Auto-tags un-tagged fenced ` ``` ` code blocks in assistant responses (JSON,
bash, Python, JS/TS, Go, Rust, Java, C#, C/C++, SQL, YAML, HTML, CSS,
Dockerfile) using deterministic, precision-first sniffers, so Pi's built-in
Markdown renderer syntax-highlights them exactly as it does for correctly
tagged fences. Already-tagged fences and ambiguous content are left
untouched. See `extensions/code_viewer/README.md`.

#### `extensions/grep`
Ripgrep-backed search: regex, context lines, batched `queries`, file-name
globbing, `include`/`exclude`, and the flags that used to force a bash
fallback — `invertMatch` (-v), `notPattern` (`| grep -v`), `outputMode`
(content/filesOnly/count/exists), `onlyMatching` + `captureGroup` with value
aggregation, `wordBoundary`, `maxLineLength`.

### The bash-replacement set

Built from an analysis of 266 real sessions (2160 tool calls, of which **bash
was 1334 — 62%**; 1539 shell commands in total). Each tool below targets a
measured cluster of those commands; each was validated head-to-head against
the bash idiom it replaces, not just written. See each extension's README for
its own numbers.

| Extension | Tool(s) | Replaces | bash calls in corpus |
|---|---|---|---|
| `list-files` | `list_files` | `find -name/-type/-maxdepth/-newermt`, `ls -la`, `ls \| grep` | 356 |
| `grep` | `grep` | `grep -v/-o/-c/-q`, `\| grep -v`, `\| wc -l` | 606 |
| `file-ops` | `file_ops` | `rm -rf`, `mkdir -p`, `cp`, `mv`, `ln -s`, `chmod` | 195 |
| `git` | `git` | `git status/diff/log/show/commit/push/...` | 148 |
| `pi-trace` | `pi_trace` | `pi -p --mode json > log` + `node -e` trace parsers | 250 |
| `node-project` | `node_project` | `npm install`, `npx tsc --noEmit ...` | 102 |
| `path-stats` | `path_stats` | `wc -l`, `wc -c`, `du -sh`, `stat` | 88 |
| `process` | `process` | `cmd & sleep N; kill -9 $!`, `kill -0` poll loops | 72 |
| `gradle-build` | `gradle_build` | `./gradlew ... \| grep -E "FAILED\|error:"` | 60 |
| `file-write-plus` | `append_file`, `replace_in_file` | `cat >> f <<EOF`, `sed -i`, inline python rewrites | 52 |
| `diff` | `diff` | `diff -u a b \| head` | 40 |
| `env-info` | `env_info` | `which`, `command -v`, `env \| grep KEY` | 28 |
| `archive-inspect` | `archive_inspect` | `unzip` + `javap` over gradle-cache jars | 24 |
| `gh` | `gh` | `gh pr create/view/search/merge` | 15 |
| `bash-guardrail` | *(no tool)* | intercepts leftover bash habits | — |

Highlights from validation: `list_files` matches `find` byte-for-byte on 23715
files in 4.2 s vs 57 s; `node_project` cuts a typecheck task by 79–94% tokens;
`env_info` prevented a real 192-char API token from being written to the
session log, which the bash baseline leaked; `file_ops` and `git` refused every
unapproved mutation, including when told "don't ask me"; `archive_inspect`
reproduces `javap` output byte-identically.

#### `extensions/bash-guardrail`
A `tool_call` interceptor (registers no tool, so it costs **0 prompt tokens**).
Blocks single-intent bash commands that have an exact tool equivalent —
answering with the concrete replacement call, arguments already filled in —
nudges composite pipelines, and silently allows real shell work. Fails open.
BLOCK precision measured at 100% (0 false blocks) on 200 hand-labelled commands
drawn from 1963 real bash calls. `/guardrail` toggles block → nudge-only → off.

#### `extensions/jira`
Jira integration for Pi. Read, search, create, update, and link Jira issues
via the Jira REST API. Supports custom field conventions and JQL queries.

#### `extensions/multi-file-read`
Efficiently read multiple files in one call with line numbers, per-file limits,
and shared byte budget. Includes smoke tests and risk verification.

#### `extensions/podman-sandbox`
Routes the `bash` tool (and `!`/`!!` user-bash) into an isolated, long-lived
Podman container per project - separate filesystem root, PID namespace, and
(by default) network namespace, with the project directory bind-mounted so
`read`/`write`/`edit`/`grep`/`find`/`ls` keep working unmodified on the host.
Fails open with a machine-visible `[podman-sandbox: UNSANDBOXED fallback...]`
tag when podman is unavailable (or fails closed via config). See
`extensions/podman-sandbox/README.md`.

#### `extensions/subagent`
Pi's subagent primitive (delegated, isolated-context agent runs). Required
by `agents/pi-builder.md`. Copied from Pi's own examples.

#### `extensions/token-stats`
Track and report token usage statistics during Pi sessions.

### Skills

#### `skills/agentic-tool-validation-loop`
A methodology + working scripts for empirically proving (or disproving)
claims about agentic tools — "does this reduce tokens," "is this accurate" —
via head-to-head `pi --mode json` benchmarks, raw trace inspection, and
adversarial testing, instead of assuming. Includes `scripts/run-pair.sh`,
`scripts/analyze-trace.js`, `scripts/compare.js`.

#### `skills/pi-extension-builder`
The creation-phase counterpart — how to build Pi extensions/tools/prompts
correctly the first time, encoding real bugs found while building
`code-search` (API misuse, dependency traps, lifecycle races, precision
pitfalls at scale, WASM/native binding gotchas).

#### `skills/pi-agent-builder`
The agent-building counterpart to `pi-extension-builder` - how to design a
*new subagent definition* (frontmatter, tool restriction paired with an
explicit boundary in the system prompt, model selection, a chainable output
format), and how to adapt the validation-loop methodology to behavioral/
boundary claims rather than pure token-cost claims. Includes a hard-won
lesson: a single passing boundary test does not prove a behavioral claim
(LLM output is probabilistic) - see the skill for the concrete example
where this was proven by a same-agent re-run behaving oppositely.

### Agents

#### `agents/pi-builder.md`
A subagent definition that chains both skills into one autonomous loop:
build something (`pi-extension-builder`), then empirically validate it
(`agentic-tool-validation-loop`) before reporting done. Invoked via the
`subagent` extension.

#### `agents/agent-builder.md`
Mirrors `pi-builder.md` but one level up: builds *new agent definitions*
using `pi-agent-builder`, then validates the new agent's behavior using
`agentic-tool-validation-loop`. Used to build `agents/code_writer.md` as a
worked example.

#### `agents/code_writer.md`
A narrow-scope implementation agent (built by `agent-builder`): implements
an already-scoped code change, explicitly refuses to make architectural
decisions or expand scope unrequested. Independent re-verification found
its boundary adherence is not 100% reliable on ambiguous prompts - see
`pi-agent-builder`'s §6 for what this revealed about single-trial
behavioral testing in general.

### Prompts

#### `prompts/build-tool.md` / `prompts/build-agent.md`
`/build-tool <description>` and `/build-agent <description>` - convenience
wrappers that delegate to `pi-builder` and `agent-builder` respectively.

## Deployment: what to load globally vs per project

Tool schemas are not free — they are re-sent (and cache-written) on every
session. Measured with `pi --mode json -p --no-session "Reply with exactly: ok"`
reading turn-1 `input + cacheWrite`:

| Setup | Prompt tokens |
|---|---|
| Before any of these tools | 15,008 |
| All 14 loaded globally (naive) | 46,187 |
| Global set only, after scoping | 29,878 |
| Same, after the schema diet | **23,666** |
| Inside `pi-plugins` (+ project-local set) | 34,665 |
| Inside an Android repo (+ project-local set) | 34,353 |

So: load the general-purpose ones globally and scope the rest to the projects
that need them via `.pi/extensions` (project-local extensions load only after
the project is trusted — `--approve`, or a saved entry in `trust.json`).

- **Global:** `grep`, `list-files`, `git`, `file-ops`, `path-stats`, `diff`,
  `file-write-plus`, `env-info`, `bash-guardrail`
- **Project-local, TypeScript/pi work:** `node-project`, `pi-trace`, `gh`,
  `process`
- **Project-local, Android/Gradle work:** `gradle-build`, `archive-inspect`,
  `gh`, `process`

```bash
# global
ln -sfn "$PWD/extensions/list-files" ~/.pi/agent/extensions/list-files

# project-local (from inside the target repo)
mkdir -p .pi/extensions
ln -sfn /path/to/pi-plugins/extensions/gradle-build .pi/extensions/gradle-build
echo ".pi/" >> .git/info/exclude   # keep it out of the shared repo
```

The schema diet that produced the last row cut 6,212 tokens (-29%) with a
27-case behavioural regression suite guarding every cut. One finding worth
repeating: **a guideline sentence that substitutes for a missing code-level
guard must never be merged into a longer bullet.** Stripping guidelines proved
that `file_ops`'s "preview → user approves → then confirm" rule *is* its safety
mechanism (unlike `git`, which enforces the same thing in code), and without it
the agent self-approved its own preview token within a single turn.

## Install everything globally

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents ~/.pi/agent/prompts ~/.pi/agent/skills

# Extensions
cp -r extensions/code-search ~/.pi/agent/extensions/code-search
(cd ~/.pi/agent/extensions/code-search && npm install)

cp -r extensions/active-subagents-widget ~/.pi/agent/extensions/active-subagents-widget
(cd ~/.pi/agent/extensions/active-subagents-widget && npm install)

cp -r extensions/grep ~/.pi/agent/extensions/grep
cp -r extensions/jira ~/.pi/agent/extensions/jira
cp -r extensions/multi-file-read ~/.pi/agent/extensions/multi-file-read
(cd ~/.pi/agent/extensions/multi-file-read && npm install)

cp -r extensions/subagent ~/.pi/agent/extensions/subagent
cp -r extensions/token-stats ~/.pi/agent/extensions/token-stats

cp -r extensions/code_viewer ~/.pi/agent/extensions/code_viewer
(cd ~/.pi/agent/extensions/code_viewer && npm install)

# bash-replacement set (no runtime dependencies — plain copy is enough)
for e in grep list-files git file-ops path-stats diff file-write-plus \
         env-info bash-guardrail; do
  cp -r "extensions/$e" ~/.pi/agent/extensions/"$e"
done
# and, per project that needs them:
#   node-project pi-trace gh process        -> TypeScript / pi tooling repos
#   gradle-build archive-inspect gh process -> Android / Gradle repos

# Skills
cp -r skills/agentic-tool-validation-loop ~/.pi/agent/skills/agentic-tool-validation-loop
cp -r skills/pi-extension-builder ~/.pi/agent/skills/pi-extension-builder
cp -r skills/pi-agent-builder ~/.pi/agent/skills/pi-agent-builder

# Agents + prompts
cp agents/pi-builder.md agents/agent-builder.md agents/code_writer.md ~/.pi/agent/agents/
cp prompts/build-tool.md prompts/build-agent.md ~/.pi/agent/prompts/
```

Then in any project:

```
/build-tool Build a Pi tool that <does something>.
```

or ask directly for `code_search` — it auto-loads once installed.

## Provenance

Everything here was built and empirically validated end-to-end (not just
written) — see each subdirectory's own README/SKILL.md for the specific bugs
found and fixed along the way, and `skills/agentic-tool-validation-loop` for
the methodology used to find them.
