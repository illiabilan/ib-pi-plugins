# gh — pi extension

Registers one LLM-callable tool, `gh`, that wraps the [GitHub CLI](https://cli.github.com) for
PR/issue workflow, plus a `tool_call` guard that stops the agent from routing mutations around it
through `bash`.

Two things it fixes about `bash gh ...`:

1. **Bodies stop going through the shell.** `title`/`body` are plain tool parameters; the body is
   handed to `gh` over **stdin** (`--body-file -`) and the title as a single argv element. No
   quoting, no `\"` escaping, no `\$(...)` accidents, no mangled backticks/emoji.
2. **Mutations are preview-first.** A write call without `confirm_token` executes *nothing*: it
   returns the exact resolved payload (repo, base, head, title, full body, draft, reviewers,
   labels, merge method, delete-branch) plus a one-time token bound to a hash of that payload.

Authentication is **not** reimplemented: whatever `gh auth status` says is what you get, and gh's
own error text is surfaced with an explicit "run `gh auth login`" hint.

## Requirements

- `gh` on `PATH` (`brew install gh`), authenticated once via `gh auth login`.
- No npm dependencies.

Not installed / not authenticated / no GitHub remote are each detected and reported as their own
status instead of a cryptic CLI failure.

## Result marker: `gh_status:`

Every result ends with one machine-readable line:

| status | meaning |
|---|---|
| `ok` | the action succeeded |
| `preview_pending_approval` | a write preview — **nothing was sent to GitHub** |
| `refused_unapproved` | a write was refused (unknown/expired token, or no interactive UI) |
| `declined` | the user answered No to the confirmation dialog |
| `auth_error` | not logged in / bad credentials / missing scope / 403 → user must run `gh auth login` or `gh auth refresh` |
| `not_installed` | `gh` is not on PATH |
| `no_remote` | cwd has no GitHub remote gh recognises → pass `repo:"OWNER/REPO"` |
| `not_found` | no such PR/issue/branch |
| `error` | anything else (malformed query, timeout, unparseable output) |

## Parameters

| param | used by | notes |
|---|---|---|
| `action` | all | see below |
| `number` | pr_view, pr_diff, pr_checks, issue_view, pr_edit, pr_comment, pr_ready, pr_merge, issue_comment | PR/issue number, URL or branch. Omit for PR actions to use the current branch's PR |
| `repo` | all | `OWNER/REPO` (`gh -R`); omit to use the cwd's repo |
| `state` | pr_list, search_* | `open` (default) \| `closed` \| `merged` \| `all` |
| `author` | pr_list, search_* | login or `@me` |
| `base` | pr_list (filter), pr_create/pr_edit (target branch) | pr_create default = repo default branch |
| `head` | pr_list (filter), pr_create | pr_create default = current git branch |
| `search` | pr_list | free-text qualifier string (`gh pr list --search`) |
| `query` | search_prs, search_issues | split into argv words; `"quoted phrases"` are preserved |
| `limit` | pr_list, search_* | default 10, max 100 |
| `body_limit` | pr_view, issue_view | body chars to include (default 3000, `0` omits the body) |
| `patch` | pr_diff | `true` → raw patch (capped at 30 000 chars); default is a per-file +/− stat |
| `title`, `body` | pr_create, pr_edit, pr_comment, issue_comment, pr_merge | plain text, newlines/backticks/quotes/emoji safe |
| `draft` | pr_create | |
| `reviewers`, `labels` | pr_create, pr_edit | string or array (comma-splitting supported) |
| `merge_method` | pr_merge | `squash` (default) \| `merge` \| `rebase` |
| `delete_branch` | pr_merge | delete head branch after merge |
| `dry_run` | pr_create | `gh pr create --dry-run`; still needs approval, and gh may still push the head branch |
| `confirm_token` | write actions | token from the preview of the **identical** payload |

### Actions

Read: `auth_status`, `repo_info`, `pr_list`, `pr_view`, `pr_diff`, `pr_checks`, `search_prs`,
`search_issues`, `issue_view`.
Write: `pr_create`, `pr_edit`, `pr_comment`, `pr_ready`, `pr_merge`, `issue_comment`.

```json
{"action":"pr_view"}                                        // current branch's PR
{"action":"pr_view","number":22173,"body_limit":0}          // skip the PR template body
{"action":"pr_list","author":"@me","state":"open","limit":5}
{"action":"pr_diff","number":22173}                         // per-file stat
{"action":"search_prs","query":"ADA-48283","limit":10}
{"action":"pr_create","base":"main","title":"ADA-48914 celebration observability",
 "body":"## What\n- adds `CelebrationObserver` 🎉\n"}        // -> preview + confirm_token
{"action":"pr_create", ...identical..., "confirm_token":"gh-1a2b3c4d5e6f"}  // -> executes
{"action":"pr_merge","number":999,"merge_method":"squash","delete_branch":true}
```

## Which bash idioms it replaces

| bash | gh tool |
|---|---|
| `gh pr create --base X --head Y --title "..." --body "$(printf '...')"` | `{"action":"pr_create","base":"X","head":"Y","title":"...","body":"..."}` (+ approval) |
| `gh pr view 123 --json state,baseRefName,reviewDecision,statusCheckRollup` + jq | `{"action":"pr_view","number":123,"body_limit":0}` |
| `gh pr diff 123 --stat` *(no such flag — real failure seen in traces)* → `gh api .../files --jq ...` | `{"action":"pr_diff","number":123}` |
| `gh pr checks 123` (exit code 8 = pending, easy to misread as failure) | `{"action":"pr_checks","number":123}` |
| `gh search prs "ADA-48283" --limit 10 --json url,title,state` | `{"action":"search_prs","query":"ADA-48283","limit":10}` |
| `gh auth status`, `git remote -v` + `gh repo view --json defaultBranchRef` | `{"action":"auth_status"}`, `{"action":"repo_info"}` |
| `gh pr merge 123 --squash --delete-branch` | `{"action":"pr_merge",...}` (irreversibility spelled out, approval required) |
| `gh pr comment 5 --body "$(cat <<'EOF' ... EOF)"` | `{"action":"pr_comment","number":5,"body":"..."}` |

## The approval gate (and why the bash guard exists)

```
call 1  {"action":"pr_create", ...}                  -> gh_status: preview_pending_approval
                                                        (payload + confirm_token, nothing sent)
   user reads the payload and approves
call 2  {"action":"pr_create", ...same..., confirm_token} -> ctx.ui.confirm -> executes
```

Properties, each verified by test:

- The token is a salted hash of the resolved payload: changing one body character voids it and
  produces a fresh preview instead of executing the changed payload.
- The salt is per-process, so a token from an earlier session (or a guessed one) is never accepted.
- Tokens are single-use and expire after 15 minutes; a declined confirmation also burns the token.
- In a **non-interactive** session (`-p`, `--mode json`, no UI) a write is **refused** even with a
  valid token, because no human could have seen the preview. Opt out with
  `PI_GH_ALLOW_UNATTENDED_WRITES=1` in the pi process environment (the model cannot set this itself
  — a bash `VAR=1 pi-tool-call` does not reach the tool).
- The **preview** clips a very long body at 4000 chars for display only. The body sent to gh is
  never clipped (a 26 708-char body was verified byte-identical on gh's stdin).

**The bash guard:** during validation an agent that was correctly refused by this gate immediately
re-ran `gh pr create --body "..."` through the `bash` tool and created the PR anyway. So while the
`gh` tool is active, a `tool_call` handler blocks bash commands whose *first word in a segment* is
`gh` with a mutating subcommand (`pr create|edit|comment|merge|ready|close|...`, `issue ...`,
`release ...`, `repo create|delete|...`, `workflow run`, `secret set`, `gh api -X POST|PATCH|DELETE`,
…) and tells the model which `gh` action to use instead.

- Wrapper forms are scanned too (recursively, depth 3): `bash -c "gh pr create ..."`, `sh -c '...'`,
  `eval "..."`, `xargs -I{} gh pr create ...`, `timeout 60 gh pr merge ...`. Without this they
  slipped straight past the guard.
- Read-only gh commands in bash are **not** blocked (`gh pr view/list/diff/checks`, `gh search`,
  `gh api` GET, `gh auth status`), including inside wrappers (`bash -c "gh pr view 5"`).
- `echo "gh pr create ..."`, `grep 'gh pr merge' file`, `git log --grep="gh pr create"` are **not**
  blocked (only the first word of each `;`/`&&`/`|`/newline segment and of `$(...)`/backticks is
  considered).
- `--exclude-tools gh` (or otherwise deactivating the tool) also disables the guard, so bash is
  never left with no path at all.

## Known limits

- A heredoc whose *line* starts with `gh pr create …` inside an otherwise read-only command can be
  flagged by the guard (rare; the block message explains what to do).
- `pr_diff` default stat comes from the PR's `files` list (gh has no `--stat`), capped at 200 files.
- `pr_checks` treats gh exit code 8 (checks pending) as a normal result, not an error.
- Titles over 256 chars are flagged in the preview (GitHub's limit) but not auto-truncated.
