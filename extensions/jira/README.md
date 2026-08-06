# jira — pi extension

Registers one LLM-callable tool, `jira`, that talks to the Jira Cloud REST API directly
(no `curl`, no `jq`, no shell script, no `source ~/.zshrc`).

Companion skill: `~/.pi/agent/skills/jira/SKILL.md`.

## Configuration — environment variables only

Nothing is hardcoded. Add to your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.zprofile`) and
restart pi:

```bash
export JIRA_USERNAME="your-email@example.com"     # required — Atlassian account email
export JIRA_API_TOKEN="your-atlassian-api-token"  # required — https://id.atlassian.com/manage-profile/security/api-tokens
export JIRA_URL="https://yourcompany.atlassian.net"  # optional — default https://grubhub.atlassian.net
```

Tokens typically expire after ~90 days; regenerate and re-export on HTTP 401.

Every tool result ends with `config_source: <env|shell-profile|none>`:

| value | meaning |
|---|---|
| `env` | credentials inherited from the process environment (normal path) |
| `shell-profile` | env vars were missing, so the extension probed `$SHELL -l -i -c` once to recover them — slower, and a hint that pi wasn't started from a shell with the profile loaded |
| `none` | not configured; the result text contains the exact `export` lines to add |

## Actions

Read: `show`, `list`, `search`, `projects`, `me`, `stats`, `sprint_stats`, `link_types`,
`createmeta`, `test_token`.
Write: `create`, `update`, `link` — in interactive (TUI/RPC) sessions each write asks the user to
confirm before anything is sent.

```json
{"action":"show","issue_key":"ADA-123"}
{"action":"projects","project":"subs"}   // optional key/name filter; unfiltered list is capped at 40
{"action":"search","jql":"project = ADA AND status = \"In Progress\"","limit":20}
{"action":"createmeta","project":"ADA","issue_type":"Story"}
{"action":"create","fields":{"project":{"key":"ADA"},"issuetype":{"name":"Story"},"summary":"…","customfield_10014":"SUBR-9433"}}
{"action":"update","issue_key":"ADA-123","fields":{"summary":"New title"}}
{"action":"link","issue_key":"ADA-123","link_type":"child-of","target_key":"SUBR-9433"}
```

`link_type` shortcuts read source-relative (`issue_key <link_type> target_key`):
`child-of`, `parent-of`, `blocks`, `is-blocked-by`, `relates-to`, `duplicates`, `clones`.
Direction was verified against a live instance with `issue in linkedIssues(KEY, "phrase")`;
the older `jira_cli.sh link` command had these inverted.

## Notes

- Search uses `POST /rest/api/3/search/jql`; everything else uses REST v2 (plain-text
  descriptions rather than ADF).
- No npm dependencies (uses `fetch` from Node 18+).
