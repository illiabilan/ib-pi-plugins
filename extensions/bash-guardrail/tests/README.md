# bash-guardrail tests

No test framework, no dependencies — Node's built-in TypeScript stripping runs the
extension sources directly (Node ≥ 22.6).

```bash
cd extensions/bash-guardrail
node tests/classify.test.mjs      # must-never-block / must-block cases, BRE→ERE, shell quoting
node tests/hooks.test.mjs         # gating: anti-loop, escape hatch, availability, modes, /guardrail
node tests/fuzz.test.mjs          # 20k random inputs + edge cases: never throws, always decides
node tests/replay-labeled.mjs     # precision/recall against 200 hand-labelled real commands
node tests/extract-corpus.mjs --show block   # how it would classify YOUR session history
```

All four exit non-zero on failure, so they chain with `&&`.

## What each one guards

| File | Guards against |
|---|---|
| `classify.test.mjs` | over-blocking (heredocs, pipelines into scripts, `find -exec`, `$VAR`, loops, redirections, `\|\|` fallbacks) and regression of the mappings that must block; the BRE→ERE translation and the double-quote backslash rule — both were real silent-wrong-answer bugs |
| `hooks.test.mjs` | the safety gates in `index.ts`: never block the same command twice, escape hatch, user-dictated / explicit-shell requests, replacement tool inactive, tool detection failure, `PI_BASH_GUARDRAIL=nudge\|off`, nudge dedupe, `/guardrail` counters, and fail-open when session state throws |
| `fuzz.test.mjs` | parser robustness — an exception in the hook would be a (caught) failure to guard, and a crash in a non-guarded copy would break `bash` |
| `replay-labeled.mjs` | precision drift on real commands. `labeled.json` holds 200 commands sampled from ~/.pi/agent/sessions (81 block / 64 nudge / 55 allow by hand). The test FAILS if any command labelled nudge/allow gets blocked |
| `extract-corpus.mjs` | your own history, before you trust it: reads real sessions and prints the decision distribution and the concrete block list |
