# bash-guardrail

A Pi extension that **steers the agent away from `bash`** when a purpose-built tool
is an exact substitute — by intercepting the `bash` tool call itself, not by adding
another tool.

It registers **no tool and no prompt text**: its context footprint is zero tokens
until it actually intervenes.

```
tool_call(bash) ──▶ classify(command)
                     ├─ block  → refusal containing the exact replacement call
                     ├─ nudge  → command runs; one short line appended to the result
                     └─ allow  → nothing happens (default for anything unclear)
```

## Why

Measured over 266 real sessions in `~/.pi/agent/sessions` (1963 `bash` calls):
277 bash file-reads (90 of them `sed -n 'A,Bp'`) although `read` takes
`offset`/`limit`; 606 bash greps against 55 `grep`-tool calls; 356 `find`/`ls`.
About a quarter of those commands were single-intent one-liners with an exact
tool equivalent. Tool descriptions alone did not stop the habit; a refusal that
arrives *at the moment of the call* and already contains the replacement
arguments does.

## The three outcomes

### BLOCK — single intent, exact equivalent, nothing executed

The refusal is not generic advice; it contains the concrete call, with paths
resolved (including through a `cd X && …` prefix) and flags translated:

```
$ sed -n '120,160p' features/.../SubscriptionCheckoutBottomSheetViewModel.kt

BLOCKED by bash-guardrail: single-intent read command with an exact tool equivalent — nothing was executed.
Call this instead:
  read {"path":"/abs/…/SubscriptionCheckoutBottomSheetViewModel.kt","offset":120,"limit":41}
Why: `sed -n '120,160p'` is exactly read's offset/limit, and read's output is line-numbered so the range stays citable.
If you genuinely need the shell for this …, re-send the SAME command with ` # guardrail:allow` appended …
```

Covered mappings (all require every flag to be understood — one unknown flag
downgrades to nudge/allow):

| bash | tool |
|---|---|
| `cat f` / `cat a b` | `read` / `multi_file_read` |
| `head -N f`, `sed -n 'A,Bp' f`, `sed -n 'Np' f` | `read` + `offset`/`limit` |
| `ls`, `ls -la`, `ls -lt`, `ls dir/*.kt`, `ls -R` | `list_files` (`withMeta`, `sortBy`, `maxDepth`) |
| `find P -name -iname -type -maxdepth -mmin -mtime -newermt -not -path` | `list_files` (`globs`, `excludeGlobs`, `type`, `modifiedAfter`) |
| `grep`/`egrep`/`rg` incl. `-r -i -l -L -c -q -w -v -o -E -F -e -A/-B/-C --include --exclude --exclude-dir`, plus `| head -N` → `limit` and `| wc -l` → `outputMode:'count'` | `grep` |
| `git status/log/diff/show/branch/blame/stash list/add/commit/push` | `git` |
| `rm`, `mkdir`, `cp`, `mv`, `ln -s`, `chmod`, `touch` | `file_ops` (preview + approval) |
| `wc`, `du -sh`, `stat`, `shasum -a 256` | `path_stats` |
| `diff`, `diff -r/-q/-w` | `diff` |
| `npm install/test/outdated/run X`, `npx tsc --noEmit` | `node_project` |
| `./gradlew <tasks>` | `gradle_build` (`action:'raw'`) |
| `unzip -l`, `jar tf` | `archive_inspect` |
| `which X`, `printenv`, `env \| grep X`, `echo $VAR` | `env_info` (values stay redacted) |

`grep`'s POSIX **BRE** pattern is translated to the ERE dialect the grep tool
uses (`"a\|b"` → `"a|b"`, `"a|b"` → `"a\|b"`), and the translation is stated in
the refusal. Patterns that cannot be translated faithfully (backreferences,
`-P`) are never blocked.

### NUDGE — composite command, partial equivalent

The command runs untouched and one line is appended to its result, with the
concrete first-stage call when it is known:

```
[bash-guardrail] The first stage alone maps to a tool call (the later pipeline stages map to
other parameters of the same call): the grep tool covers this pipeline directly: … notPattern
(instead of `| grep -v`) …  grep {"pattern":"Werror|allWarnings","directory":"/repo","include":"*.gradle"}
```

At most **one nudge per intent per session** (and 8 intents total) so the added
context stays negligible; every intervention is still counted.

### ALLOW — everything else, silently

Loops, subshells, heredocs, `$VAR`/`$( )`, redirections into files, process
substitution, `||` fallbacks, pipelines feeding `python`/`node`/`awk`/`jq`/`sort`,
`find -exec`/`-delete`, `sed -i`, unknown binaries, `ssh`/`docker`/`xargs`, and
any command whose flags are not fully understood.

## Safety properties

1. **Fails open.** Every handler is wrapped in `try/catch`; any exception leaves
   `bash` untouched (verified by forcing the classifier to throw).
2. **Never blocks the same command twice.** The second identical attempt runs and
   gets an explanatory nudge instead, so a wrong block can cost at most one turn
   and a block/retry loop is structurally impossible.
3. **Never blocks a command the user dictated.** Recent user messages are checked
   for the command verbatim (with the `cd …` prefix stripped); a match allows it.
4. **Never points at a tool that is not loaded.** `pi.getActiveTools()` is checked
   per call; if the replacement tool is inactive the command is allowed, and if
   tool detection fails entirely the block degrades to a nudge.
5. **Never inspects a heredoc body.** Scanning stops at `<<`.
6. **Precision over recall.** On a hand-labelled sample of 200 real commands from
   `~/.pi/agent/sessions`: BLOCK precision **77/77 = 100%**, recall 95%;
   NUDGE precision 92% (0 false positives against the ALLOW class).
7. **Never blocks a command the user asked for in words either** — "use a shell
   one-liner to …", "run this command", "with bash" all disable the block for
   that call (added after a live run showed such a request being blocked and
   costing a turn).
8. **Recovery is measured, not assumed.** Across 10 live blocks the agent
   recovered within one extra turn every time — by switching to the suggested
   tool, by re-sending with `# guardrail:allow`, or by hitting the never-block-
   twice rule. No block/retry loop ever formed.

## Escape hatches and configuration

| What | How |
|---|---|
| Force one command through | append `# guardrail:allow` to it |
| Never block, only nudge | `PI_BASH_GUARDRAIL=nudge` |
| Disable completely | `PI_BASH_GUARDRAIL=off` |
| Change mode mid-session | `/guardrail on\|nudge\|off` |
| See intervention counters | `/guardrail` |
| Machine-readable audit log | `PI_BASH_GUARDRAIL_LOG=/path/to/log.jsonl` (one JSON object per decision) |

## Install

```bash
cp -r extensions/bash-guardrail ~/.pi/agent/extensions/bash-guardrail   # global
# or project-local: .pi/extensions/bash-guardrail
# or ad hoc:        pi -e /path/to/extensions/bash-guardrail/index.ts
```

No dependencies, no build step.

## Measured effect (be honest about it)

**Prompt cost: exactly zero.** Two runs of the same trivial prompt, one with the
extension and one without, produced `cacheWrite=17903 / cacheRead=0` and
`cacheWrite=0 / cacheRead=17903` — the second run reused the first run's prompt
cache byte for byte, so the extension adds no tokens at all.

**Behavioural effect, with all 14 replacement tools installed and their
`promptGuidelines` active: near zero, because there is little left to fix.**
24 A/B runs (claude-sonnet-5 and claude-haiku-4-5 × read-a-line-range /
count-a-symbol-excluding-build / list-recently-modified / git-status, 3 reps per
side) used `read`, `grep`, `list_files` and `git` on **both** sides —
0 bash calls, so the guardrail never fired and turns/tokens were identical
within noise. The 62%-bash number that motivated this extension comes from
sessions recorded before those tools and guidelines existed.

Where it does fire (measured live):

| Situation | Observed |
|---|---|
| Model chooses `sed -n '10,20p'` anyway ("…the way a sysadmin would") | blocked, recovered in +1 turn (+~400 tokens), correct answer |
| Agent instructed to blindly re-send a blocked command | ran on the 2nd attempt (never-block-twice), correct answer, no loop |
| Composite `find . -maxdepth 1 -type f \| wc -l` | ran, one nudge line, correct answer |
| `rm`/`mkdir`/`cp` in bash | routed to `file_ops`, i.e. a preview + explicit approval instead of a silent mutation |
| `env \| grep TOKEN`, `echo $SECRET` | refused before a secret value could enter the transcript |
| Replacement tool excluded (`--exclude-tools read`) | allowed, logged `tool-not-active` |
| Classifier forced to throw | bash still executed; error logged only |

On the full 1963-command historical corpus the mix would have been
**15% block / 39% nudge / 46% allow** (nudge *text* is deduped to ≤1 line per
intent per session, so at most ~8 short lines even in a bash-heavy session).

Treat it as a **backstop and a safety rail**, not a speed-up: it costs nothing
when the agent already behaves, and it converts the residual shell habit into a
tool call at a price of at most one turn.

### A real divergence it must warn about

`grep -rn SubscriptionsInfo --include=*.java features/subscriptions` returns
**647** lines in bash and **0** through the `grep` tool on the same repo,
because every match lives in the gitignored `build/` subtree that ripgrep skips
(ripgrep *does* search an ignored directory when it is the explicit root, so
this is not statically decidable). Consequences, both implemented:

- recursive greps whose whole point is an exact count (`-c`, `| wc -l`) are
  **never blocked**, only nudged;
- every other recursive grep block carries that measured example in its note
  together with the instruction to re-send with `# guardrail:allow` if the result
  looks suspiciously empty.

## Tests

```bash
node tests/classify.test.mjs && node tests/hooks.test.mjs && \
node tests/fuzz.test.mjs   && node tests/replay-labeled.mjs
node tests/extract-corpus.mjs --show block   # audit against your own history
```

See `tests/README.md`. `replay-labeled.mjs` fails if any command hand-labelled
nudge/allow ever gets blocked; `fuzz.test.mjs` throws 20k random inputs plus
edge cases (unbalanced quotes, 50KB commands, NUL bytes, emoji) at the parser.

## Files

- `index.ts` — hook wiring, gating (mode, availability, user-dictated, anti-loop), counters, `/guardrail`
- `classify.ts` — command → decision mapping, one recogniser per intent
- `parse.ts` — conservative shell reader (quoting, separators, redirections, bail flags)
