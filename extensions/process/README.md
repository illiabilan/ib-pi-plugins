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

`{ action, command?, cwd?, env?, id?, lines?, timeoutSec?, grepPattern?, all? }`

| action | params | what it does |
|---|---|---|
| `start` | `command` (req), `cwd`, `env` | Spawns `bash -c <command>` **detached in its own process group**, redirects stdout+stderr to a log file, returns a short `id`, pid and log path **immediately**. Never blocks. |
| `poll` | `id`, `lines` | Status (`running`/`exited`/`killed`), exit code, runtime, log size, and **only the output written since the previous poll** (per-id byte cursor, so repeated polls never re-send text). |
| `tail` | `id`, `lines`, `grepPattern` | Last N log lines, optionally filtered by regex (falls back to literal substring if the pattern is not valid regex). Reports `matches=N`, so it also **counts** occurrences. Reads only the tail window — never loads the whole log. |
| `wait` | `id`, `timeoutSec`, `lines` | Blocks until the process exits **or** `timeoutSec` elapses, and says which happened (`outcome: exited｜timeout｜aborted`) plus the last N lines. Honors the tool-call abort signal. |
| `kill` | `id`, `timeoutSec` (grace) | SIGTERM the whole **process group**, escalate to SIGKILL after the grace period (default 3s), then sweep `setsid()`-escaped descendants captured in a pre-kill snapshot, and report any process it could not reap. |
| `list` | – | Every known id: status, exit info, runtime, log size, command, and whether it belongs to this pi session or an earlier one. |
| `clean` | `id?`, `all?` | Removes finished entries and deletes their logs. Refuses to touch running ones. With no `id`, cleans all finished entries (`all: false` only prunes entries finished >7d ago). |

Defaults/caps: `lines` 20 (max 500), `wait` timeout 60s (max 900s), kill grace 3s,
output capped at 12,000 chars per call, tail window 512KB (8MB when `grepPattern`
is set), poll renders at most 64KB of new output but always reports the exact new
byte count.

## Bash idioms it replaces

| bash | process |
|---|---|
| `(cmd > /tmp/o.log 2>&1 & P=$!; sleep 40; kill -9 $P)` | `start` → `wait {timeoutSec:40}` → `kill` only if it actually timed out |
| `cmd & PID=$!; for i in $(seq 1 30); do kill -0 $PID \|\| break; sleep 5; done` | `wait {id, timeoutSec:150}` (returns the instant it exits) |
| `for i in $(seq 1 50); do kill -0 <pid> \|\| break; sleep 10; done` | `poll {id}` / `wait {id}` |
| `tail -n 40 /tmp/o.log`, `tail -f`-style repeated `tail` | `tail {id, lines:40}` / `poll {id}` (incremental) |
| `grep -c WARN /tmp/o.log`, `grep pat log \| tail -n 20` | `tail {id, grepPattern:"WARN"}` (header shows `matches=N`) |
| `kill -9 $PID; pkill -P $PID; pkill -f gradle` | `kill {id}` (group SIGTERM → SIGKILL → descendant sweep) |
| `ps aux \| grep <job>` to find what you left running | `list` |

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
