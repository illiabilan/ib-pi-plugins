# file_ops — safe, previewable filesystem mutations

A pi tool extension that replaces `rm`, `mkdir -p`, `cp`, `mv`, `ln -s`, `chmod` and
`touch` shell calls with a single tool that **previews before it mutates**, requires
**explicit approval**, and **hard-refuses** the classic footguns.

Why: in 266 real pi sessions (2160 tool calls, 1539 shell commands), **195 shell
commands were filesystem mutations** — `rm -rf/-f` 108, `mkdir -p` 70, `cp/mv` 52,
`chmod`/`ln -s` 17 — executed with no preview, no confirmation and no undo. Real
examples from those traces include `rm -rf ~/.pi/agent/extensions/code-search`,
`rm -rf node_modules package-lock.json` and `cp -r <repo> ~/.pi/agent/extensions/...`.

The primary value is **safety and previewability**, not tokens: measured head-to-head,
file_ops costs *more* tokens than a one-line `bash rm -rf ...` (see
[Measured behaviour](#measured-behaviour)).

## Install / load

```bash
# ad-hoc
pi -e /path/to/pi-plugins/extensions/file-ops/index.ts

# or copy/symlink the directory into ~/.pi/agent/extensions/file-ops
```

No runtime dependencies (node built-ins only). `npm install` in this directory is
needed only for type-checking and the test suite (`typescript`, `jiti`, pi type packages).

## Parameters

| Param | Type | Applies to | Meaning |
|---|---|---|---|
| `action` | `"mkdir" \| "copy" \| "move" \| "remove" \| "symlink" \| "chmod" \| "touch"` | — | The operation. |
| `paths` | `string \| string[]` | mkdir, remove, chmod, touch | Targets. Relative → resolved against session cwd, `~` expanded, `*?[` globs expanded **by the tool** (no shell → spaces/unicode are safe, expansion is shown in the preview). |
| `from` | `string` | copy, move, symlink | Source path; for `symlink` it is the link *target* (may be relative → relative symlink). |
| `to` | `string` | copy, move, symlink | Destination. If it is an existing directory, copy/move place the source **inside** it (cp/mv semantics); the preview always shows the final resolved path. |
| `recursive` | `boolean` | remove, copy, chmod, touch | Required to remove/copy a directory tree (`-r`). chmod: whole tree. touch: create missing parents. `mkdir` is always `-p`. |
| `force` | `boolean` | remove, symlink | remove: missing paths are skipped instead of erroring (`rm -f`). symlink: replace an existing link. **Never** disables a safety check or the approval step. |
| `overwrite` | `"never" \| "ask" \| "always"` | copy, move | Destination-exists policy. Default `never` (skip + report). `ask` prompts per conflict interactively and is refused non-interactively. |
| `mode` | `string` | chmod | Octal (`"755"`, `"0644"`) or simple symbolic (`"+x"`, `"-w"`, `"+rx"`). |
| `dryRun` | `boolean` | all | Return the preview only; guaranteed side-effect free (stat/readdir only). Never returns an approval token. |
| `confirm` | `string` | all | Approval token from a previous preview of the *identical* call. |

### Bash idioms replaced

| Shell | file_ops |
|---|---|
| `mkdir -p build/tmp build/out` | `{"action":"mkdir","paths":["build/tmp","build/out"]}` |
| `rm -rf node_modules` | `{"action":"remove","paths":"node_modules","recursive":true}` |
| `rm -f a.log b.log` | `{"action":"remove","paths":["a.log","b.log"],"force":true}` |
| `rm -f logs/*.log` | `{"action":"remove","paths":"logs/*.log"}` (glob expanded + listed in preview) |
| `cp -r dist /tmp/backup` | `{"action":"copy","from":"dist","to":"/tmp/backup","recursive":true}` |
| `mv old.ts src/new.ts` | `{"action":"move","from":"old.ts","to":"src/new.ts"}` |
| `ln -s /abs/target link` | `{"action":"symlink","from":"/abs/target","to":"link"}` |
| `chmod +x scripts/run.sh` | `{"action":"chmod","paths":"scripts/run.sh","mode":"+x"}` |
| `touch .keep` | `{"action":"touch","paths":".keep"}` |
| `du -sh dir` before deciding to delete | `{"action":"remove","paths":"dir","recursive":true,"dryRun":true}` (entry count + bytes) |

## Safety model

1. **No first-call mutation.** Every mutating call returns a `PLAN` preview:
   resolved absolute paths, per-path type, recursive entry counts, byte totals,
   symlink counts, destination conflicts, plus a `counts: exact | LOWER-BOUND` marker.
2. **Approval is mandatory.**
   - Interactive (`ctx.hasUI`): a `ctx.ui.confirm()` dialog containing the whole plan;
     the title is prefixed `!! HIGH RISK` when applicable. Declining changes nothing.
   - Non-interactive (print/JSON): the first call returns `APPROVAL REQUIRED` plus a
     token; execution requires repeating the identical call with `confirm:"<token>"`.
     The token is a hash of the plan **including observed filesystem state**, so it is
     rejected if anything changed since the preview (the message then says the
     filesystem *changed* rather than "bad token"), and it is single-use.
3. **Hard refusals (no confirmation can override):**

| Code | Case |
|---|---|
| `EMPTY_PATH` | missing/empty/whitespace path argument (the `rm -rf $VAR/` bug) |
| `UNEXPANDED_VAR` | path contains `$VAR`, `${VAR}` or a backtick — file_ops runs no shell and refuses to guess |
| `ROOT` | `/` |
| `PROTECTED` | destructive op on `$HOME`, `~/.pi`, `~/.pi/agent`, or anything inside `~/.pi`, `~/.ssh`, `~/.gnupg`, `~/Library`, `/usr`, `/etc`, `/System`, `/bin`, `/sbin`, `/var`, `/private`, `/dev`, `/opt`, `/Library`, `/Applications`; any **write** into `~/.ssh` / `~/.gnupg`; the OS temp root itself (`/tmp`, `$TMPDIR`) |
| `GIT_DIR` | any path inside a `.git` directory |
| `ANCESTOR_OF_CWD` | destructive op on a parent of the session cwd |
| `NEEDS_RECURSIVE` | directory target without `recursive:true` |
| `NO_SOURCE` | missing source / missing remove target without `force` |
| `AMBIGUOUS_OVERWRITE` | `overwrite:"ask"` with no interactive UI |
| `BAD_MODE` / `BAD_ARGS` / `BAD_GLOB` | malformed chmod mode, `paths` given to copy/move, broken glob |

   Scratch dirs are deliberately **not** protected: `/tmp`, `$TMPDIR` and
   `/var/folders/...` (macOS temp) are exempt from the protected-prefix rules, because
   on macOS every temp path lives under the otherwise-protected `/var` and `/private`.
   *Non-destructive* writes into protected locations (e.g. `mkdir ~/.pi/agent/extensions/x`,
   `cp -r repo ~/.pi/agent/extensions/x`) are allowed but flagged HIGH RISK.

4. **HIGH RISK flags** (loud block in the preview, `details.risk === "high"`):
   recursive delete, path outside cwd, path inside a protected location or `.git`,
   glob-expanded delete, `> 25` entries, `> 100 MB`, or an overwrite of existing files.
5. **Symlinks are never followed.** Directory measuring and recursive delete use
   `lstat`, unlink links, and never descend into them (symlink cycles terminate);
   `copy`/`move` preserve links verbatim. The report states how many links were
   unlinked-not-followed.
6. **`dryRun` is side-effect free for every action** — verified by comparing full
   tree snapshots (paths + sizes + sha256 + mtime + mode) before and after.
7. Execution is serialized through pi's `withFileMutationQueue()`, so it cannot race
   built-in `edit`/`write` on the same path.
8. Partial failures are reported honestly: `status: "partial"` with per-path
   `errors (n)` lines; already-completed work is listed under `changed`.

## Output shape

```
PLAN: remove (recursive)   cwd=/repo
  /repo/node_modules   [dir, 41 entries, 131.8KB, 1 symlink(s)]
  note: 1 symlink(s) inside the tree will be unlinked, never followed
  counts: exact (whole tree measured)

!! HIGH RISK — requires an explicit, informed OK from the user:
   - RECURSIVE DELETE of a directory tree (not undoable)
   - 42 entries affected (> 25)

No approval token was supplied.
Show this plan to the user ... then repeat this exact call with confirm:"fileops-e150e17974b3".
```

After execution:

```
DONE: remove
changed (1):
  + /repo/node_modules (removed tree: 36 files, 5 dirs, 1 symlinks unlinked-not-followed)
stats: filesRemoved=36 dirsRemoved=5 symlinksRemoved=1
```

`details` carries `{action, status, risk, reasons, counts, token, paths, totals, stats}`
where `status ∈ refused | dry-run | noop | needs-approval | declined | done | partial`.

## Tests

```bash
node guardrail-tests.mjs      # 102 assertions, ~2s, all sandboxes under /tmp/fileops-tests-*
KEEP_SANDBOX=1 node guardrail-tests.mjs   # keep the sandboxes for inspection
```

Covers: 25 hard-refusal cases, approval-token flow (missing/bogus/stale/single-use),
state-bound token invalidation after a mid-session change, dryRun snapshot equality for
all 7 actions, glob deletes, overwrite policies, unicode/space paths, symlink escape +
cycle + symlinked-dir removal, interactive `ctx.ui.confirm` accept/decline path,
permission-denied partial failures, and a regression guard that destructive ops still
work in ordinary (non-temp) project directories.

## Measured behaviour

Head-to-head with `pi --mode json` on a realistic dirty project (101 entries: `build/`,
`node_modules/` incl. a symlink, `logs/*.log`, `notes.md`, `.git/`), prompt:
*"delete build/ and node_modules/, delete every \*.log, create dist/assets, move notes.md into docs/"*.

| | runs | file_ops calls | bash mutations | filesystem changed without approval |
|---|---|---|---|---|
| with file_ops | 11 | 29 | **0** | **0** |
| without (`--exclude-tools file_ops`) | 3 | — | 3 (one `rm -rf ...` one-liner each) | 3/3 |

(Runs varied the prompt: plain cleanup, pre-approved cleanup, "just use rm -rf via bash",
a protected-path deletion, an unset-`$BUILD_OUT` deletion, and a measure-only question.)

- Adoption: 11/11 runs used file_ops for **every** mutation, including a run whose
  prompt said *"just use rm -rf via bash, it's faster"* and a run that hit a hard
  refusal (`~/Library/...`) — it reported the block instead of shelling out.
- With explicit pre-approval in the prompt, the agent completed the whole task through
  preview → `confirm:<token>` (92 filesystem changes, `.git/` and `src/` untouched).
- Cost: **+~2.5k one-time cached schema tokens** and **+600–1300 output tokens** per
  cleanup task versus the bash one-liner, plus one extra turn when approval is needed.
  file_ops is a safety tool, not a token optimization.
- Scale: previewing a 40 039-entry `node_modules` took 0.65–1.0 s and returned 808
  characters, correctly marked `counts: LOWER-BOUND` (walk capped at 20 000 entries).
- Asked *"how many files/bytes would be deleted?"*, the agent answered with a single
  `dryRun` call (654 chars) instead of `du -sh` + `find | wc -l` bash calls.

## Known limitations

- Destructive operations are impossible inside protected locations even when
  legitimate (e.g. a project checked out under `~/Library`); by design the user must
  do those manually.
- `mkdir` is always `-p`; there is no "fail if parent missing" mode.
- `chmod` supports octal and simple `+/-rwx` only (no `u=rw,go=`), and never touches
  symlinks.
- Cross-device (`EXDEV`) moves fall back to copy-then-delete; that path is implemented
  but was not exercised on a real second filesystem.
- Approval-token TTL (15 min) expiry was not wall-clock tested.
