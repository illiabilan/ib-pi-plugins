# pi-plugins

A collection of Pi extensions, tools, skills, agents, and prompts —
organized to mirror Pi's own resource layout
(`~/.pi/agent/{extensions,skills,agents,prompts}`).

```
pi-plugins/
├── extensions/     # Pi extensions (tools, widgets, infrastructure)
│   ├── active-subagents-widget/
│   ├── code-search/
│   ├── grep/
│   ├── jira/
│   ├── multi-file-read/
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

#### `extensions/grep`
Enhanced grep functionality for Pi with regex support, context lines, and
configurable output limits. Provides text pattern search capabilities.

#### `extensions/jira`
Jira integration for Pi. Read, search, create, update, and link Jira issues
via the Jira REST API. Supports custom field conventions and JQL queries.

#### `extensions/multi-file-read`
Efficiently read multiple files in one call with line numbers, per-file limits,
and shared byte budget. Includes smoke tests and risk verification.

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
