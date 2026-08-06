---
name: agentic-tool-validation-loop
description: Empirically validates and hardens agentic tools, extensions, prompts, or workflows — answers whether something actually helps the agent and is safe, with real measurement instead of assumption. Uses instrumented head-to-head benchmarks (pi --mode json traces covering tool calls, raw tool results, per-turn token deltas, and model reasoning), adversarial test design to find real failure modes, and a fix-then-regress iteration loop. Use when asked to benchmark, validate, optimize, or harden a custom tool or extension, when a claim about token savings or accuracy needs proof, or when told "are we sure this works" / "is this accurate".
---

# Agentic Tool Validation Loop

A methodology for empirically proving (or disproving) claims about agentic
tools — "does this reduce tokens," "is this accurate," "does the agent use
this correctly" — instead of asserting them. Discovered and refined by
actually doing this end-to-end on a custom `code_search` tool: the process
found and fixed 6 real bugs that pure code review would have missed, and
reversed an initial wrong hypothesis with real numbers.

**Core principle:** LLMs (including you) default to confident generalizations
about tool/agent behavior ("built-in tools use fewer tokens," "this is
accurate," "the model will trust this"). Treat every such claim as a
hypothesis to falsify, not a fact to report. The only convincing evidence is
a raw trace you actually read.

## When to use this

- Building or reviewing a custom tool/extension and asked "will this help?"
- A user asks "are we sure this is accurate/fast/safe?" — this is a command
  to go verify, not a request for reassurance.
- Comparing two approaches (tool vs. grep, prompt A vs. prompt B, model X vs.
  model Y) where the real answer depends on measured behavior, not intuition.
- After implementing a fix — to confirm it actually fixed the thing, not just
  that it compiles.

## The Loop

### 1. State the claim as falsifiable

Bad: "this tool is useful." Good: "this tool reduces tokens for symbol-lookup
tasks vs. grep" or "this index stays accurate after the agent edits files."
A vague claim can't be tested; a specific one can be proven wrong, which is
the point.

### 2. Build/acquire a real, working instance

No hypotheticals or code review alone. Install it, run it, in a real
environment. If validating against a codebase, prefer the actual target
codebase (or something representative of its scale/messiness) over a toy
example once toy tests have pointed a direction — toy examples hide the bugs
that only show up at scale (see: fuzzy-match precision only broke down on a
256k-symbol index, not a 10-symbol test file).

### 3. Design a head-to-head controlled comparison

Same prompt, same environment, WITH vs WITHOUT the thing being tested.

```bash
scripts/run-pair.sh <tool-name-to-exclude> <output-dir> "<prompt>" [extra pi args]
```

This runs `pi --mode json` twice — once normally, once with
`--exclude-tools <name>` — and saves both traces. `--mode json` is what makes
this whole methodology possible: it exposes tool calls, tool-call arguments,
full raw tool-result text, per-turn token usage (input/output/cacheWrite/
cacheRead), and the model's own `thinking` blocks. Without it you only see
the final answer and have no way to find root causes.

### 4. Read the raw evidence — not the summary

```bash
node scripts/analyze-trace.js <log-file>          # tool calls, tokens, final answer
node scripts/analyze-trace.js <log-file> --full   # + full tool-result text
node scripts/compare.js <with-log> <without-log>  # side-by-side + delta
node scripts/compare.js <with-log> <without-log> --full
```

**Read these in order of how likely they are to reveal the real mechanism:**

1. The model's `thinking` block, if captured (`--thinking high` on the run).
   This is often the single fastest way to find out *why* the agent did
   something — it will often say so directly ("the fuzzy results aren't
   helping, switching to grep").
2. The full raw text of each tool result. Bugs hide here: silent "index
   empty" fallbacks, noise-flooded results, wrong line numbers, results that
   don't match what the tool's description promises.
3. Per-turn token deltas, specifically `cacheWrite` (genuinely new content
   entering context this turn) vs `cacheRead` (cheap reuse of already-cached
   context). Comparing raw total tokens between two runs is misleading once
   caching is involved — a spike in `cacheWrite` on turn 1 of a "fixed"
   version, with `cacheRead: 0`, usually just means a tool schema changed and
   the cache had to be rebuilt once; it is not a recurring cost. Confirm by
   rerunning — `cacheWrite` should be near-zero and `cacheRead` should carry
   the prior total on the next run.
4. Only then, the summary numbers (total tokens, call counts).

### 5. When something contradicts the hypothesis, don't rationalize — find the exact mechanism

Reproduce it in isolation (a minimal script, a scratch directory, a single
forced condition) until you can name the precise cause: a race condition, a
scoring function that's too permissive, a non-deterministic library API, a
use-after-free, a stale cache. "It's probably fine" or "the model was just
being extra careful" are not root causes — keep digging until you have one
you can point at in the code or in a raw trace.

Concrete techniques that found real bugs in practice:
- Force a rare code path deliberately (e.g. rename/delete a dependency file
  to force a fallback path) to prove what happens when it's hit, rather than
  assuming it's fine because it's rare.
- Write a tiny isolated reproduction of a suspected library quirk (e.g. "does
  this query API really preserve pattern order?") before trusting an
  assumption baked into a fix.
- When a fix's own test looks wrong (e.g. all-empty names), suspect the fix
  itself before suspecting the input data.

### 6. Fix the root cause, then immediately re-run the exact failing case

Never conclude "fixed" from reading a diff. Re-run step 3-4 against the
*exact same* scenario that failed. This is a regression check, not optional —
it caught a bug introduced *while fixing a different bug* in this project
(a use-after-free introduced by a refactor meant to fix a match-ordering
issue), because the original repro was rerun immediately instead of assumed
fixed.

### 7. Escalate: construct adversarial cases designed to break your current belief

Once the straightforward case passes, don't stop — deliberately try to break
it. Ask: what's the case that's hardest for this to get right? For a
search/lookup tool, useful adversarial angles:

- **Ambiguity**: a name with many legitimate matches (overloads, same-named
  private methods in different classes) — does it disambiguate correctly?
- **Look-alikes that aren't real**: text that resembles what you're looking
  for but isn't (comments, string literals, log tags, commented-out code,
  test names that happen to contain the query as a substring).
- **Scale**: does something that works on 10 files still work on 250,000
  symbols? (Precision problems especially tend to appear only at scale.)
- **State changes mid-session**: does it stay correct after the agent edits,
  creates, or deletes the thing it's supposed to find? (Caches/indexes going
  stale after writes is a very common and easy-to-miss failure class.)
- **Degraded/fallback paths**: what happens when the primary mechanism is
  unavailable (a dependency fails to load, a network call times out)? Force
  it and check the fallback's actual behavior instead of assuming it's inert.
- **A skeptical question from the user is itself a test case** — if asked
  "are we sure this is accurate," that is the prompt to go run exactly this
  kind of adversarial test, not to answer in prose.

### 8. Repeat 3-7 until convergence

Either: the claim holds across a genuinely adversarial set of cases (state
this with the specific cases tried, not "it works"), or: the claim is
disproven/qualified ("X helps when ambiguity is high and the codebase is
large; it does not help — and can cost more — for simple unambiguous
lookups, because Y").

### 9. Bake learnings back into the artifact, not just into the conversation

Two kinds of fixes, both required:
- **Code fixes** for the actual bugs found.
- **Guidance fixes** — if the thing being validated is a tool an agent calls,
  update its `description`/`promptGuidelines` (or system prompt / skill
  description) to encode what was learned: when to prefer it, when not to,
  what its known limitations are, what a specific output marker means. A
  fixed tool that doesn't also teach the agent how to use it well only gets
  you half the benefit — this was worth a larger measured improvement in
  practice than most of the code fixes.

Where possible, make trust machine-checkable instead of only prose: e.g. tag
individual results with their confidence/provenance (`source: "ast" |
"regex-fallback"`) so the agent's guidance can be conditional ("trust X,
verify Y") rather than a blanket, eventually-false assurance.

### 10. Report honestly, including what's still unverified

State clearly: what was proven (with the specific numbers/cases), what was
fixed, and what remains an open risk that wasn't tested (e.g. "coverage
gaps almost certainly exist in less-common declaration forms we didn't
fuzz across all N languages"). A claim of "99% accurate" is itself a
hypothesis — don't make it without having tried to break the last 1%.

## A cross-cutting caveat: N=1 evidence and self-validation bias

Discovered concretely while validating an agent built with this same
methodology (`code_writer`, via the `pi-agent-builder` skill): a boundary
test run once and judged "passed" was then re-run independently 6 times on
near-identically-phrased tasks and failed all 6 - before a fix, then passed
3/3 after. The original single-trial validation wasn't just slightly
optimistic, it was actively wrong. This applies to tool/extension validation
under this skill too, not only to agent validation - in three specific ways:

1. **Any claim about how the AGENT chooses to use or trust a tool is
   probabilistic, even if the tool's own code is deterministic.** Whether
   the calling model picks your tool over grep, makes one call or two,
   trusts a result or redundantly re-verifies it - all of that is sampled
   LLM behavior, not a property of your code. A single observed run where
   "the agent used the tool correctly and didn't double-check" is one data
   point, not a proven behavior. State such claims as a rate across several
   independent runs (fresh process, same or varied phrasing), not a
   one-shot verdict.
2. **Claims about the tool's own deterministic logic** (does the search
   algorithm return the right answer for query X) generally don't need
   *repeated* trials of the *identical* case - re-running identical
   deterministic code gives the identical result. What they need instead is
   *diverse* adversarial cases (step 7) - breadth substitutes for repetition
   here, they are not the same requirement.
3. **Timing/race-dependent bugs are a middle case**: whether a background
   index finishes before the first tool call, for instance, can depend on
   model response latency and therefore vary run to run even with
   deterministic code. A single passing run after a fix for this class of
   bug is weaker evidence than for a purely deterministic fix - prefer
   re-running a few times, ideally under varied timing (e.g. a
   faster/slower model, a larger/smaller repo) before trusting it closed.

**Self-validation bias applies everywhere in this loop, for both tools and
agents.** Whoever builds the artifact and then validates it is prone to
running an easier or more leading test, and to interpreting ambiguous
output charitably - the same failure mode either way. A validation pass
produced by the same run/session that built the thing is a first data
point, not proof; prefer a fresh session or an independent phrasing for the
actual pass/fail determination wherever the cost of doing so is reasonable.

## Scripts reference

| Script | Purpose |
|---|---|
| `scripts/run-pair.sh <tool> <dir> "<prompt>" [pi args]` | Run the same prompt with/without a tool, save both traces |
| `scripts/analyze-trace.js <log> [--full]` | Summarize one trace: tool calls, thinking, token deltas, final answer |
| `scripts/compare.js <logA> <logB> [--full]` | Side-by-side diff of two traces with a metrics table |

All scripts work on any `pi --mode json -p "..."` output, not just paired
runs — useful standalone whenever you need to see what actually happened in
a session rather than trusting the final answer.

## Worked example (abbreviated)

```bash
# 1. Claim: "code_search reduces tokens vs grep for ambiguous symbol lookups
#    on large codebases."
# 2. Tool already built and installed.
# 3+4. Controlled comparison in the real target repo:
scripts/run-pair.sh code_search /tmp/bench1 \
  "List every file that DEFINES a function named handleEvent (not callers)."
node scripts/compare.js /tmp/bench1/with.jsonl /tmp/bench1/without.jsonl --full
# -> reveals code_search's raw result contains 2486 "matches", most garbage.
# 5. Root cause: naive character-subsequence fuzzy matching has near-zero
#    precision on a 250k-symbol index.
# 6. Fix: camelCase-hump-aware fuzzy matching + hard cap on weak matches.
# 6b. Re-run the exact same command — confirm result count drops from 2486
#     to 19, all genuinely relevant.
# 7. Adversarial case: force the regex-fallback path (rename the grammar
#    file) and plant a fake declaration inside a comment — confirm it's
#    found (proving the risk is real) AND correctly tagged (proving the fix
#    works), then confirm it disappears once the real parser is restored.
# 8. Repeat with a different adversarial case (index staleness after edits)
#    until no further contradictions found in a reasonable adversarial set.
# 9. Ship: code fix (index invalidation on edit/write) + guidance fix
#    (promptGuidelines telling the agent when to trust vs. verify results).
# 10. Report: "X% fewer tokens on ambiguous lookups; no improvement or a
#     regression on trivial unambiguous ones; N specific bugs found+fixed;
#     M known unverified risks remain."
```
