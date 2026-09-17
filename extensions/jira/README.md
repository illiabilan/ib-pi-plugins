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

Read: `show`, `list`, `search`, `boards`, `backlog`, `find_duplicates`, `transitions`, `projects`,
`me`, `stats`, `sprint_stats`, `link_types`, `createmeta`, `test_token`.
Write: `create`, `update`, `transition`, `comment`, `link`, `delete` — in interactive (TUI/RPC)
sessions each write asks the user to confirm before anything is sent.

```json
{"action":"show","issue_key":"ADA-123"}
{"action":"projects","project":"subs"}   // optional key/name filter; unfiltered list is capped at 40
{"action":"search","jql":"project = ADA AND status = \"In Progress\"","limit":20}
{"action":"createmeta","project":"ADA","issue_type":"Story"}
{"action":"create","fields":{"project":{"key":"ADA"},"issuetype":{"name":"Story"},"summary":"…","customfield_10014":"SUBR-9433"}}
{"action":"update","issue_key":"ADA-123","fields":{"summary":"New title"}}
{"action":"link","issue_key":"ADA-123","link_type":"child-of","target_key":"SUBR-9433"}
```

## Backlog review & de-duplication

```json
{"action":"boards","project":"ADA"}
{"action":"backlog","project":"ADA","limit":300}          // ranked board backlog (Agile API)
{"action":"find_duplicates","project":"ADA","threshold":0.6}
{"action":"transitions","issue_key":"ADA-123"}
{"action":"link","issue_keys":["ADA-2","ADA-3"],"link_type":"duplicates","target_key":"ADA-1"}
{"action":"transition","issue_keys":["ADA-2","ADA-3"],"transition":"Done","resolution":"Duplicate","body":"Closing as duplicate of ADA-1"}
{"action":"delete","issue_keys":["ADA-9"],"confirm_delete":true}
```

`find_duplicates` scans a scope (`project` → `statusCategory != Done`, or an explicit `jql`, or a
`board_id` backlog), then clusters issues **locally** — no LLM, no extra API calls:

- score = `0.65·Jaccard(summary tokens) + 0.35·Dice(summary trigrams)`, nudged by description
  overlap (`0.85·summary + 0.15·description`) when both have one; stemming + stopword removal,
  issue keys/URLs stripped, `8.7` vs `8.9` kept distinct;
- an inverted-index prefilter skips pairs with no rare token in common (1000 issues ≈ 70 ms);
- union-find clustering, default `threshold` 0.55 (raise to 0.75+ for near-identical only);
- each cluster reports a **suggested canonical** (most progressed → most linked → oldest), pairs
  **already linked** as duplicates, and a ready-to-paste `link` cleanup call;
- clusters where every member has a unique term are flagged as a **TEMPLATE SERIES**
  (`…for the Redeem screen` / `…for the Save screen`) — the most common false positive.

Clusters are candidates, not verdicts: show them to a human before closing anything.

`transition` resolves the transition by name, destination status name or id, and retries without
`resolution` if that field isn't on the transition screen. `delete` is irreversible and additionally
requires `confirm_delete: true`.

`transition`, `comment`, `delete` and `link` accept `issue_keys: [...]` for bulk cleanup: one
approval, per-key success/failure reporting, and a single failure never aborts the batch.

## Tests

`dedupe.test.ts` covers the duplicate-detection helpers (no network, no credentials):

```bash
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules" node_modules   # once, repo root
node --experimental-strip-types extensions/jira/dedupe.test.ts
```

`link_type` shortcuts read source-relative (`issue_key <link_type> target_key`):
`child-of`, `parent-of`, `blocks`, `is-blocked-by`, `relates-to`, `duplicates`, `clones`.
Direction was verified against a live instance with `issue in linkedIssues(KEY, "phrase")`;
the older `jira_cli.sh link` command had these inverted.

## Notes

- Search uses `POST /rest/api/3/search/jql` and follows `nextPageToken`, so `search`, `backlog`
  and `find_duplicates` are not capped at one 100-issue page (`limit` up to 2000 for scans).
- Boards/backlogs come from the **Agile** API (`/rest/agile/1.0`), which is a different base path
  from the platform API. `projectKeyOrId` matches every board whose filter sees the project, so
  `backlog` prefers a board actually located in that project, warns when it has to fall back, and
  warns again if the returned backlog contains foreign issue keys. Projects without a board fall
  back to a `ORDER BY Rank ASC` JQL scan.
- Everything else uses REST v2 (plain-text descriptions rather than ADF); ADF coming back from the
  v3 search endpoint is flattened to text for `show` and for duplicate scoring.
- No npm dependencies (uses `fetch` from Node 18+).
