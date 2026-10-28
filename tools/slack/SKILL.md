---
name: slack
description: Read, search and post in Slack as the user (every channel, DM and private group they can see). Use when the user pastes a Slack link (*.slack.com/archives/...), mentions a Slack channel, thread, DM or message, asks what was said in Slack, asks for their mentions, wants a Slack attachment (screenshot, video, log) read, or asks to post, reply, react or upload a file to Slack.
---

# Slack

Standalone, zero-dependency Node 20+ CLI at `script/slack.mjs` in this skill's directory
(installed: `~/.claude/skills/slack/script/slack.mjs`). It acts as the user through their browser
client credentials, so it sees exactly what they see in the Slack app.

```bash
S=~/.claude/skills/slack/script/slack.mjs
node $S --help              # all commands
node $S <command> --help    # one command
```

## Setup

Needs `SLACK_TOKEN` (the `xoxc-` client token) and `SLACK_COOKIE` (the `xoxd-` value of the `d`
cookie) in the environment, both together. Optional: `SLACK_WORKSPACE`. Verify with `node $S whoami`;
the error message when they are missing explains where to copy them from (DevTools on a logged-in
Slack web tab). Never ask the user to paste either value into the chat: tell them which variables
to export in their shell profile. They rotate on logout; `invalid_auth` means re-copy both, do not retry.

## Rules

- `post`, `reply`, `react` and `upload` act as the user in a real, human-visible workspace. Always run
  the command with `--dry-run` first, show the user the printed preview (channel, thread, resolved
  mentions, exact text), and run it for real only after they approve that exact payload. Never write
  twice for one request; if a real write fails, report it instead of retrying blindly.
- When the user pastes a Slack link, start with `resolve <link>`: it returns the whole thread with names.
- Prefer `search` / `mentions` over asking the user to find a message. Search operators work:
  `from:@ana in:#api before:2026-06-01 after:2026-05-01 "deploy failed"`.
- Mentions: write `@handle`, `@"Full Name"`, `@here`, `@channel`, `@group` and `#channel` as plain text.
  The tool rewrites them into real Slack markup before sending. Never hand-write `<@U…>` and never ask
  for user ids. Resolution is exact-match only: anything listed under "Not linked" in the dry-run will
  NOT notify anyone, so ask the user for the exact handle instead of posting a fake mention.
- Attachments show as `📎 name [F…]` in message output. `download F…` saves the file and prints
  `Saved: <path>`; then open it with the Read tool (images, text, PDFs) or bash (video frames via ffmpeg).
- Use `--json` when you need fields the text output omits.

## Commands

| Read | |
|---|---|
| `whoami` | verify auth, show identity |
| `resolve <permalink>` | thread (or single message) behind a pasted link |
| `history <channel> [--limit N] [--oldest ts\|ISO]` | recent messages, oldest first (max 60) |
| `thread <channel> <ts>` | replies under a root message |
| `search <query> [--limit N]` | Slack search, newest first, with permalinks |
| `channels [filter] [--limit N]` | channels you can see, largest first |
| `users [filter] [--limit N]` | people: display name, @handle, id |
| `mentions [--limit N]` | recent messages that mention you |
| `download <F…\|files.slack.com URL> [--out dir]` | save an attachment (default: temp dir), prints the path |

| Write (all accept `--dry-run`) | |
|---|---|
| `post <channel> <text>` | new message |
| `reply <channel> <thread-ts> <text>` or `reply <permalink> <text>` | reply in the thread |
| `react <channel> <ts> <emoji>` or `react <permalink> <emoji>` | emoji name without colons |
| `upload <channel> <path> [--ts thread-ts] [--title T] [--text comment]` | share a local file |

`<channel>` is an id (`C…`, `D…`, `G…`) or `#name`. Message lines show `[time ts <ts>]`; that ts feeds
`thread`, `reply` and `react`. Times are UTC. Text for post/reply/upload can also come from
`--text T`, `--text-file F` or `--stdin` (use one). Values starting with `-` need `--flag=value`, or put
`--` before the command words: `node $S -- post "#general" "- first item"`.

Output: text by default, `--json` for raw data. Errors on stderr. Exit `0` ok, `1` Slack/runtime error,
`2` usage error. Name caches live in `$XDG_CACHE_HOME/slack-cli` (default `~/.cache/slack-cli`).

## Tests

`node --test script/test/` runs the CLI against an in-process fake Slack server
(`SLACK_API_BASE` / `SLACK_EDGE_BASE` override the endpoints; http is accepted only for localhost).
