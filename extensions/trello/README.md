# trello — pi extension

Registers one tool, `trello`. It is a thin wrapper over the standalone [`tools/trello`](../../tools/trello/SKILL.md) CLI, so Pi, Claude Code and Antigravity share the same Trello logic.

## Setup

```bash
export TRELLO_API_KEY="..."
export TRELLO_TOKEN="..."      # `node tools/trello/script/trello.mjs auth` explains how to get both
export TRELLO_BOARD="..."      # optional default board
```

If pi was started without your shell profile, the extension probes a login shell once to recover these.

CLI lookup order: `$TRELLO_CLI`, `tools/trello/script/trello.mjs` in this repo (works through the symlink installs), `trello-cli` on PATH. With `install.sh --copy` the repo path is not available, so put `trello-cli` on PATH or set `TRELLO_CLI`.

## Actions

Read: `me`, `boards`, `board`, `lists`, `cards`, `show`, `comments`, `search`, `attachments`, `download_attachment`.
Write: `create_card`, `update_card`, `move_card`, `comment`, `archive_card`, `unarchive_card`, `delete_card`, `set_labels`, `set_members`, `create_list`, `archive_list`, `add_checklist`, `add_check_item`, `check_item`, `uncheck_item`, `add_attachment`.

```json
{"action":"board","board":"Mobile Roadmap"}
{"action":"search","query":"label:bug list:Doing @me"}
{"action":"create_card","board":"Mobile Roadmap","list":"To Do","name":"Fix login crash","labels":["bug"],"due":"2026-08-01"}
{"action":"move_card","card":"AbCd1234","list":"Doing"}
```

## Write approval

Each write first runs the CLI with `--dry-run`, so names are resolved and the dialog shows the exact intent and request. The user confirms, then the real call runs.

- Interactive session: confirm dialog.
- No UI (print/JSON mode, subagents): writes are refused and the preview is returned. Only the user can opt in with `PI_TRELLO_ALLOW_UNATTENDED_WRITES=1`.
- `delete_card` additionally needs `confirm_delete: true`.

`download_attachment` returns images and small text files inline, like the jira extension.

`filecontent.ts` is a copy of the helper used by the jira and slack extensions.
