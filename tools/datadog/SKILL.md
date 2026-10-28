---
name: datadog
description: Query Datadog from the terminal - logs, log counts, metrics, monitors and alert state, APM spans/traces, events (deploys), dashboards, SLOs and hosts - and mute/unmute monitors or post events. Use when the user mentions Datadog, DD, a monitor/alert, production errors, latency, a deploy event, an incident or outage investigation, observability data, or pastes an app.datadoghq.com / datadoghq.eu / us3/us5/ap1/ap2 / ddog-gov.com link (monitor, dashboard, logs, APM trace).
---

# Datadog

Standalone, zero-dependency Node 20+ CLI at `script/datadog.mjs` in this skill's directory
(installed: `~/.claude/skills/datadog/script/datadog.mjs`).

```bash
D=~/.claude/skills/datadog/script/datadog.mjs
node $D --help              # all commands
node $D <command> --help    # one command
```

## Setup

Credentials come only from the environment. One of:

- `DD_API_KEY` + `DD_APP_KEY` (key pair), or
- `DD_BEARER_TOKEN` (`ddpat_` personal / `ddsat_` service token; wins over the pair). A `ddpat_`/`ddsat_`
  value in `DD_APP_KEY` is detected as a token automatically.
- `DD_SITE` (default `datadoghq.com`): `datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`,
  `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`. A pasted app URL is normalised.

Verify with `node $D validate`. If credentials are missing, tell the user which variables to export;
never ask them to paste a key or token into the chat. Scoped keys need `logs_read_data`,
`logs_read_index_data`, `timeseries_query`, `monitors_read`, `dashboards_read`, plus `apm_read` (spans)
and `events_read` (events).

## Rules

- Writes (`monitor mute`, `monitor unmute`, `event post`) are visible to the whole org. Always run them
  with `--dry-run` first, show the user the printed request, and only run it for real after the user
  approves (or explicitly asked for exactly that change). Never retry a write the user declined.
- If DD_SITE is refused as unknown, do not work around it (no other host, no curl): the site is the
  host that would receive the credentials. Report the message and let the user fix their env.
- Never set `DD_TEST_API_BASE`; it is a test-only override and is honored only for localhost.
- Investigate top-down: `monitors status:alert` or `logs-aggregate --group-by service` to find WHERE,
  then `logs` / `spans` for individual events. Raw log lines first waste context.
- Never guess metric names: `metric-search <substring>` first. A wrong name returns an empty series
  that looks exactly like a healthy one.
- Keep windows as narrow as the question allows (`--from -15m` live, `-24h` trends).
- 401: credential invalid/expired. 403: missing scope OR revoked app key (if every command 403s, the
  app key is gone) - tell the user which scope to add, don't retry. 404: wrong id or wrong DD_SITE.
- Use `--json` when you need fields the text output omits.

## Commands

| Read | |
|---|---|
| `validate` | site, auth scheme, and that reads work |
| `logs [query] [--from] [--to] [--limit N] [--indexes a,b] [--cursor C]` | newest first, one line each (default 15m) |
| `logs-aggregate [query] [--group-by service,status]` | counts per facet (default 1h) |
| `metrics <query> [--from] [--to]` | `avg:system.cpu.user{env:prod} by {host}`; min/avg/max/last + sparkline (default 1h) |
| `metric-search <substring>` | find metric names |
| `monitors [query]` | `status:alert`, `muted:false`, `tag:team:core` |
| `monitor <id\|url>` | definition, thresholds, not-OK groups, message |
| `events [query] [--from] [--to]` | deploys/alerts stream (default 15m) |
| `spans [query] [--from] [--to] [--cursor C]` | APM spans: duration, ERROR flag (default 15m) |
| `dashboards [substring]` / `dashboard <id\|url>` | list / widget + query inventory |
| `slos [query]` / `hosts [filter]` | SLO targets / UP-DOWN hosts |

| Write (all accept `--dry-run`) | |
|---|---|
| `monitor mute <id\|url> [--end 2h\|ISO\|epoch] [--scope host:web-01]` | `--end` duration is from now; omit = indefinitely |
| `monitor unmute <id\|url> [--scope s]` | |
| `event post <title> [--text T \| --text-file F \| --text-stdin] [--tags a,b] [--alert-type info\|warning\|error\|success]` | |

`--limit` defaults to 25 (max 200). Time values: `now`, `now-15m`, `-2h`, `3d`, ISO timestamps, epoch
seconds/millis/micros/nanos; an unparseable value is an error, never "now". Links work as input:
`monitor https://app.datadoghq.com/monitors/123`, `dashboard https://.../dashboard/abc-def-ghi/...`, and a
logs/APM/events explorer URL as the query of `logs`/`spans`/`events` (its `query`, `from_ts`, `to_ts`
are used unless `--from`/`--to` are given; `/apm/trace/<id>` becomes `trace_id:<id>`). A query starting
with `-` needs `--query=-foo`. When results are truncated, `logs`/`spans` print the `--cursor` for the
next page. The original Pi action names (`logs_aggregate`, `mute_monitor`, `post_event`, ...) work as aliases.

Output: text by default, `--json` for the raw API response. Errors on stderr. Exit `0` ok, `1` API/runtime
error, `2` usage error.

## Tests

`node --test script/test/` runs the CLI against an in-process fake Datadog server
(via `DD_TEST_API_BASE`, loopback only). No real API calls.
