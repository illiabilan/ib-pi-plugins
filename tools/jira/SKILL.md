---
name: jira
description: Read, search and update Jira Cloud issues from the terminal. Use when the user mentions Jira, an issue key like ABC-123, an *.atlassian.net/browse/... link, JQL, a sprint, board or backlog, or asks to create/update/transition/comment on/link/close Jira issues, find duplicate tickets, or read/attach files on an issue.
---

# Jira

Standalone, zero-dependency Node 20+ CLI at `script/jira.mjs` in this skill's directory
(installed: `~/.claude/skills/jira/script/jira.mjs`).

```bash
J=~/.claude/skills/jira/script/jira.mjs
node $J --help              # all commands
node $J <command> --help    # one command
```

## Setup

Needs all three in the environment (no defaults, nothing hardcoded):
`JIRA_URL` (e.g. `https://yourcompany.atlassian.net`, must be https), `JIRA_USERNAME` (Atlassian
account email), `JIRA_API_TOKEN` (https://id.atlassian.com/manage-profile/security/api-tokens).
Verify with `node $J test-token`. If they are missing, tell the user which variables to export in
their shell profile and to restart Claude Code. Never ask them to paste a token into the chat.
On HTTP 401/403 the token is probably expired (about 90 days): ask the user to regenerate it and
re-export `JIRA_API_TOKEN`. Do not retry over and over.

## Rules

- When the user mentions an issue key (ABC-123) or a browse link, run `show` before answering. Don't guess.
- Writes (`create`, `update`, `transition`, `comment`, `link`, `delete`, `attachment add`, `api` non-GET)
  change shared Jira state. **Always run the exact command with `--dry-run` first, show the user the
  printed requests, and only run it for real after they approve.** After any change request, dry-run again.
- `update` cannot change status. Closing is a `transition`: run `transitions <key>` to see the allowed moves.
- Prefer closing as duplicate (`link --type duplicates` + `transition --to Done --resolution Duplicate`)
  over `delete --yes`. Delete is irreversible, also removes sub-tasks, and is only for an explicit user request to delete.
- Before `create` on an unfamiliar project, run `createmeta <PROJ> --issue-type <Type>` to learn the
  required and custom field ids.
- `find-duplicates` output is a list of candidates, not verdicts. Show the clusters to the user and let them decide.
  A `TEMPLATE SERIES` warning (e.g. "...for the Redeem screen" / "...for the Save screen") usually means distinct work.
- For repetitive cleanup, pass several keys to `transition`/`comment`/`link`/`delete`/`attachment add`.
  Each key reports OK/FAILED, one failure doesn't stop the rest, and the exit code is 1 if any key failed.
- Use `--json` when you need fields the text output omits.

## Commands

| Read | |
|---|---|
| `me`, `test-token` | authenticated user / verify credentials |
| `show <key\|url>` | summary, status, people, epic, parent, links, attachments, description, bug Details (Steps/Expected/Actual) |
| `list [--limit N]` | issues assigned to you (max 100) |
| `search '<jql>' [--limit N]` | JQL, auto-paginated (default 10, max 1000) |
| `projects [filter]` | projects (capped at 40 unfiltered) |
| `stats [--days N]`, `sprint-stats` | your issues by status/priority |
| `boards [--project P]` | Agile boards; trailing key = project the board lives in |
| `backlog (--project P \| --board-id N) [--limit N]` | ranked backlog (default 300, max 2000); warns on foreign boards/issues |
| `find-duplicates (--project P \| --jql Q \| --board-id N) [--threshold 0.55] [--limit N]` | local similarity clusters + suggested canonical + cleanup command |
| `transitions <key>` | allowed workflow moves |
| `link-types` | link type names with inward/outward phrases |
| `createmeta <PROJ> [--issue-type T]` | issue types, or fields (* required) with allowed values |
| `attachments <key>` | attachment ids and names |
| `attachment get (<id> \| <key> <filename>) [--out dir]` | download (default temp dir, never overwrites), then Read the printed path |

| Write (all accept `--dry-run`) | |
|---|---|
| `create [--project P --issue-type T --summary S --description D] [--fields '<json>' \| --fields-file F \| --fields-stdin]` | shortcut flags are merged over `--fields` |
| `update <key> [--summary S] [--description D \| --description-file F] [--fields '<json>' ...]` | |
| `transition <key...> --to <name\|status\|id> [--resolution R] [--comment T]` | retries without the resolution if the screen rejects it |
| `comment <key...> (--body T \| --file F \| --stdin)` | plain text |
| `link <key...> --type <shortcut\|Jira type> --target <key>` | reads "key type target" |
| `delete <key...> --yes` | permanent, sub-tasks too |
| `attachment add <key...> --file a [--file b]` | |

Link shortcuts: `child-of`, `parent-of`, `blocks`, `is-blocked-by`, `relates-to`, `duplicates`, `clones`.
A raw Jira type name sends the source as inwardIssue, so it reads with the type's outward phrase (see `link-types`).

Escape hatch: `api <GET|POST|PUT|DELETE> <path> [--param k=v] [--data '<json>']`. The path is relative to
`JIRA_URL` (e.g. `rest/api/3/issue/ABC-1/comment`), and absolute URLs are refused.

Notes: issue references can be keys (case-insensitive), numeric ids, or URLs containing `/browse/KEY` or
`selectedIssue=KEY`. Rich text goes out as plain text over REST v2. ADF from v3 (description, custom fields)
is flattened to text. Values starting with `-` need `--flag=value`. Credentials are only sent to the `JIRA_URL` origin:
attachment redirects to a media host are followed without them, and the token is redacted from errors.

Output: text by default, `--json` for raw API data. Errors go to stderr. Exit `0` ok, `1` API/runtime error, `2` usage error.

## Tests

`node --test script/test/` runs the CLI against an in-process fake Jira server, plus the duplicate-detection unit tests.
