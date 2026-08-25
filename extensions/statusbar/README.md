# statusbar

A segmented status bar / infobar for [pi](https://github.com/badlogic/pi-mono). It replaces
pi's built-in two-line footer with a single dense line, plus an optional dim line above it
carrying extension statuses.

```
git guard active (120s timeout)
π 〉 ⊙ claude-sonnet-4-5-20250929 〉 think:high 〉 ⌂ pi-plugins 〉 ⑂ main *2 +1 ?3 〉 ◔ 12.4%/200k 〉 $0.42
```

Registers **no tool** — zero prompt/context footprint. It only draws.

## Segments

| Order | Segment | Shows | Live update trigger |
|---|---|---|---|
| 1 | `π` | accent-coloured branding mark | — |
| 2 | `⊙ <model>` | active model id (dim provider when >1 provider is configured) | `model_select` |
| 3 | `think:<level>` | effective thinking level | `thinking_level_select` |
| 4 | `⌂ <dir>` | basename of `ctx.cwd` | session events |
| 5 | `⑂ <branch> *m +s ?u !c` | branch, modified / staged / untracked / conflicted counts | `footerData.onBranchChange`, 5s timer, `turn_end` / `tool_execution_end` / `message_end` |
| 6 | `◔ <pct>%/<window>` | context usage, colour-ramped dim → warning (>70%) → error (>90%) | turn/message events |
| 7 | `$<cost> ⚑<b>b/<n>n` | session cost; guard interventions parsed out of a published extension status | turn/message events |

The git segment disappears entirely outside a git repo. On a detached HEAD it shows
`detached@<short-oid>`. Context usage comes from `ctx.getContextUsage()` (which is based on
the **last** assistant message's usage, not a sum over messages — summing double-counts
cached context); if that is unavailable, the extension falls back to the last assistant
message's `usage.totalTokens` itself.

## Width-aware degradation

`render()` never wraps and never exceeds the width it is given. Two phases:

1. **Abbreviate.** Four tiers progressively shorten values before anything disappears:
   model id (28 → 18 → 12 → 10 cols, dropping `provider/` prefixes, `-20250929` date
   suffixes and a redundant `claude-` prefix), branch (24 → 10 cols, keeping the *tail*,
   which is where a branch name carries its meaning), directory (20 → 8 cols), and finally
   the dirty counters (untracked first, then staged/modified).
2. **Drop.** If the tightest tier still does not fit, whole segments are dropped in
   priority order: `extra → project → thinking → model → context → git → π`. After dropping,
   the widest tier that still fits is restored, so a narrow bar uses the columns it has.
   The last survivor is `π`; the final line is hard-truncated ANSI-aware as a backstop.

Widths measured with `visibleWidth`/`truncateToWidth`/`sliceByColumn` from
`@earendil-works/pi-tui`, so ANSI codes cost 0 columns and CJK/emoji/combining sequences
count correctly. Real measured examples (100-col terminal shrinking):

```
100  π 〉 ⊙ claude-opus-5 anthropic 〉 think:high 〉 ⌂ pi-plugins 〉 ⑂ main *3 ?2 〉 ◔ 0.0%/1.0M
 80  π 〉 ⊙ opus-5 〉 think:high 〉 ⌂ pi-plugins 〉 ⑂ main *3 〉 ◔ 0.0%/1.0M
 60  π 〉 ⊙ opus-5 〉 think:high 〉 ⑂ main *3 〉 ◔ 0.0%/1.0M
 40  π 〉 ⊙ opus-5 〉 ⑂ main 〉 ◔ 0.0%/1.0M
 20  π 〉 ⑂ main *3 ?2
 10  π
```

Untrusted text (branch names, directory names, other extensions' status text) is stripped
of control characters and escape sequences before rendering, so it cannot inject colour or
break the layout.

## Never blocks the render path

`render()` reads a cached snapshot and the theme. Nothing else:

- no child processes, no `fs`, no network, no `O(session)` scan;
- `git status --porcelain=v2 --branch` runs on a 5s interval, after turn/tool/message
  events (300ms debounce) and on branch change — never from `render()`, and never at all
  when `footerData.getGitBranch()` says this is not a repo;
- `tui.requestRender()` is coalesced (60ms) and only fired when the snapshot actually
  changed (200 `model_select` events produce 2 renders);
- exactly one interval and one branch subscription exist at any time; both are released on
  `dispose()` (toggle off, footer replaced) and on `session_shutdown`;
- outside TUI mode (`-p`, `--mode json`) nothing is mounted and no timer is started.

Measured render cost (`tests/perf.test.mjs`, 4000 iterations, width 100, macOS/Node 26 —
numbers vary a few µs between runs):

| Renderer | µs/frame |
|---|---|
| pi built-in footer, 10 session entries | ~10 |
| pi built-in footer, 5000 session entries | ~30 |
| statusbar, cached snapshot | ~6 |
| statusbar, 10 000 extension statuses | ~17 |
| statusbar, width 20 (full degradation path) | ~20 (≈0.12% of a 16ms frame) |

## Commands

| Command | Effect |
|---|---|
| `/statusbar` | toggle the bar (off restores pi's built-in footer via `setFooter(undefined)`) |
| `/statusbar on` / `off` | explicit enable/disable |
| `/statusbar status` | show current state |
| `/statusbar segments` | interactive picker to toggle individual segments |
| `/statusbar <segment>` | toggle one segment directly (`pi`, `model`, `think`, `project`, `git`, `context`, `extra`, `statuses`) |

Argument completion is provided for all of the above.

## Configuration

State is persisted to `~/.pi/statusbar.json` (uses `CONFIG_DIR_NAME`, so a rebranded
distribution gets its own directory) and survives restarts:

```json
{
  "enabled": true,
  "segments": {
    "pi": true, "model": true, "think": true, "project": true,
    "git": true, "context": true, "extra": true, "statuses": true
  }
}
```

Unknown/invalid keys are ignored, a missing or unreadable file falls back to all-on, and a
read-only `HOME` degrades to "not persisted" instead of failing.

## Install

```bash
ln -s /path/to/pi-plugins/extensions/statusbar ~/.pi/agent/extensions/statusbar
```

or try it without installing:

```bash
pi -e /path/to/pi-plugins/extensions/statusbar/index.ts
```

`package.json` lists only dev dependencies (the pi packages + `@types/node`), used for
type-checking and the test suite. Nothing is needed at runtime, so `node_modules/` here is
optional and gitignored — `npm install` it to run `tests/`, and deleting it afterwards is
safe (it also guarantees the extension resolves `@earendil-works/pi-tui` from the running
pi installation rather than from a possibly different local copy).

## Tests

```bash
bash tests/run.sh          # 6 suites, no framework, no runtime deps
```

See [tests/README.md](tests/README.md) for what each suite proves (width/ANSI invariants
across a width matrix, a no-I/O proof for `render()`, real-git integration, lifecycle/leak
checks, dark+light theme rendering, and the head-to-head performance benchmark), plus the
manual pty-based TUI smoke test.

## Known limits

- The `⚑` guard counters are parsed out of whatever extension status text contains
  `blocked=<n>` / `nudged=<n>`; an extension that publishes no status contributes nothing.
- At most 24 extension statuses are inspected per frame (`+N more` is appended); with a
  pathological number of statuses a guard status ranked later than #24 is not seen.
- The status line is only shown when at least one extension has set a status.
