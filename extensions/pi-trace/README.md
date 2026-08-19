# pi_trace — run & analyze pi traces / A-B benchmarks

One tool that replaces the "spawn pi, then hand-write a JSONL parser" loop that shows up
constantly when benchmarking or validating agent behaviour (in a 266-session corpus: 150 bash
calls invoking `pi -p --mode json ... > /tmp/x.log` and ~100 throwaway `node -e '...'` scripts
re-implementing the *same* parser).

It understands both trace formats:

| Format | Produced by | Recognised by |
|---|---|---|
| `json-stream` | `pi --mode json -p ...` | `tool_execution_start/end`, `turn_end`, `agent_end` events |
| `session` | saved sessions in `~/.pi/agent/sessions/**.jsonl` | `type:"message"` entries with `role: assistant / toolResult / bashExecution` |

Format detection is automatic and per-file; a `--mode json` stream contains *both* event and
message records, and pi_trace deliberately reads the events only, so nothing is double counted.

## Actions

### `run`
Executes `pi --mode json -p --no-session <prompt>` in a **detached process group**, streams stdout
to a stored trace file, and returns a compact summary — exit status, wall time, turns, tool-call
sequence, token totals, final answer — **not** the raw log.

- Hard timeout (`timeoutSec`, default 180s, max 1800s). On expiry the *whole child process group*
  gets `SIGTERM`, then `SIGKILL` after 3s. This is the fix for the bash version's failure mode:
  `pi -p ... > log` under a shell `timeout`/`kill $PID` leaves grandchildren (e.g. a `sleep 300`
  started by the child's bash tool) alive and can hang the wrapper on the still-open pipe.
- Also aborts (and kills the group) when the parent agent turn is aborted.
- Traces are written to `traceDir` (default `$PI_TRACE_DIR`, else `<tmpdir>/pi-trace`) as
  `<label>-<ISO timestamp>.jsonl`.

### `analyze`
Parses one trace/session and renders a `view`:

| view | replaces | shows |
|---|---|---|
| `summary` (default) | `node -e '...length'` | header totals + tool sequence + first prompt + final answer |
| `tools` | `node -e 'ev.type==="tool_execution_start"'` | ordered calls with args digest, result size, ok/ERROR/NO RESULT |
| `tokens` | `node -e '...usage... sum cacheWrite'` | per-turn input/output/cacheRead/cacheWrite/cost + totals |
| `thinking` | `node -e 'c.type==="thinking"'` | the model's reasoning blocks |
| `toolResults` | `node -e 'result.content[0].text'` | **verbatim** tool result text (use `toolFilter`) |
| `full` | all of the above | tools → tokens → final answer → thinking → raw results (in that order, so the cap drops only the bulky tail) |

`tracePath` accepts an absolute/relative path **or a unique filename fragment** (e.g. a session-id
prefix `019fd6e8`), resolved against `traceDir` and the sessions dir — this replaces
`ls ~/.pi/agent/sessions/*/* | grep <id>`. Ambiguous fragments return the newest candidates
instead of guessing.

### `compare`
Two traces side by side (`tracePaths: [A, B]`, typically with-tool vs `--exclude-tools`) with
deltas for turns, tool calls, tool errors, input/output/cacheWrite, cacheRead, cost and wall time,
both tool sequences, and both final answers (answer *correctness* is left to the caller — the
output says so explicitly). Numbers match `agentic-tool-validation-loop/scripts/compare.js`.

### `list`
Newest-first inventory of stored runs (parsed: format/turns/calls/newTokens/tools) plus saved
session files (metadata only, so it stays fast over hundreds of files). `filter` is a substring
match on the path. Replaces `ls -t ~/.pi/agent/sessions/*/*.jsonl | head`.

## Parameters

| param | actions | meaning |
|---|---|---|
| `action` | all | `run` \| `analyze` \| `compare` \| `list` |
| `prompt` | run | prompt for the child pi |
| `cwd` | run | working dir for the child (default: session cwd) |
| `extensions` | run | `-e <path>` per entry (absolute paths) |
| `excludeTools` | run | `--exclude-tools a,b` — the "without" half of an A/B pair |
| `tools` | run | `--tools a,b` allowlist |
| `model` | run | `--model` pattern |
| `thinking` | run | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` (use `high` if you want `view:'thinking'` to have content) |
| `extraArgs` | run | extra pi CLI args, passed verbatim (no shell involved) |
| `timeoutSec` | run | wall-clock timeout, default 180, max 1800 |
| `label` | run | slug used in the stored trace filename |
| `traceDir` | run/analyze/compare/list | where run traces live (default `$PI_TRACE_DIR` or `<tmpdir>/pi-trace`) |
| `tracePath` | analyze | path or unique filename fragment |
| `tracePaths` | compare | exactly two paths/fragments `[A, B]` |
| `view` | analyze/run | see table above |
| `toolFilter` | analyze | tool-name substring (`"bash"`) **or** 1-based call indices (`"3"`, `"2,5"`) |
| `limit` | all | max items per section (default 40, cap 500) |
| `maxChars` | all | overall output cap (default 30 000, max 120 000) |
| `filter` | list | substring filter on file path |
| `sessionsDir` | analyze/list | override `~/.pi/agent/sessions` |

Env: `PI_TRACE_DIR` (default trace dir), `PI_TRACE_PI_BIN` (pi executable if not on `PATH`).
The child is spawned with `PI_TRACE_CHILD=1` in its environment.

## Bash idioms it replaces

```bash
pi --mode json -p "..." > /tmp/x.log                     # -> action:'run'  (+ timeout + group kill)
pi --mode json --exclude-tools t -p "..." > /tmp/y.log   # -> action:'run', excludeTools:['t']
scripts/run-pair.sh t /tmp/bench "..."                   # -> two run calls + one compare call
node -e '...JSON.parse... tool_execution_start...'       # -> action:'analyze', view:'tools'
node -e '...message.usage... sum cacheWrite/cacheRead'   # -> action:'analyze', view:'tokens'
node -e '...c.type==="thinking"...'                      # -> action:'analyze', view:'thinking'
node -e '...result.content[0].text...'                   # -> action:'analyze', view:'toolResults'
grep -c '"type":"agent_end"' /tmp/x.log                  # -> agent_end count in every summary
node scripts/compare.js a.jsonl b.jsonl                  # -> action:'compare'
ls -t ~/.pi/agent/sessions/*/*.jsonl | head              # -> action:'list'
ls ~/.pi/agent/sessions/*/* | grep 019fd6e8              # -> tracePath:'019fd6e8'
```

## Reading the output

Every result carries a `warnings:` line and, when relevant, provenance markers:

- `N malformed JSONL line(s) (last line truncated — run was killed/interrupted)` — the trace was
  cut mid-line; counts are a lower bound.
- `no agent_end event — run did not finish`, `N tool call(s) with no recorded result` — interrupted run.
- `N non-JSON stdout line(s) (extension banners)` — e.g. `Token/Sec extension loaded.` printed by an
  extension before the JSON stream; ignored, not an error.
- `usageSource: message_end (turn_end missing — run interrupted)` — a killed run never emits
  `turn_end`, so usage was recovered from the per-message events instead. (Naive `turn_end`-only
  parsers, including the reference `analyze-trace.js`, report **0 tokens** for such a run.)
- `nested tool LLM usage (subagents): …` — usage reported by tools that ran their own LLM work; not
  part of the main totals.
- `compaction/branch_summary entries: …` — LLM summary spend, and a hint that per-turn numbers do
  not cover the whole history because context was compacted.

Token comparisons use `newTokens = input + output + cacheWrite`; `cacheRead` is cheap reuse and is
reported separately (last turn and sum) rather than folded into a misleading "total".

## Caps

- Output: `maxChars` (default 30 000) with an explicit truncation marker; per-result/per-thinking
  budgets adapt to how many items are shown.
- Parser: at most 250 000 chars of any single tool result are retained (a 5 MB result is reported
  with its *real* size plus `[huge result: only the first 250,000 chars were retained…]`).
- Traces are read with a streaming line reader, so a huge trace does not have to fit in one string.

## Validated

- Numbers cross-checked against independent `jq` computations on a real 2.1 MB session (turns 31,
  calls 28, bash=21/read=3/subagent=2/edit=2, input 62, output 17 421, cacheWrite 121 961,
  cacheRead sum 860 384, cost $0.6513 — exact match) and on real `--mode json` traces; `compare`
  matches `agentic-tool-validation-loop/scripts/compare.js` exactly.
- A/B on the "analyze a 2.1 MB session" task: 1 tool call / 23 553 new tokens / 8.2 s with pi_trace
  vs 10 bash calls / 38 208 new tokens / 58.9 s without (both answers correct) — 38 % fewer new
  tokens, 7× fewer calls.
- Adversarial: trace killed mid-line, empty/whitespace trace, 5 MB tool result, `tool_execution_end`
  without its `start`, session with subagent calls, session whose tool-result *text* contains fake
  event lines (grep over-counts, pi_trace does not), compaction usage, timed-out run (verified no
  orphaned grandchild processes), nonexistent and ambiguous paths.
