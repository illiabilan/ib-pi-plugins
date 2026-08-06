---
name: pi-extension-builder
description: Builds Pi extensions, custom tools, commands, prompt templates, and skills correctly the first time, encoding hard-won lessons (API pitfalls, dependency traps, lifecycle races, precision bugs) discovered by actually building and empirically validating a real tool. Use when asked to build/create/scaffold a Pi extension, custom tool, slash command, prompt template, or skill. Always finish by invoking the agentic-tool-validation-loop skill before declaring the work done.
---

# Pi Extension Builder

A playbook for building Pi extensions/tools/prompts/skills that actually work,
not just compile. Every rule below is a real bug found while building a real
tool (`code_search`), not a hypothetical best practice.

**This skill covers creation. It does not cover verification — when you
reach the end of this playbook, you MUST load and follow the
`agentic-tool-validation-loop` skill before reporting the work done. Building
something that type-checks and runs once is not the same as it working, being
efficient, or being safe — see that skill for why, and how to prove it.**

## 0. Read the real docs first

Do not guess the API from memory. Read, in this order, following
cross-references as needed:

- `docs/extensions.md` — events, `ExtensionAPI`, `registerTool`,
  `registerCommand`, custom UI
- `docs/skills.md` — if building a skill instead of/in addition to a tool
- `docs/prompt-templates.md` — if building a prompt template
- `docs/packages.md` — if distributing this as an installable package
- `examples/extensions/` — find the closest existing example and mimic its
  structure exactly before improvising

(Resolve these under the pi package's installed docs/examples directories —
ask if unsure where that is in the current environment.)

## 1. Decide the right artifact type

| You want | Build |
|---|---|
| LLM calls this autonomously as part of solving a task | A **tool** (`registerTool`) |
| User types `/name` to invoke it | A **command** (`registerCommand`) |
| A reusable, on-demand instruction set + optional scripts | A **skill** (`SKILL.md`) |
| A canned `/template` expansion of boilerplate text | A **prompt template** |
| An isolated, delegatable autonomous task-runner | A **subagent** (`agents/*.md` + the `subagent` extension) |

Don't build a tool when a skill would do, and vice versa — a tool costs
context on every single LLM turn (its schema is sent every request); a skill
only costs context when the agent decides to load it.

## 2. Scaffolding

- Single file for small extensions; a directory with `index.ts` for
  multi-file; a directory with `package.json` + `pi.extensions` field if it
  needs npm dependencies.
- **Runtime dependencies go in `dependencies`, not `devDependencies`.**
  Installed packages run `npm install --omit=dev` in production — anything
  only in `devDependencies` silently won't exist at runtime. Put
  `@earendil-works/pi-coding-agent` and `typebox` types in `devDependencies`
  (they're ambient/type-only at runtime, pi provides them), everything the
  code actually `require`s/`import`s at runtime goes in `dependencies`.

## 3. Dependency selection — verify before you write

- **Check the package actually exists at the version you're about to write.**
  `npm view <pkg> versions --json` before putting anything in `package.json`.
  Guessed version numbers fail installs and waste a full round-trip.
- **Prefer pure-JS/WASM packages over native (node-gyp) bindings** when the
  extension might run on other machines/CI — native bindings bring peer-dep
  and platform-compile fragility that WASM equivalents avoid. (Concretely:
  `web-tree-sitter` + `tree-sitter-wasms` over native `tree-sitter` +
  per-language native grammar packages — same capability, far more portable.)
- **When two packages must interoperate at a binary/ABI level** (e.g. a
  WASM runtime + prebuilt grammar files compiled against a specific version
  of it), pin exact versions rather than semver ranges, and verify they
  actually load together with a throwaway script before wiring them into the
  real extension. A minor version mismatch can fail with an opaque runtime
  error instead of an install-time error.
- **Verify library API behavior with a tiny standalone script before trusting
  it**, especially anything not obvious from the type definitions:
  initialization ordering (does a class attribute exist before or only after
  an async `.init()` resolves?), iteration/ordering guarantees (does a query
  API really preserve declaration order for overlapping matches? — often no),
  lifetime/memory rules (can derived values be read after an explicit
  `.delete()`/free call on the object they came from? — often no, and the
  failure is silent empty/garbage data, not a thrown error).

## 4. Correct `registerTool` usage (each of these was a real bug)

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",            // sent to the LLM every turn — be precise
  promptSnippet: "...",          // one-line summary in "Available tools"
  promptGuidelines: [
    // Each bullet MUST name the tool explicitly — bullets are flattened
    // into the Guidelines section with NO tool-name prefix. "Use this tool
    // when..." is ambiguous to the model; "Use my_tool when..." is not.
    "Use my_tool when ...",
  ],
  parameters: Type.Object({ ... }),  // typebox schema
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // onUpdate partial results need the SAME shape as the final return
    // (content + details), not just content — a details-less partial is a
    // type error and, if you bypass the type checker, a runtime shape bug.
    onUpdate?.({ content: [...], details: {} });
    return { content: [{ type: "text", text: "..." }], details: {...} };
  },
  // renderCall/renderResult return a Component (e.g. `new Text(str, 0, 0)`
  // from "@earendil-works/pi-tui"), NOT a plain string.
  renderCall(args, theme) {
    // theme exposes fg(colorName, text) and bold(text) — there is no
    // theme.dim()/theme.error() method; use theme.fg("dim", text) etc.
    return new Text(theme.fg("accent", "..."), 0, 0);
  },
});
```

Other API specifics that are easy to get wrong from intuition:
- `ctx.ui.select(title, options: string[], opts?)` — options are plain
  strings, not `{label, value}` objects. Encode extra info into the string
  itself if needed.
- `ctx.ui.confirm/input/notify` — check `ctx.hasUI` before calling
  interactive dialogs; they're no-ops or unavailable in print/JSON mode.

## 5. Lifecycle and state correctness (races that produce silently wrong data)

- **Never start long-lived background work (timers, indexes, watchers,
  processes) inside the extension factory function.** Start it in
  `session_start` or on first use; the factory can run in invocations that
  never start a session.
- **Always register `session_shutdown`** to cancel pending timers/intervals.
  Without this, a debounced callback can fire after teardown against a
  `ctx` that throws when touched — caught in practice as a real crash, not a
  hypothetical one.
- **If a tool depends on background-built state that might still be
  building when the tool is called, store and `await` the in-flight
  Promise** — don't just check-and-skip a boolean "isBuilding" flag. A
  check-and-skip race silently returns wrong/empty data instead of waiting;
  this is worse than being slow, because it looks like a normal empty
  result instead of an error.
- **If a tool's correctness depends on external state that the agent itself
  can change (files on disk, a database, a running process), add
  invalidation hooks** (e.g. `pi.on("tool_result", ...)` for `edit`/`write`)
  rather than assuming a one-time build stays valid for the whole session.
  A stale cache that confidently returns outdated data is worse than one
  that visibly fails, because nothing signals the answer might be wrong.

## 6. If building any kind of search/matching/scoring logic

- **Naive fuzzy/substring matching has near-zero precision at scale.**
  "Character subsequence somewhere in the string" or "contains as a
  substring" looks fine on a 10-item test fixture and floods with false
  positives on a 250,000-item real index. Test scoring/ranking logic against
  a REAL large corpus, not just a toy fixture, before trusting it.
  Camelcase/word-boundary-aware fuzzy matching (match against the initials
  of each hump, not raw subsequence of the whole string) is a much higher
  precision default for identifier search.
- **When a scoring/matching algorithm has a "loose" fallback tier**, cap how
  many of its results can ever surface with a small absolute number, not a
  number proportional to the caller-requested limit — otherwise a caller
  that asks for more results reintroduces exactly the flood you capped.
- **If a result can come from more than one code path with different
  reliability** (e.g. a precise parser vs. a text-matching fallback used
  when the parser is unavailable), tag each individual result with its
  provenance/confidence (e.g. `source: "ast" | "regex-fallback"`) and only
  annotate the exceptional/lower-confidence case in the output — this lets
  the tool's own guidance be conditional ("trust X, verify Y") instead of a
  blanket claim that's only true most of the time.

## 7. Development workflow

- **Type-check before deploying.** `jiti` loads `.ts` directly without a
  build step, so type errors don't surface until the exact code path is
  hit at runtime. Run a standalone check first:
  ```
  npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
    --skipLibCheck --esModuleInterop --allowImportingTsExtensions <files>
  ```
- **Smoke test before installing globally.** Use
  `pi -e ./path/to/extension.ts --mode json -p "call the tool with ... and report raw output"`
  and actually read the `tool_execution_start`/`tool_execution_end` events —
  "it didn't crash" is not the same as "it returned correct data."
  (If the extension auto-loads from `~/.pi/agent/extensions/`, drop the
  `-e` flag to avoid a duplicate-tool-name conflict with the auto-discovered
  copy.)
- **Deploy**: copy into `~/.pi/agent/extensions/<name>/` (global) or
  `.pi/extensions/<name>/` (project-local), then `npm install` inside it if
  it has a `package.json`.

## 8. Writing effective descriptions/guidelines (this measurably changes agent behavior)

- Write **decision rules, not feature lists**: "prefer X over Y when Z;
  prefer Y over X when W" — cover both directions, not just when to use it.
- Include a short **worked example** directly in the description when
  possible — concrete examples calibrate tool choice better than abstract
  descriptions.
- If output carries a machine-checkable confidence/provenance signal (per
  §6), reference it explicitly in the guidance so trust is conditional
  rather than absolute.

## 9. Mandatory final phase: empirical validation

Do not report this done yet. Load the `agentic-tool-validation-loop` skill
and apply it to what you just built:

1. State a falsifiable claim about the new artifact (reduces tokens for
   task X? is accurate for case Y? the agent uses it correctly without
   prompting?).
2. Run real head-to-head comparisons (`scripts/run-pair.sh`) in a
   representative environment.
3. Read the raw traces (`scripts/analyze-trace.js --full`,
   `scripts/compare.js --full`) — thinking blocks, full tool-result text,
   token deltas — not just the summary.
4. When something looks wrong, find the exact root cause and fix it, then
   re-run the exact same case to confirm.
5. Construct at least one adversarial case designed to break what you just
   built (ambiguity, look-alikes, scale, mid-session state changes,
   degraded fallback paths — see that skill for the full list) before
   calling it solid.
6. Report honestly: what's proven with numbers, what was fixed, what
   remains unverified.

A tool that type-checks and runs once but was never benchmarked or
adversarially tested is an unfinished tool, not a finished one.
