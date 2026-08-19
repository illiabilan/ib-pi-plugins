# git — structured git tool for Pi

One action-enum tool (`git`) that replaces raw `git ...` bash calls. Modeled on the
`jira` extension's read/write split + confirmation style and the `grep` extension's
output caps.

Why it exists: across 266 real pi sessions (2160 tool calls, 1334 of them `bash`),
**148 of 1539 shell commands were git** — status 42, log 38, diff 32, push/pull/fetch 27,
branch/checkout 26, add 14, commit 14, show 12, merge-base/blame/rev-parse 5. Three concrete
pains showed up in those traces, and each one is a design constraint here:

| Observed pain in real traces | What this tool does |
|---|---|
| Commit messages via heredoc acrobatics: `git commit -m "$(cat <<'EOF' … EOF)"`, `git commit -q -F - <<'EOF'` | `message` is a plain multi-line string, passed as a single `execFile` argv element. No shell, no quoting, no heredoc. |
| `git diff <path>` flooding context (36 bash outputs were >10 KB) | `diff` returns a per-file `+/-` summary plus a patch truncated to 80 lines/file and 400 lines total, and says exactly how to ask for more. |
| Risky commands run unguarded: `git branch -D`, `git push --no-verify`, `git pull --allow-unrelated-histories` | Every write action is preview-first: it prints the exact command + `!! DANGER:` lines and refuses to run until a human approves. |

No shell is ever spawned (`execFile` with an argv array), so paths with spaces/quotes/newlines
need no escaping. Reads run with `GIT_OPTIONAL_LOCKS=0`; all calls run with
`GIT_TERMINAL_PROMPT=0` so a missing credential can never hang the session.

## Read actions (run immediately)

| action | what you get | key params |
|---|---|---|
| `status` | repo root, branch (or `DETACHED HEAD`, or "no commits yet"), upstream + ahead/behind, HEAD subject, merge/rebase/cherry-pick in progress, grouped **staged / unstaged / CONFLICTS / untracked** (capped), stash count | `limit` |
| `diff` | per-file `+/-` numstat summary, then a truncated patch; binary files listed, never dumped | `paths`, `flags:["staged"]`, `flags:["stat-only"]`, `ref`, `base`, `contextLines`, `maxLinesPerFile` |
| `log` | `hash \| date \| author \| subject` per commit | `limit`, `paths`, `ref`, `since`, `author`, `flags:["with-files"]` |
| `show` | commit metadata + per-file stat; patch only for the paths you name | `ref`, `paths`, `maxLinesPerFile` |
| `branch` | current branch + local/remote branches with sha, date, upstream | `filter`, `flags:["no-remotes"]`, `limit` |
| `blame` | blame for a line range | `paths[0]`, `lines:"40-80"`, `limit` |
| `merge_base` | merge base of `ref` and `base` + how many commits each side is ahead | `ref`, `base` |
| `rev_parse` | resolve `ref`; with no `ref`: toplevel, git-dir, HEAD, branch | `ref` |
| `stash_list` | `stash@{n} \| hash \| date \| subject` | `limit` |

## Branch switching runs immediately (no gate)

`checkout` / `switch` to a **branch or commit**, including `flags:['create-branch']`, execute
on the first call. `details.approval` is `"ungated-switch"`.

Why these and nothing else: git already refuses the move when it would overwrite local
modifications, and switching back undoes it — so the gate bought no safety while costing a
round-trip on the most frequent write in day-to-day work. The gate still applies the moment
the command stops being reversible: `checkout` **with `paths`** (that discards uncommitted
work), or any force-ish flag on the switch itself.

```
git {action:"switch", branch:"feature-x"}                 -> runs now
git {action:"switch", branch:"new", flags:["create-branch"]} -> runs now
git {action:"checkout", paths:["a.txt"]}                  -> PREVIEW ONLY + DANGER note
```

Covered by `ungated-switch.test.mjs` (16 assertions), which also pins the negative half:
the paths form, `branch_delete`, `reset --hard` and `add` must still preview.

## Write actions (preview → human approval → run)

`add`, `commit`, `push`, `pull`, `fetch`, `stash_push`, `stash_pop`, `branch_delete`,
`reset`, and `checkout` with `paths`.

Flow:

1. Call the action normally. Nothing runs. You get
   `PREVIEW ONLY — nothing was executed`, the exact command, `!! DANGER:` lines for any
   destructive flag, and a `confirm` token.
2. The agent must end its turn showing that command to the user.
3. After the user replies approving it, the agent repeats the identical call plus
   `confirm:"<token>"`.

Three independent gates make "just run it anyway" fail:

- **Token binding** — the token is `sha256(argv)`; it authorizes only that exact command.
  A changed parameter or an invented token gives `token-mismatch` and no execution.
- **Anti-self-approval** — a confirm token replayed in the *same* turn that produced the
  preview is refused (`self-approval-blocked`). Approval requires a new user message in the
  session, or a TUI/RPC confirm dialog. Confirming a command whose preview was never issued
  in this process gives `no-preview`.
- **Interactive dialog** — when `ctx.hasUI`, the user also gets a `ctx.ui.confirm` dialog
  (titled `⚠ DANGEROUS` when danger flags are present).

Escape hatch for unattended automation: `PI_GIT_UNATTENDED=1` skips the user-turn
requirement (token still required). `details.approval` records which path was used:
`"ui-dialog" | "user-turn" | "unattended-env" | "ungated-switch"`.

Loudly flagged flags: `--force`, `--force-with-lease`, `-D` (branch delete), `--no-verify`,
`--amend`, `--allow-unrelated-histories`, `reset --hard`, `checkout -- <paths>`,
`stash push` (removes changes from the working tree).

Hook failures are never swallowed: a failed `commit`/`push` returns git's verbatim
stdout+stderr plus a note telling the agent to fix the reported problem rather than retry
with `flags:["no-verify"]`.

## Parameters

| param | type | used by | notes |
|---|---|---|---|
| `action` | enum | all | see tables above |
| `flags` | string[] | all | `staged`, `stat-only`, `with-files`, `no-remotes`, `all`, `amend`, `allow-empty`, `no-verify`, `set-upstream`, `force`, `force-with-lease`, `rebase`, `prune`, `include-untracked`, `create-branch`, `allow-unrelated-histories`, `hard`, `soft`. Unknown flags are rejected with the valid list. |
| `paths` | string[] | diff/log/show/blame, add/reset/stash_push/checkout | no quoting for spaces; a leading `@` is stripped |
| `ref` | string | diff/log/show/rev_parse/merge_base/reset, `stash@{1}` for stash_pop | passed verbatim (`HEAD~3`, `main..HEAD`, tag, sha) |
| `base` | string | diff (`<base>...HEAD`), merge_base (second ref) | |
| `message` | string | commit, stash_push | plain multi-line text |
| `branch`, `remote` | string | checkout/switch/push/pull/fetch/branch_delete | |
| `repo` | string | all | default = session cwd |
| `limit` | number | log (default 20), branch, blame, stash_list, status sections | |
| `since`, `author` | string | log | |
| `filter` | string | branch | case-insensitive substring |
| `lines` | string | blame | `"40-80"` (or `"40"` → 40 lines from there) |
| `contextLines` | number | diff/show | default 3 |
| `maxLinesPerFile` | number | diff/show | default 80; raising it also raises the whole-diff budget (`max(400, 4×)`) |
| `confirm` | string | write actions | token copied from the preview |

Booleans are deliberately collapsed into one `flags` array: the first version of this tool
used ~15 separate boolean params and measured **~2.4k tokens of schema on every turn**, which
cancelled out its per-call savings. The current schema costs ~1.6k.

## Bash idioms this replaces

```
git status ; git branch --show-current ; git log --oneline -5     -> {"action":"status"}
git diff                                                          -> {"action":"diff"}
git diff --cached                                                 -> {"action":"diff","flags":["staged"]}
git diff --stat origin/main...HEAD                                -> {"action":"diff","base":"origin/main","flags":["stat-only"]}
git diff -- src/app.ts | head -300                                -> {"action":"diff","paths":["src/app.ts"],"maxLinesPerFile":300}
git log --format='%h %ad %an %s' -n 10 -- src/                     -> {"action":"log","limit":10,"paths":["src/"]}
git show --stat HEAD~2                                            -> {"action":"show","ref":"HEAD~2"}
git branch -a | grep -i pay                                       -> {"action":"branch","filter":"pay"}
git blame -L40,80 -- "dir with spaces/f.txt"                      -> {"action":"blame","paths":["dir with spaces/f.txt"],"lines":"40-80"}
git merge-base HEAD origin/main                                   -> {"action":"merge_base","ref":"HEAD","base":"origin/main"}
git rev-parse --show-toplevel ; git rev-parse HEAD                -> {"action":"rev_parse"}
git commit -m "$(cat <<'EOF' … EOF)"                              -> {"action":"commit","message":"subject\n\nbody"}
git commit -q -F - <<'EOF' … EOF                                  -> same as above
git add -A                                                        -> {"action":"add","flags":["all"]}
git checkout -b feature/x                                         -> {"action":"switch","branch":"feature/x","flags":["create-branch"]}
git push -u origin feature/x                                      -> {"action":"push","remote":"origin","branch":"feature/x","flags":["set-upstream"]}
git branch -D old                                                 -> {"action":"branch_delete","branch":"old","flags":["force"]}
git reset --hard origin/main                                      -> {"action":"reset","flags":["hard"],"ref":"origin/main"}
cd /other/repo && git status                                      -> {"action":"status","repo":"/other/repo"}
```

## Edge cases handled (all covered by validation runs)

- **Not a git repo** → one clear error naming the path, plus a distinct message when the path
  is inside a `.git` directory.
- **Detached HEAD** → `status` says `DETACHED HEAD at <sha> (not on any branch)`; `branch`
  says `(detached HEAD — not on a branch)`.
- **Repo with zero commits** → `status` says "no commits yet"; `log`/`show` explain the
  unborn HEAD instead of leaking `fatal: ambiguous argument 'HEAD'`.
- **Merge conflicts** → `status` shows a `CONFLICTS` section and `State: merge in progress`;
  `diff` splits git's combined (`diff --cc`) output per file, so a second conflicted file can't
  be silently swallowed inside the first one's truncation note.
- **Paths with spaces** → parsed from `--porcelain=v2 -z` / `--numstat -z` records, never
  line-split; passed back to git as argv elements.
- **Huge binary files** → detected from numstat `-`/`-` and listed as `binary`, never dumped.
- **Many changed files** → per-file truncation plus a total budget, with the omitted file
  names listed and instructions to re-call per path or with `stat-only`.

## Measured behaviour

- `diff` of one heavily-rewritten file: **1750 chars / 3673 new tokens** vs
  `bash git diff src/mod2.ts` **15291 chars / 9244 new tokens** (−60% tokens, same answer).
- 60-file, 94 KB diff → 10 KB (`stat-only`: 1.7 KB), with omitted files named.
- `status` answers "what changed / which branch" in **1 call** (509 chars) where bash used
  3 calls (`git status`, `git branch`, `git log`).
- `branch` on a 2471-remote-branch repo: 342 chars with `filter`, vs `git branch -a` = 127 KB.
- Fixed cost: the tool's schema + guidelines add ~1.7k tokens of context per session
  (measured as turn-1 prefix delta: 4414 vs 2717 tokens), so a session that only ever runs a
  single `git status` is roughly token-neutral; the tool wins as soon as a diff or several git
  calls are involved.
- Read actions on a real 29k-commit repo: 0.2–0.7 s each.

## Install

Symlink or copy into `~/.pi/agent/extensions/git/` (global) or `.pi/extensions/git/`
(project-local). Or load explicitly: `pi -e /path/to/extensions/git/index.ts`.
No npm dependencies (uses `typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`
provided by pi) and no build step (`jiti` loads the `.ts` directly).
