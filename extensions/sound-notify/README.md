# sound-notify

Audible notification when Pi actually needs you — so an agent never sits silently
waiting while you are doing something else.

Three sounds, nothing else:

| Kind | Fires on | macOS default |
|---|---|---|
| `ask` | an extension opened a **blocking dialog** (`ui_prompt_start`: confirm / select / input / editor / custom) — e.g. `git commit`, `file_ops remove`, `gh pr_create` asking for approval. The agent is frozen until you answer. | `Ping` |
| `done` | the agent run **fully settled** (`agent_settled`): no auto-retry, no auto-compaction, no queued follow-up left. Pi is waiting for your next message. | `Glass` |
| `error` | the run settled after the model/provider **failed** (last assistant message `stopReason === "error"`). | `Basso` |

Registers **no tool** → zero tokens of prompt footprint per turn (measured: 0 token
delta vs. not loading it at all).

## Install

```bash
cp -r extensions/sound-notify ~/.pi/agent/extensions/sound-notify
```

No dependencies, no `npm install`. Works out of the box on macOS (`afplay` +
`/System/Library/Sounds`).

> Don't also pass `-e .../sound-notify/index.ts` once it is installed: pi then
> loads two instances. That case is handled (a process-wide playback clock
> collapses the duplicate ring), but the duplicate `/sound` command registration
> is still pointless noise.

## Anti-spam rules (why it stays quiet during normal work)

- One sound per **settle**, not per turn / per tool call / per retry. A run with 3
  tool calls rings once; a run that the provider retried 3 times before failing
  rings once (`error`).
- **Silent in `-p` / `--mode json`** by default (`PI_SOUND_MODES=tui,rpc`), so
  scripted runs and `subagent` child processes (which pi spawns with
  `--mode json -p`) never make noise.
- **No sound for Esc-aborted runs** — if you cancelled it, you are at the keyboard.
- **No `done`/`error` while follow-up messages are queued** — Pi is still working.
- Per-kind cooldown (default 1200 ms) plus a hard 250 ms de-duplication floor.
- Optional `PI_SOUND_MIN_TURN_MS`: skip `done` for runs shorter than N ms (e.g.
  `10000` = only tell me about work that took long enough for me to walk away).

## Configuration (all via env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PI_SOUND_NOTIFY` | `1` | Master switch. `0`/`off`/`false` disables everything. |
| `PI_SOUND_EVENTS` | `ask,done,error` | Which kinds ring. Also `all` / `none`. |
| `PI_SOUND_ASK` | `Ping` | macOS system-sound name, or an absolute file path. |
| `PI_SOUND_DONE` | `Glass` | ″ |
| `PI_SOUND_ERROR` | `Basso` | ″ |
| `PI_SOUND_VOLUME` | player default | `afplay -v` value, e.g. `0.4`. |
| `PI_SOUND_MODES` | `tui,rpc` | Pi modes that are allowed to ring; `all` to include `json`/`print`. |
| `PI_SOUND_COOLDOWN_MS` | `1200` | Minimum gap between two sounds *of the same kind*. |
| `PI_SOUND_MIN_TURN_MS` | `0` | Skip `done` for runs shorter than this. |
| `PI_SOUND_PLAYER` | auto | Override the player command, e.g. `mpv --really-quiet {file}` or `terminal-notifier -sound Ping`. `{file}` / `{kind}` are substituted; without `{file}` the file is appended. |
| `PI_SOUND_BELL` | `1` | Allow the terminal-bell (`\a`) fallback when no audio player exists. |
| `PI_SOUND_DEBUG` | off | `1` → log every decision to `$TMPDIR/pi-sound-notify.log`, or give a path. Each line records kind, play=0/1, reason, mode, run duration and the resolved player command. |

Example (only tell me when a long job finishes or wants permission, quietly):

```bash
export PI_SOUND_EVENTS=ask,done
export PI_SOUND_MIN_TURN_MS=15000
export PI_SOUND_VOLUME=0.3
```

## `/sound` command

```
/sound            # status: enabled kinds, modes, cooldown, resolved player per kind
/sound off        # mute for this session
/sound on         # unmute
/sound test       # play all three kinds
/sound test error # play one kind
```

## Platform fallbacks

| Platform | Player |
|---|---|
| macOS | `afplay /System/Library/Sounds/<Name>.aiff` (`-v <volume>`) |
| Linux / BSD | `paplay` → `pw-play` → `play -q` with a freedesktop sound theme file (`message.oga`, `complete.oga`, `dialog-error.oga`), then `canberra-gtk-play -i <event>` (needs no file), then `aplay -q` for `.wav` |
| Windows | `powershell -NoProfile -Command [console]::beep(f,ms)` (distinct pitch per kind), or `Media.SoundPlayer` when you point a `PI_SOUND_*` var at a `.wav` |
| anything else / no player | terminal bell, only when stdout is a TTY (so it can never corrupt a `--mode json` stream); `PI_SOUND_BELL=0` for full silence |

Playback is always a **detached, `unref`'d child process with stdio ignored**: a
30-second player does not delay Pi by a millisecond (measured), and a
missing/broken player is caught (`spawn` `error` event), latched, degraded to the
bell, and reported once via `ctx.ui.notify` — it never throws into the agent loop.

## Tests

```bash
node --test extensions/sound-notify/tests/          # 25 unit tests: config, policy, players, classification
python3 extensions/sound-notify/tests/pty-ask.py    # real TUI: ask rings while a dialog blocks, done after settle, mute, /sound test
python3 extensions/sound-notify/tests/pty-adversarial.py  # /reload, Esc-abort, mid-stream follow-up
```

The pty tests drive a real `pi` TUI on a pseudo-terminal with
`PI_SOUND_PLAYER=tests/fixtures/probe-player.sh`, which records playback requests
to a log instead of making noise, so every assertion is on observed behaviour.
