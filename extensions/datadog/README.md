# datadog

Query Datadog from pi: logs, log analytics, metrics, monitors, APM spans, events, dashboards,
SLOs and hosts — plus three approval-gated writes (mute/unmute a monitor, post an event).

Everything is one tool with an `action` parameter, formatted for an LLM's context budget
(metric pointlists become min/avg/max/last + a sparkline; dashboards become a widget/query
inventory instead of raw JSON).

## Setup

Credentials come **only** from environment variables — nothing is stored in the extension.
Put one of the two schemes in your shell profile (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`):

```sh
# Scheme A — classic key pair
export DD_API_KEY="<api key>"        # Organization Settings > API Keys
export DD_APP_KEY="ddapp_..."        # Organization Settings > Application Keys

# Scheme B — scoped token, no API key needed
export DD_BEARER_TOKEN="ddpat_..."   # Personal Access Token (ddsat_ service token works too)

export DD_SITE="datadoghq.com"       # MUST match your browser URL
```

`DD_SITE` values: `datadoghq.com` (US1), `datadoghq.eu` (EU1), `us3.datadoghq.com`,
`us5.datadoghq.com`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`. The tool
normalises pasted app URLs, so `https://app.datadoghq.eu/` also works.

Anything else is **refused before the first request**, with no call made. The site becomes
the request host (`api.<site>`) while the API key and application key travel in the request
*headers*, so an unrecognised site would not fail closed — it would hand live credentials to
whatever host was named and come back with an ordinary-looking `401`. `DD_SITE` is read from
the environment, which a login shell may have populated from a project-local `.envrc`/`.env`,
so its value is not necessarily something the user typed on purpose.

If `DD_BEARER_TOKEN` is set it **wins** over the key pair. A `ddpat_`/`ddsat_` value placed
in `DD_APP_KEY` is auto-detected as a token, so migrating needs no config change.

Scoped keys/tokens need at least: `logs_read_data`, `logs_read_index_data`, `timeseries_query`,
`monitors_read`, `dashboards_read`, plus `apm_read` (spans) and `events_read` (events).

Verify with `{"action":"validate"}`.

### Install

```sh
ln -s "$PWD/extensions/datadog" ~/.pi/agent/extensions/datadog
```

Then restart pi **from a shell that sourced your profile**, so the `DD_*` vars are inherited.
If they aren't, the extension falls back to probing a login shell and every result is tagged
`config_source: shell-profile` — it works, but it's slower and worth fixing.

## Actions

| Action | Key params | Notes |
|---|---|---|
| `validate` | — | Checks the site, the auth scheme, and that reads actually work |
| `logs` | `query`, `from`, `to`, `limit`, `indexes` | Newest first, one line per event |
| `logs_aggregate` | `query`, `group_by` | Counts per facet ("errors per service") |
| `metrics` | `query`, `from`, `to` | Series reduced to min/avg/max/last + sparkline |
| `metric_search` | `query` | Find metric names before querying them |
| `monitors` | `query`, `limit` | Monitor search: `status:alert`, `muted:false`, `tag:team:core` |
| `monitor` | `id` | Definition, thresholds, per-group states, message |
| `events` | `query`, `from`, `to` | Deploys/alerts stream |
| `spans` | `query`, `from`, `to` | APM spans with duration and error flag |
| `dashboards` / `dashboard` | `query` / `id` | List / widget + query inventory |
| `slos` / `hosts` | `query` | SLO definitions / reporting hosts |
| `mute_monitor` | `id`, `end`, `scope` | **Write.** `end` is a duration (`2h`) or an absolute time |
| `unmute_monitor` | `id`, `scope` | **Write.** |
| `post_event` | `title`, `text`, `tags`, `alert_type` | **Write.** Visible in the org's event stream |

Time windows accept `now-15m`, `-2h`, `3d`, ISO timestamps, or epoch seconds/millis/micros/nanos.
An unparseable value is a hard error — it never silently becomes "now".

### Write approval

Writes are never auto-run:

- **Interactive session** — the call itself raises a confirm dialog showing the resolved payload.
- **Non-interactive** (`--mode json`, subagents, CI) — the call returns `PREVIEW ONLY` plus a
  single-use `confirm_token` bound to a hash of that exact payload, and the number of user
  messages at that moment is recorded. Replaying the token in the *same* turn is refused with
  `self-approval-blocked`: a token proves the payload is unchanged, not that a human agreed,
  and a model will read the token out of its own tool result and confirm itself. A new user
  message must arrive between preview and confirm. The identical call repeated
  with the token executes; changing any field voids it. The salt is per-process, so tokens
  cannot be guessed or replayed across sessions.

`executionMode: "sequential"` is set, because pi batches tool calls in parallel and the TUI has
one dialog slot — two concurrent confirms would deadlock the turn.

## Error semantics

| Status | Meaning |
|---|---|
| 401 | API key (or bearer token) invalid/expired |
| 403 | **Either** a missing scope **or** a revoked/deleted application key — Datadog does not use 401 for that. If *every* action 403s (including `current_user`), the app key is gone |
| 404 | Wrong id, or `DD_SITE` points at a different site than the org |
| 429 | Rate limited — narrow the window |

## Validation status

Verified against a live org (US1, ~148k monitors):

- `validate`, `monitors`, `monitor`, `metric_search`, `logs`, `logs_aggregate`, `metrics` —
  real data returned and formatted correctly.
- Write gate — `mute_monitor` in a headless run returned `PREVIEW ONLY` and muted nothing.
- Unparseable `from` — rejected with a usable message instead of defaulting.

Bugs found by that testing and fixed:

1. `logs_aggregate` sent an aggregation `sort` inside `group_by`, which the API rejects with
   HTTP 400 (`Field 'aggregation' is invalid`). Sorting is done client-side instead.
2. `spans` read the timestamp/duration from the wrong keys and rendered `?`; it now resolves
   `start_timestamp` / nested `custom.duration` (nanoseconds) and, if a field is still missing,
   reports the keys the API actually sent instead of silently printing `?`.
3. 403 was described as "valid credential, missing scope", which is wrong for a revoked
   application key — the message now covers both causes.
4. In headless sessions writes executed with no approval at all; they are token-gated now.

Not yet verified end-to-end (the test application key was revoked mid-testing):
the `spans` timestamp/duration fix, `events`/`dashboards`/`dashboard`/`slos`/`hosts` output
formatting, and actual execution of the three write actions.
