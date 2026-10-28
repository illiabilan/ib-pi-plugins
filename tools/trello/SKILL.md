---
name: trello
description: Read and update Trello boards, lists, cards, comments, checklists, labels and attachments from the terminal. Use when the user mentions Trello, a trello.com/c/... or trello.com/b/... link, a card or board by name, or asks to create/move/comment on/archive Trello cards.
---

# Trello

Standalone, zero-dependency Node 20+ CLI at `script/trello.mjs` in this skill's directory
(installed: `~/.claude/skills/trello/script/trello.mjs`).

```bash
T=~/.claude/skills/trello/script/trello.mjs
node $T --help              # all commands
node $T <command> --help    # one command
```

## Setup

Needs `TRELLO_API_KEY` and `TRELLO_TOKEN` in the environment (`node $T auth` explains how to get
them). Optional: `TRELLO_BOARD` default board for `--board`. Verify with `node $T me`.
If credentials are missing, tell the user which variables to export; never ask them to paste a token into the chat.

## Rules

- Writes (`card create/update/move/comment/archive/...`) are visible to the team. Run with `--dry-run`
  first, show the user what will be sent, and only then run it for real unless the user already asked
  for exactly that change.
- Prefer `card archive` (reversible) over `card delete --yes` (permanent). Delete only when explicitly asked.
- Use `--json` when you need fields the text output omits.

## Commands

| Read | |
|---|---|
| `me` | authenticated member |
| `boards [--query t] [--all]` | your boards |
| `board <board> [--per-list N]` | every open list with its cards |
| `lists <board> [--all]` | lists with ids |
| `cards --board B [--list L] [--limit N]` | cards of a board or list |
| `card <card> [--comments N]` | description, labels, members, checklists, attachments, latest comments |
| `comments <card> [--limit N]` | comments, newest first |
| `search <query> [--board B] [--limit N]` | Trello operators work: `label:bug list:Doing @me due:week is:open` |
| `attachments <card>` | attachment list |
| `attachment get <card> <id\|name> [--out dir]` | download an uploaded file (then Read it) |

| Write (all accept `--dry-run`) | |
|---|---|
| `card create <name> --board B --list L [--desc/--desc-file/--desc-stdin] [--due D] [--label a,b] [--member u] [--pos p]` | |
| `card update <card> [--name] [--desc...] [--due D \| --clear-due] [--complete \| --incomplete]` | |
| `card move <card> --list L [--board B] [--pos p]` | |
| `card comment <card> <text>` (or `--file`, `--stdin`) | |
| `card archive` / `card unarchive <card>` | reversible |
| `card delete <card> --yes` | permanent |
| `card label <card> --add a,b --remove c` | |
| `card member <card> --add alice --remove bob` | |
| `list create <name> --board B`, `list archive <list> --board B` | |
| `checklist add <card> <name> [--item x --item y]`, `checklist item-add`, `checklist check`, `checklist uncheck` | |
| `attachment add <card> (--file path \| --url url) [--name n]` | |

Escape hatch: `api <GET|POST|PUT|DELETE> <path> [--param k=v] [--data '<json>']`.

References: boards, lists, labels and members by name; cards by short link, id or `trello.com/c/...` URL.
`--due 2026-08-01` is stored as 12:00 UTC. Values starting with `-` need `--flag=value`; a positional
starting with `-` goes after `--` together with the command words:
`node $T --board=X --list=Y -- card create "- title"`.

Output: text by default, `--json` for raw API data. Errors on stderr. Exit `0` ok, `1` API/runtime error, `2` usage error.

## Tests

`node --test script/test/` runs the CLI against an in-process fake Trello server.
