# `process` — background process manager for pi

A single tool (`process`) that replaces hand-rolled shell job control: spawning a
long job in the background, watching it, searching its log, waiting for it, and
killing it (including its children) — without blind `sleep`s, lost PIDs, or
`kill -9` guesswork.

## Why it exists

Measured across 266 real pi sessions (2160 tool calls, 1539 shell commands inside
`bash`): **72 shell commands were background-process juggling** — `sleep N` appeared
62 times, `kill`/`pkill` 55 times, a trailing `&`/`nohup` 69 times. Verbatim examples
from those sessions:

```bash
(pi --mode json -p "..." > /tmp/opt1.log 2>&1 & P=$!; sleep 40; kill -9 $P 2>/dev/null)
pi --mode json -p "..." > /tmp/final4.log 2>&1 & PID=$!; for i in $(seq 1 30); do if ! kill -0 $PID 2>/dev/null; then echo finished; break; fi; sleep 5; done; kill -9 $PID
for i in $(seq 1 50); do if ! kill -0 22562; then echo "finished after ~$((i*10))s"; break; fi; sleep 10; done
```

Every one of those either **wastes wall-clock** (sleeps longer than needed) or
**truncates the run** (kills a job that needed more time), and each re-emits the
same log text into context on every check.

## Actions and parameters

`{ action, command?, cwd?, env?, id?, lines?, timeoutSec?, block?, grepPattern?, all? }`

| action | params | what it does |
|---|---|---|
| `start` | `command` (req), `cwd`, `env` | Spawns `bash -c <command>` **detached in its own process group**, redirects stdout+stderr to a log file, returns a short `id`, pid and log path **immediately**. Never blocks. |
| `poll` | `id`, `lines` | Status (`running`/`exited`/`killed`), exit code, runtime, log size, and **only the output written since the previous poll** (per-id byte cursor, so repeated polls never re-send text). |
| `tail` | `id`, `lines`, `grepPattern` | Last N log lines, optionally filtered by regex (falls back to literal substring if the pattern is not valid regex). Reports `matches=N`, so it also **counts** occurrences. Reads only the tail window — never loads the whole log. |
| `wait` | `id`, `timeoutSec`, `lines`, `block` | **Non-blocking by default** in interactive sessions: arms a background watcher, returns immediately, and wakes the agent with the outcome when the job finishes (see below). With `block: true` (or in `print`/`json` mode) it behaves classically: blocks until exit **or** `timeoutSec`, reporting `outcome: exited｜timeout｜aborted` plus the last N lines, and honors the tool-call abort signal. |
| `watch` | `id`, `timeoutSec`, `lines` | Arms that watcher explicitly. `timeoutSec` is how long it stays armed (default 1h, max 24h); on expiry it reports "still running" instead of going silent. |
| `unwatch` | `id?` | Disarms one watcher, or all of them when `id` is omitted. |
| `kill` | `id`, `timeoutSec` (grace) | SIGTERM the whole **process group**, escalate to SIGKILL after the grace period (default 3s), then sweep `setsid()`-escaped descendants captured in a pre-kill snapshot, and report any process it could not reap. |
| `list` | – | Every known id: status, exit info, runtime, log size, command, and whether it belongs to this pi session or an earlier one. |
| `clean` | `id?`, `all?` | Removes finished entries and deletes their logs. Refuses to touch running ones. With no `id`, cleans all finished entries (`all: false` only prunes entries finished >7d ago). |

> `start` runs **screened** — see [Destructive-command guard](#destructive-command-guard).

Defaults/caps: `lines` 20 (max 500), `wait` timeout 60s (max 900s), kill grace 3s,
output capped at 12,000 chars per call, tail window 512KB (8MB when `grepPattern`
is set), poll renders at most 64KB of new output but always reports the exact new
byte count.

## Non-blocking wait (background watchers)

A blocking `wait` freezes the whole conversation: while a 10-minute build runs, the
user cannot say anything to the agent, because the tool call owns the turn. So `wait`
no longer blocks.

```
process {action:"start", command:"./gradlew assembleDebug"}   -> paf3x912, returns instantly
process {action:"wait",  id:"paf3x912"}                       -> returns instantly, watcher armed

   … the user keeps chatting, the agent answers other questions, edits files …

[process-watch] paf3x912 EXITED after 6m2s — exited exit=1 log=412KB     <- injected automatically
cmd: ./gradlew assembleDebug
--- last 20 lines ---
e: Foo.kt:41:18 unresolved reference
… continue whatever you were doing with this job
```

Mechanically: the watcher polls the registry off to the side (250ms → 1s → 3s → 10s as
the job ages, so a long build costs almost nothing), and on exit injects the outcome
with `pi.sendMessage({deliverAs:"followUp", triggerTurn:true})`. `followUp` means it
never cuts into a turn that is mid-tool-call; `triggerTurn` means an idle agent
actually wakes up and finishes the job's story instead of leaving the result sitting
silently in the transcript.

The wake-up carries the exit status, runtime, log size and the last N lines, plus an
instruction to resume the work — and it advances the log cursor, so a later `poll`
still returns only what is genuinely new.

Details:

- **`block: true`** restores the old behaviour (still capped at 900s). Use it when
  literally nothing can proceed without the result.
- **`print` / `json` mode** always blocks: there is no human in the loop and the run
  ends at the last turn, so a deferred wake-up would be lost. `watch` says that
  explicitly instead of pretending to arm something.
- **Already-finished job** → answered synchronously, no watcher.
- **`kill`** disarms the watcher (the kill result *is* the answer), and so does `clean`.
- At most **16 watchers**; `list` marks watched entries with `[watched — you will be
  woken on exit]`; `session_shutdown` clears them all.
- The watch window (`timeoutSec`, default 1h) is not a kill: on expiry you are told the
  job is still running and you decide whether to re-watch or kill it.

## Bash idioms it replaces

| bash | process |
|---|---|
| `(cmd > /tmp/o.log 2>&1 & P=$!; sleep 40; kill -9 $P)` | `start` → `wait` → woken on exit; `kill` only if you decide to |
| `cmd & PID=$!; for i in $(seq 1 30); do kill -0 $PID \|\| break; sleep 5; done` | `wait {id}` (no sleeping, and the chat is not frozen meanwhile) |
| `for i in $(seq 1 50); do kill -0 <pid> \|\| break; sleep 10; done` | `poll {id}` / `wait {id}` |
| `tail -n 40 /tmp/o.log`, `tail -f`-style repeated `tail` | `tail {id, lines:40}` / `poll {id}` (incremental) |
| `grep -c WARN /tmp/o.log`, `grep pat log \| tail -n 20` | `tail {id, grepPattern:"WARN"}` (header shows `matches=N`) |
| `kill -9 $PID; pkill -P $PID; pkill -f gradle` | `kill {id}` (group SIGTERM → SIGKILL → descendant sweep) |
| `ps aux \| grep <job>` to find what you left running | `list` |

## Destructive-command guard

`action:"start"` is the only place in pi where the agent gets an unpreviewed,
**detached** shell that outlives the session. So the command is screened before
anything is spawned — by a small shell parser in [`guard.ts`](./guard.ts), not a
regex blacklist.

The guard **never asks for approval**. There is no confirm dialog, no token, no
"run anyway" flag. Three outcomes only:

| verdict | what happens |
|---|---|
| clean | starts silently, zero added output |
| **warn** | starts, and the result begins with one `⚠ [process-guard] <rule>: …` line |
| **block** | nothing is spawned, no registry entry is created, the tool returns an error naming the rule and the safer route |

### Refused (irreversible)

| rule | examples |
|---|---|
| `rm-recursive-protected` / `rm-protected` | `rm -rf /`, `rm -rf ~`, `rm -rf $HOME/*`, `rm -rf ~/.ssh`, `rm -rf .`, `rm -rf ..`, `rm -rf *`, `rm -rf /etc`, `rm -rf .git`, the cwd or any ancestor of it |
| `rm-recursive-protected` (unresolved var) | `rm -rf $OUT/build` when `$OUT` is unset — empty ⇒ `rm -rf /build` |
| `rm-no-preserve-root` | `rm -rf --no-preserve-root /` |
| `filesystem-destroyer` | `mkfs.*`, `newfs`, `fdisk`/`parted`/`wipefs`, `diskutil eraseDisk`, `hdiutil erase`, `shred /dev/sda` |
| `dd-to-block-device` / `write-to-block-device` | `dd of=/dev/disk0`, `cat img > /dev/rdisk2`, `tee /dev/sda` |
| `overwrite-protected-path` | `echo x > /etc/hosts`, `… \| sudo tee /etc/sudoers` |
| `remote-code-execution` | `curl … \| bash`, `wget -qO- … \| sh`, `bash <(curl …)`, `bash -c "$(curl …)"` |
| `obfuscated-execution` | `… \| base64 -d \| sh` |
| `secret-exfiltration` | `cat ~/.ssh/id_rsa \| curl -d @- …`, `curl -F file=@~/.aws/credentials`, `tar cz ~/.ssh \| nc …` |
| `fork-bomb` | `:(){ :\|:& };:` |
| `chmod-recursive-protected` | `chmod -R 777 /`, `sudo chown -R nobody /usr` |
| `system-power`, `kill-everything`, `crontab-wipe`, `account-destruction` | `shutdown -h now`, `kill -9 -1`, `crontab -r`, `userdel` |
| `git-force-push-protected` | `git push --force origin main` |
| `move-protected-path`, `find-delete-protected`, `terraform-destroy`, `keychain-dump` | `mv ~/.ssh /tmp`, `find / -delete`, `terraform destroy -auto-approve`, `security dump-keychain` |

### Allowed with a note (recoverable, but worth saying)

`git reset --hard`, `git clean -fx…`, `git push --force` to a feature branch,
`git filter-branch`, `docker system prune --volumes`, `kubectl delete --all`,
`history -c`, `xargs rm -r` (paths invisible to the guard), unfiltered
`find . -delete`, `pkill -f node` (could kill pi itself), and `sudo` in a detached
job (no TTY ⇒ it hangs on the password prompt or fails).

### Deliberately allowed

Everything a normal session does: `npm test`, `./gradlew …`, `rm -rf node_modules`,
`rm -rf build dist`, `rm -rf ./out/*`, `rm -rf "$TMPDIR/scratch"`, `rm -rf /tmp/x`,
`find . -name '*.log' -delete`, `curl -o file …`, and heredocs/`echo` that merely
*mention* `rm -rf /` inside a document.

### Detection notes

Quoting, escapes, `;`/`&&`/`||`/pipes, subshells, `$(…)`/backticks, heredoc bodies
(ignored — they are data, not commands), inline `VAR=value` assignments, and wrapper
peeling (`sudo`, `doas`, `env`, `nohup`, `timeout`, `nice`, `xargs`, `watch`,
`bash -c "…"`, `su -c "…"`) are all handled, then paths are expanded (`~`, `$VAR`,
`${VAR:-…}`) and normalized against the cwd before being risk-classified. A short list
of raw-text regexes runs in parallel as a safety net. `$TMPDIR`, `/tmp/**` and
project-local paths are explicitly safe.

### Who can turn it off (not the agent)

```
/procguard              # stats + last 8 verdicts
/procguard warn         # nothing is refused, everything is reported
/procguard off          # fully inert
PI_PROCESS_GUARD=off|warn|on     # env default; an explicit /procguard wins
```

Plus one implicit human bypass: if the **user typed the command verbatim** in a
recent message, it runs (and the result discloses that it was waived). The agent
cannot forge that, has no escape comment, and a re-send — reworded, re-quoted,
base64'd or wrapped in `bash -c` — is refused again. The refusal text says so
explicitly, to stop the model from hunting for a hole.

**Non-waivable rules** ignore even that bypass, because "the human pasted it" is too
cheap a signal for an unrecoverable, machine-wide action: `fork-bomb`,
`filesystem-destroyer`, `dd`/writes to a block device, `rm --no-preserve-root`,
`remote-code-execution`, `obfuscated-execution`, `secret-exfiltration`,
`keychain-dump`, `system-power`, `kill-everything`, `account-destruction`,
`crontab-wipe`, `terraform-destroy`, and any recursive delete whose target is `/`,
a top-level directory, a system path, `$HOME` itself, another user's home, or a path
whose root is an unresolved variable. Those are printed with `[non-waivable]`, and
only a deliberate `/procguard off` lets them through.

The guard fails **open** on internal errors (a bug in it must never break `process`)
and fails **closed** on the bypass check (unreadable session state ⇒ not dictated).
Non-`start` actions are never screened.

### Tests

```bash
cd extensions/process
node tests/guard.test.mjs              # ~110 must-allow / must-block / must-warn cases, path unit checks, 5k fuzz inputs
node tests/guard-integration.test.mjs  # the guard as wired into the tool: refusal, no spawn, annotation, /procguard, escape hatches
node tests/watch.test.mjs              # non-blocking wait: instant return, exactly-one wake-up, block:true, print-mode fallback, unwatch/kill/shutdown cleanup
```

## State, restarts, and provenance

State lives in a registry directory: `$PI_PROCESS_DIR`, else `$TMPDIR/pi-process`.
One `<id>.json` metadata file plus one `<id>.log` per process — never a single shared
JSON, so concurrent pi sessions cannot clobber each other's registry. Per-id writes
are serialized and merge-patched, so a `poll` cursor update can never erase an exit
code recorded concurrently by the child's exit handler.

Because the registry is on disk, entries survive a pi restart. Exit codes, however,
are only exact when *this* pi process observed the exit, so every result carries a
machine-readable provenance marker:

| marker | meaning |
|---|---|
| `exit=<n>` / `signal=<SIG>` (`exitSource: child-event`) | Exit observed directly. Trust it. |
| `exit=unknown(stale-pid)` | Process is gone but was started by an earlier pi process — read the log tail, don't trust a status. |
| `exit=unknown(pid-reused)` | The recorded pid now belongs to a different process (start-time mismatch via `ps -o lstart`). Treat as unknown. |
| `signal=<SIG> (killed by process tool; exit code not observed)` | We killed a foreign-session process ourselves. |

Detached processes are intentionally **not** killed on `session_shutdown` — a long
build or benchmark survives a pi restart and is re-discoverable via `list`.

## Install / try it

```bash
# ad-hoc, no install:
pi -e /path/to/extensions/process/index.ts -p "start ./build.sh in the background and wait up to 120s"

# global install:
cp -r extensions/process ~/.pi/agent/extensions/process
```

## Known limitations

- Group/descendant kill covers the process group plus the ppid-closure snapshot taken
  immediately before signalling. A descendant that both leaves the group **and** is
  spawned *after* that snapshot can survive; `kill` then reports what it could not reap.
- The descendant sweep signals pids captured a few hundred ms earlier, so an extremely
  unlucky pid reuse in that window could signal an unrelated process.
- `kill` on an already-finished entry reaps processes still sitting in the job's old
  process group, but only ones whose `ps` start time falls inside the job's lifetime —
  this guard exists because a process-group id can be recycled, and without it the tool
  demonstrably killed an unrelated process group (reproduced during validation).
- `tail`/`poll` counts and content cover the scanned window (see caps above), not the
  whole file; the header always states the scanned size.
- Logs are plain files and are not rotated. Use `clean` to delete them.
- The guard reasons about the command **text**. It cannot see inside a script the
  command invokes (`./deploy.sh`), a binary, or paths that only exist at runtime
  (`xargs`, `$(…)` output) — those are warned about where detectable, not blocked.
- Path risk is computed from `$VAR` values visible to pi plus inline assignments;
  a variable exported inside the same command chain by a subshell is unresolved,
  and an unresolved variable at the **root** of a recursive delete is refused.
