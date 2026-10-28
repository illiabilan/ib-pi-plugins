import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Client, DatadogError, TEST_BASE_ENV, errText, loadCreds, schemeLabel, testBase } from "./client.mjs";
import {
  ago,
  cleanName,
  dashboardIdFrom,
  dashboardWidgetRows,
  dryRunText,
  eventLine,
  explorerFromUrl,
  iso,
  logLine,
  monitorIdFrom,
  monitorLine,
  parseEnd,
  parseTime,
  sec,
  spanRows,
  stamp,
  summarizeSeries,
  trunc,
} from "./format.mjs";

/** Superset of every flag. Each command declares which subset it accepts (typos fail loudly). */
const OPTION_TYPES = {
  query: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  limit: { type: "string" },
  indexes: { type: "string" },
  "group-by": { type: "string" },
  cursor: { type: "string" },
  end: { type: "string" },
  scope: { type: "string" },
  title: { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  "text-stdin": { type: "boolean" },
  tags: { type: "string", multiple: true },
  "alert-type": { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const GLOBAL_OPTS = ["json", "dry-run", "help"];
const WINDOW = ["from", "to"];

/** Original Pi action names (and hyphen/underscore variants) map onto the CLI commands. */
const ALIASES = {
  logs_aggregate: "logs-aggregate",
  "logs-agg": "logs-aggregate",
  metric_search: "metric-search",
  mute_monitor: ["monitor", "mute"],
  "mute-monitor": ["monitor", "mute"],
  unmute_monitor: ["monitor", "unmute"],
  "unmute-monitor": ["monitor", "unmute"],
  post_event: ["event", "post"],
  "post-event": ["event", "post"],
};

const EVENT_ALERT_TYPES = ["info", "warning", "error", "success", "user_update", "recommendation", "snapshot"];

const usageErr = (m) => new DatadogError(m, { code: "usage" });
const csv = (arr = []) => arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);

/** --limit: default 25, clamped to 1..200 like the original tool. */
function limitOf(v) {
  if (v.limit === undefined) return 25;
  const n = Number(v.limit);
  if (!Number.isInteger(n) || n < 1) throw usageErr(`--limit must be a positive integer, got "${v.limit}".`);
  return Math.min(n, 200);
}

/**
 * The main query: positionals joined by spaces, or --query (needed when it starts with "-").
 * A Datadog explorer URL (logs/APM/events) is accepted too; its query, from_ts and to_ts are used
 * unless --from/--to are given.
 */
function queryOf(pos, v) {
  if (v.query !== undefined && pos.length) throw usageErr("Pass the query either as an argument or with --query, not both.");
  const q = v.query ?? (pos.length ? pos.join(" ") : undefined);
  const link = explorerFromUrl(q);
  if (link) return { query: link.query, from: link.from, to: link.to, fromUrl: true };
  return { query: q?.trim() ? q : undefined };
}

/** Window resolution: a bad time string fails loudly, it never silently becomes "now". */
function windowOf(v, defaultMs, link = {}) {
  const fromRaw = v.from ?? link.from;
  const toRaw = v.to ?? link.to;
  const f = fromRaw === undefined ? ago(defaultMs) : parseTime(fromRaw);
  if (!f) throw usageErr(`Could not parse --from "${fromRaw}". Use now-15m, -2h, 3d, an ISO timestamp or epoch.`);
  const t = toRaw === undefined ? new Date() : parseTime(toRaw);
  if (!t) throw usageErr(`Could not parse --to "${toRaw}". Use now, an ISO timestamp or epoch.`);
  if (f.getTime() >= t.getTime()) throw usageErr(`Window start ${iso(f)} is not before its end ${iso(t)}.`);
  return { f, t };
}

const indexesOf = (v) => (v.indexes ? v.indexes.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const expand = (p) => resolvePath(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

function readText(v) {
  const given = ["text", "text-file", "text-stdin"].filter((k) => v[k] !== undefined && v[k] !== false);
  if (given.length > 1) throw usageErr("Use only one of --text, --text-file, --text-stdin.");
  if (v.text !== undefined) return v.text;
  if (v["text-file"] !== undefined) return readFileSync(expand(v["text-file"]), "utf8");
  if (v["text-stdin"]) return readFileSync(0, "utf8");
  return undefined;
}

const moreHint = (after) => (after ? `\n(more results available: rerun with --cursor ${after}, or narrow the query / raise --limit)` : "");

/* ------------------------------------------------------------------ commands */

const COMMANDS = {
  validate: {
    usage: "validate",
    desc: "Check DD_SITE, the auth scheme in use, and that reads actually work (monitor read + current user).",
    opts: [],
    async run({ client }) {
      // /api/v1/validate only checks the API key, so hit an app-key/scope-gated endpoint instead:
      // a pair where only the API key is valid must not report OK.
      const probe = await client.raw("GET", "/api/v1/monitor", { query: { page_size: 1 } });
      const who = await client.raw("GET", "/api/v2/current_user");
      const a = who.ok ? (who.json?.data?.attributes ?? {}) : {};
      const lines = [`Site:   api.${client.site}`, `Scheme: ${schemeLabel(client.creds)}`];
      if (a.name || a.email) lines.push(`User:   ${a.name ?? "?"} <${a.email ?? "?"}>`);
      if (!probe.ok) {
        throw new DatadogError(
          [
            ...lines,
            "",
            "Credentials NOT working for read queries.",
            errText(probe, client.creds),
            who.ok
              ? `The API key itself is accepted (current_user succeeded), so the problem is the ${client.creds.scheme === "bearer" ? "token" : "APPLICATION key"}: it is revoked, deleted or unscoped.`
              : `Neither the monitor read nor current_user succeeded, so both credentials are suspect, or DD_SITE=${client.site} is the wrong site for this org.`,
          ].join("\n"),
          { status: probe.status, code: "http" },
        );
      }
      lines.push("Status: OK, authenticated and able to read monitors.");
      if (!who.ok) lines.push(`Note:   /api/v2/current_user returned HTTP ${who.status} (normal for service tokens and narrowly scoped keys).`);
      const data = { site: client.site, apiHost: `api.${client.site}`, scheme: client.creds.scheme, ok: true, user: a.email ? { name: a.name, email: a.email } : null, currentUserStatus: who.status };
      return { data, text: lines.join("\n") };
    },
  },

  logs: {
    usage: "logs [query] [--from T] [--to T] [--limit N] [--indexes a,b] [--cursor C]",
    desc: "Search log events, newest first, one line per event. Query uses log search syntax ('service:checkout status:error -/health'); default '*', window 15m. Accepts a logs explorer URL.",
    opts: ["query", ...WINDOW, "limit", "indexes", "cursor"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v);
      const query = q.query ?? "*";
      const { f, t } = windowOf(v, 15 * 6e4, q);
      const limit = limitOf(v);
      const body = { filter: { from: iso(f), to: iso(t), query }, page: { limit }, sort: "-timestamp" };
      const indexes = indexesOf(v);
      if (indexes) body.filter.indexes = indexes;
      if (v.cursor) body.page.cursor = v.cursor;
      const r = await client.call("POST", "/api/v2/logs/events/search", { body });
      const data = r.data ?? [];
      const head = `Logs "${query}"  ${iso(f)} → ${iso(t)}`;
      if (!data.length) {
        return { data: r, text: `${head}\n\nNo matching log events. Check the query syntax (facets are case-sensitive, e.g. service:checkout), widen the window, or verify the index is readable by this key.` };
      }
      return { data: r, text: `${head}\n${data.length} events, newest first:\n\n${data.map(logLine).join("\n")}${moreHint(r.meta?.page?.after)}` };
    },
  },

  "logs-aggregate": {
    usage: "logs-aggregate [query] [--group-by facet1,facet2] [--from T] [--to T] [--limit N] [--indexes a,b]",
    desc: "Log counts instead of raw lines ('errors per service'). Omit --group-by for one total. Default window 1h; groups sorted by count, at most 50 per facet.",
    opts: ["query", ...WINDOW, "limit", "indexes", "group-by"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v);
      const query = q.query ?? "*";
      const { f, t } = windowOf(v, 60 * 6e4, q);
      const limit = limitOf(v);
      const facets = (v["group-by"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const body = {
        filter: { from: iso(f), to: iso(t), query },
        compute: [{ aggregation: "count", type: "total" }],
        // No `sort` here: the API rejects an aggregation sort on a group_by unless it also
        // carries type:"measure"; buckets are sorted client-side below.
        group_by: facets.map((facet) => ({ facet, limit: Math.min(limit, 50) })),
      };
      const indexes = indexesOf(v);
      if (indexes) body.filter.indexes = indexes;
      const r = await client.call("POST", "/api/v2/logs/analytics/aggregate", { body });
      const buckets = r.data?.buckets ?? [];
      const head = `Log counts "${query}"  ${iso(f)} → ${iso(t)}${facets.length ? `  by ${facets.join(", ")}` : ""}`;
      if (!buckets.length) return { data: r, text: `${head}\n\nNo matching log events in this window.` };
      const rows = buckets
        .map((b) => {
          const key = facets.length ? facets.map((k) => `${k}=${b.by?.[k] ?? "-"}`).join(" ") : "total";
          const c = b.computes?.c0 ?? Object.values(b.computes ?? {})[0];
          return { key, c: Number(c ?? 0) };
        })
        .sort((a, b) => b.c - a.c);
      const total = rows.reduce((a, x) => a + x.c, 0);
      return { data: r, text: `${head}\ntotal ${total} across ${rows.length} group(s):\n\n${rows.map((x) => `  ${String(x.c).padStart(9)}  ${x.key}`).join("\n")}` };
    },
  },

  metrics: {
    usage: "metrics <query> [--from T] [--to T] [--limit N]",
    desc: "Timeseries query ('avg:system.cpu.user{env:prod} by {host}'). Each series is reduced to min/avg/max/last + a sparkline (max 40 series). Default window 1h. Find names with metric-search first.",
    opts: ["query", ...WINDOW, "limit"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v);
      if (!q.query?.trim()) throw usageErr("A query is required, e.g. metrics 'avg:system.cpu.user{env:prod} by {host}'. Use metric-search to find metric names.");
      const { f, t } = windowOf(v, 60 * 6e4, q);
      const limit = limitOf(v);
      const r = await client.get("/api/v1/query", { from: sec(f), to: sec(t), query: q.query });
      if (r.status === "error" || r.error) throw new DatadogError(`Query rejected by Datadog: ${r.error ?? r.status}`, { code: "query" });
      const series = r.series ?? [];
      const head = `Metric "${q.query}"  ${iso(f)} → ${iso(t)}`;
      if (!series.length) {
        return { data: r, text: `${head}\n\nNo series returned. Either the metric name does not exist (verify with metric-search), the tag filter matches nothing, or the metric reported no data in this window.` };
      }
      const shown = series.slice(0, Math.min(limit, 40));
      const note = series.length > shown.length ? `\n(${series.length - shown.length} more series not shown)` : "";
      const unit = r.unit?.[0]?.short_name ? `, unit ${r.unit[0].short_name}` : "";
      return { data: r, text: `${head}\n${series.length} series${unit}:\n\n${shown.map(summarizeSeries).join("\n")}${note}` };
    },
  },

  "metric-search": {
    usage: "metric-search <substring> [--limit N]",
    desc: "Find metric names containing a substring (case-sensitive, dot-separated). Shows up to limit*4 (max 200).",
    opts: ["query", "limit"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v).query;
      if (!q?.trim()) throw usageErr("A substring is required, e.g. metric-search trace.http");
      const limit = limitOf(v);
      const r = await client.get("/api/v1/search", { q: `metrics:${q}` });
      const metrics = r.results?.metrics ?? [];
      if (!metrics.length) return { data: r, text: `No metric name contains "${q}". Metric names are case-sensitive and dot-separated (e.g. trace.http.request.duration).` };
      const shown = metrics.slice(0, Math.min(limit * 4, 200));
      return { data: r, text: `Metrics matching "${q}" (${shown.length} of ${metrics.length}):\n${shown.map((m) => `  ${m}`).join("\n")}` };
    },
  },

  monitors: {
    usage: "monitors [query] [--limit N]",
    desc: "Monitor search: 'status:alert', 'muted:false', 'tag:team:core', 'type:\"metric alert\"', or free text on the name.",
    opts: ["query", "limit"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v).query;
      const limit = limitOf(v);
      const r = await client.get("/api/v1/monitor/search", { query: q ?? "", per_page: limit });
      const monitors = r.monitors ?? [];
      const total = r.metadata?.total_count ?? monitors.length;
      const head = `Monitors${q ? ` matching "${q}"` : ""} (${monitors.length} of ${total})`;
      if (!monitors.length) {
        return { data: r, text: `${head}\n\nNothing matched. Monitor search syntax: 'status:alert', 'muted:false', 'tag:team:core', 'type:metric alert', or free text on the name.` };
      }
      // An unfiltered search on a big org returns an arbitrary slice of tens of thousands of monitors.
      const hint =
        !q && total > monitors.length
          ? `\nNOTE: unfiltered, this is an arbitrary ${monitors.length} of ${total} monitors. Pass 'status:alert', 'muted:false' or 'tag:service:<name>' to get a meaningful set.`
          : "";
      const counts = new Map();
      for (const m of monitors) counts.set(m.status ?? "?", (counts.get(m.status ?? "?") ?? 0) + 1);
      return { data: r, text: `${head}\nby status: ${[...counts].map(([k, n]) => `${k}=${n}`).join(" ")}${hint}\n\n${monitors.map(monitorLine).join("\n")}` };
    },
  },

  monitor: {
    usage: "monitor <id|url> [--limit N]",
    desc: "One monitor: query, thresholds, tags, message and the groups that are not OK (max 40). Accepts a .../monitors/<id> link.",
    opts: ["limit"],
    async run({ client, pos, v }) {
      const id = monitorIdOf(pos[0]);
      const limit = limitOf(v);
      const m = await client.get(`/api/v1/monitor/${encodeURIComponent(id)}`, { group_states: "all" });
      const groups = Object.entries(m.state?.group_states ?? {});
      const notOk = groups.filter(([, g]) => g?.status && g.status !== "OK");
      const silenced = m.options?.silenced ?? {};
      const text = [
        `Monitor: [${m.id}] ${cleanName(m.name)}`,
        `URL:     https://app.${client.site}/monitors/${m.id}`,
        `Status:  ${m.overall_state ?? "?"}${Object.keys(silenced).length ? `  (MUTED: ${JSON.stringify(silenced)})` : ""}`,
        `Type:    ${m.type ?? "?"}`,
        `Query:   ${m.query ?? "?"}`,
        m.options?.thresholds ? `Thresh:  ${JSON.stringify(m.options.thresholds)}` : null,
        m.tags?.length ? `Tags:    ${m.tags.join(", ")}` : null,
        `Modified:${stamp(m.modified)}`,
        groups.length ? `\nGroups: ${groups.length} total, ${notOk.length} not OK` : null,
        ...notOk.slice(0, Math.min(limit, 40)).map(([name, g]) => `  ${g.status}  ${trunc(name, 80)}  since ${stamp(g.last_triggered_ts)}`),
        m.message ? `\nMessage:\n${trunc(m.message, 1200)}` : null,
      ]
        .filter((l) => l !== null)
        .join("\n");
      return { data: m, text };
    },
  },

  events: {
    usage: "events [query] [--from T] [--to T] [--limit N]",
    desc: "The event stream (deploys, alerts), newest first. Default window 15m. Accepts an event explorer URL.",
    opts: ["query", ...WINDOW, "limit"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v);
      const { f, t } = windowOf(v, 15 * 6e4, q);
      const limit = limitOf(v);
      const r = await client.get("/api/v2/events", {
        "filter[query]": q.query ?? "",
        "filter[from]": iso(f),
        "filter[to]": iso(t),
        "page[limit]": limit,
        sort: "-timestamp",
      });
      const data = r.data ?? [];
      const head = `Events${q.query ? ` "${q.query}"` : ""}  ${iso(f)} → ${iso(t)}`;
      if (!data.length) return { data: r, text: `${head}\n\nNo events in this window.` };
      return { data: r, text: `${head}\n${data.length} events, newest first:\n\n${data.map(eventLine).join("\n")}` };
    },
  },

  spans: {
    usage: "spans [query] [--from T] [--to T] [--limit N] [--cursor C]",
    desc: "APM spans with duration and error flag, newest first ('service:checkout status:error', '@http.status_code:500'). Default window 15m. Accepts an APM explorer or /apm/trace/<id> URL.",
    opts: ["query", ...WINDOW, "limit", "cursor"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v);
      const query = q.query ?? "*";
      const { f, t } = windowOf(v, 15 * 6e4, q);
      const limit = limitOf(v);
      const page = { limit };
      if (v.cursor) page.cursor = v.cursor;
      const r = await client.call("POST", "/api/v2/spans/events/search", {
        body: { data: { type: "search_request", attributes: { filter: { from: iso(f), to: iso(t), query }, page, sort: "-timestamp" } } },
      });
      const data = r.data ?? [];
      const head = `APM spans "${query}"  ${iso(f)} → ${iso(t)}`;
      if (!data.length) {
        return { data: r, text: `${head}\n\nNo spans matched. APM search uses facets like service:, resource_name:, operation_name:, status:error, @http.status_code:500.` };
      }
      const { rows, diag } = spanRows(data);
      return { data: r, text: `${head}\n${data.length} spans, newest first:\n\n${rows.join("\n")}${diag}${moreHint(r.meta?.page?.after)}` };
    },
  },

  dashboards: {
    usage: "dashboards [substring] [--limit N]",
    desc: "List dashboards, optionally filtered by a title/description substring (shows up to limit*2, max 100).",
    opts: ["query", "limit"],
    async run({ client, pos, v }) {
      const raw = queryOf(pos, v).query;
      const limit = limitOf(v);
      const r = await client.get("/api/v1/dashboard");
      const all = r.dashboards ?? [];
      const q = raw?.trim().toLowerCase();
      const list = q ? all.filter((d) => `${d.title ?? ""} ${d.description ?? ""}`.toLowerCase().includes(q)) : all;
      if (!list.length) return { data: list, text: q ? `No dashboard title/description contains "${raw}" (${all.length} visible).` : "No dashboards visible." };
      const shown = list.slice(0, Math.min(limit * 2, 100));
      return {
        data: shown,
        text: `Dashboards (${shown.length} of ${list.length}${q ? ` matching "${raw}"` : ""}):\n${shown
          .map((d) => `  ${d.id}  ${trunc(d.title, 80)}${d.is_read_only ? " [ro]" : ""}`)
          .join("\n")}\n\nUse: datadog dashboard <id> for a widget inventory.`,
      };
    },
  },

  dashboard: {
    usage: "dashboard <id|url> [--limit N]",
    desc: "One dashboard as a widget + query inventory (not the layout JSON; shows up to limit*3 rows, max 150). Accepts a .../dashboard/<id> link.",
    opts: ["limit"],
    async run({ client, pos, v }) {
      if (!pos[0]) throw usageErr("A dashboard id is required (see: datadog dashboards).");
      const id = dashboardIdFrom(pos[0]);
      if (!id) throw usageErr(`Not a dashboard id or dashboard link: "${pos[0]}".`);
      const limit = limitOf(v);
      const d = await client.get(`/api/v1/dashboard/${encodeURIComponent(id)}`);
      const rows = dashboardWidgetRows(d.widgets);
      const capped = rows.slice(0, Math.min(limit * 3, 150));
      const text = [
        `Dashboard: ${d.title ?? "?"} (${d.id ?? id})`,
        `URL:       https://app.${client.site}/dashboard/${d.id ?? id}`,
        d.description ? `Desc:      ${trunc(d.description, 300)}` : null,
        d.template_variables?.length ? `Vars:      ${d.template_variables.map((x) => `$${x.name}=${x.default ?? "*"}`).join(" ")}` : null,
        `\nWidgets (${rows.length}${capped.length < rows.length ? `, ${capped.length} shown` : ""}):`,
        ...capped,
      ]
        .filter((l) => l !== null)
        .join("\n");
      return { data: d, text };
    },
  },

  slos: {
    usage: "slos [query] [--limit N]",
    desc: "SLO definitions with type and targets (max 100).",
    opts: ["query", "limit"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v).query;
      const limit = limitOf(v);
      const r = await client.get("/api/v1/slo", { limit: Math.min(limit, 100), query: q });
      const data = r.data ?? [];
      if (!data.length) return { data: r, text: q ? `No SLO matched "${q}".` : "No SLOs defined." };
      return {
        data: r,
        text: `SLOs (${data.length}):\n${data
          .map((s) => `  ${s.id}  ${trunc(s.name, 70)}  type=${s.type ?? "?"}  targets=${(s.thresholds ?? []).map((x) => `${x.target}%/${x.timeframe}`).join(",")}`)
          .join("\n")}`,
      };
    },
  },

  hosts: {
    usage: "hosts [filter] [--limit N]",
    desc: "Reporting hosts with UP/DOWN and a few Datadog tags (max 100).",
    opts: ["query", "limit"],
    async run({ client, pos, v }) {
      const q = queryOf(pos, v).query;
      const limit = limitOf(v);
      const r = await client.get("/api/v1/hosts", { filter: q, count: Math.min(limit, 100), sort_field: "status" });
      const list = r.host_list ?? [];
      const total = r.total_matching ?? list.length;
      if (!list.length) return { data: r, text: q ? `No host matched "${q}".` : "No hosts reporting." };
      return {
        data: r,
        text: `Hosts (${list.length} of ${total}${q ? ` matching "${q}"` : ""}):\n${list
          .map((h) => `  ${h.up ? "UP  " : "DOWN"} ${trunc(h.host_name ?? h.name, 44).padEnd(44)} ${trunc((h.tags_by_source?.Datadog ?? []).slice(0, 4).join(","), 60)}`)
          .join("\n")}`,
      };
    },
  },

  "monitor mute": {
    usage: "monitor mute <id|url> [--end 2h|ISO|epoch] [--scope host:web-01]",
    desc: "WRITE. Mute a monitor (org-visible). --end is a duration from now (2h, 30m, 1d) or an absolute time; omit to mute indefinitely. Use --dry-run first.",
    opts: ["end", "scope"],
    write: true,
    async run({ client, pos, v }) {
      const id = monitorIdOf(pos[0]);
      const body = {};
      if (v.scope) body.scope = v.scope;
      if (v.end !== undefined) {
        const e = parseEnd(v.end);
        if (!e) throw usageErr(`Could not parse --end "${v.end}". Use a duration (2h), an ISO timestamp or epoch seconds.`);
        if (e.getTime() <= Date.now()) throw usageErr(`--end "${v.end}" resolves to the past (${iso(e)}); the mute would expire immediately.`);
        body.end = sec(e);
      }
      const until = body.end ? ` until ${iso(new Date(body.end * 1000))}` : " indefinitely";
      client.intent(`Mute monitor ${id}${until}${v.scope ? ` for scope ${v.scope}` : ""} on ${client.site}`);
      const r = await client.call("POST", `/api/v1/monitor/${encodeURIComponent(id)}/mute`, { body, write: true });
      return {
        data: r,
        text: `Muted monitor [${r.id ?? id}] ${r.name ?? ""}${until}${v.scope ? ` for scope ${v.scope}` : ""}\nURL: https://app.${client.site}/monitors/${id}`,
      };
    },
  },

  "monitor unmute": {
    usage: "monitor unmute <id|url> [--scope host:web-01]",
    desc: "WRITE. Unmute a monitor, or only one scope of it. Use --dry-run first.",
    opts: ["scope"],
    write: true,
    async run({ client, pos, v }) {
      const id = monitorIdOf(pos[0]);
      client.intent(`Unmute monitor ${id}${v.scope ? ` for scope ${v.scope}` : ""} on ${client.site}`);
      const r = await client.call("POST", `/api/v1/monitor/${encodeURIComponent(id)}/unmute`, { body: v.scope ? { scope: v.scope } : {}, write: true });
      return { data: r, text: `Unmuted monitor [${r.id ?? id}] ${r.name ?? ""}`.trimEnd() };
    },
  },

  "event post": {
    usage: "event post <title> [--text T | --text-file F | --text-stdin] [--tags env:prod,team:core] [--alert-type info|warning|error|success]",
    desc: "WRITE. Post an event to the org's event stream (Datadog markdown body; defaults to the title). Use --dry-run first.",
    opts: ["title", "text", "text-file", "text-stdin", "tags", "alert-type"],
    write: true,
    async run({ client, pos, v }) {
      if (v.title !== undefined && pos.length) throw usageErr("Pass the title either as an argument or with --title, not both.");
      const title = v.title ?? pos.join(" ");
      if (!title?.trim()) throw usageErr("A title is required: event post \"Deploy checkout v42\"");
      const alertType = v["alert-type"] ?? "info";
      if (!EVENT_ALERT_TYPES.includes(alertType)) throw usageErr(`--alert-type must be one of ${EVENT_ALERT_TYPES.join(", ")}, got "${alertType}".`);
      const text = readText(v);
      const body = { title, text: text ?? title, tags: csv(v.tags), alert_type: alertType };
      client.intent(`Post ${alertType} event "${trunc(title, 120)}"${body.tags.length ? ` tags ${body.tags.join(",")}` : ""} to ${client.site}`);
      const r = await client.call("POST", "/api/v1/events", { body, write: true });
      const id = r.event?.id ?? r.id;
      return { data: r, text: `Posted event${id ? ` id=${id}` : ""}: ${title}${id ? `\nURL: https://app.${client.site}/event/event?id=${id}` : ""}` };
    },
  },
};

function monitorIdOf(ref) {
  if (!ref) throw usageErr("A monitor id is required (numeric id or a .../monitors/<id> link).");
  const id = monitorIdFrom(ref);
  if (!id) throw usageErr(`Not a monitor id or monitor link: "${ref}". Monitor ids are numeric.`);
  return id;
}

/* ------------------------------------------------------------------ help */

function helpText(cmdName) {
  if (cmdName && COMMANDS[cmdName]) {
    const c = COMMANDS[cmdName];
    const flags = c.opts.length ? c.opts.map((o) => `--${o}`).join(", ") : "(none)";
    const extra = WINDOW.some((w) => c.opts.includes(w))
      ? "\nTime values: now, now-15m, -2h, 3d, an ISO timestamp, or epoch seconds/millis/micros/nanos. An unparseable value is an error."
      : "";
    return `${c.desc}\n\nUsage: datadog ${c.usage}\nFlags: ${flags}\nFlags valid for every command: --json, --dry-run${c.write ? "" : " (writes only)"}, --help${extra}`;
  }
  const rows = Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.desc}`);
  return [
    "datadog: query Datadog from the terminal, built for scripts and AI agents.",
    "",
    "Auth (environment only): DD_API_KEY + DD_APP_KEY, or DD_BEARER_TOKEN (ddpat_/ddsat_; also accepted in DD_APP_KEY).",
    "DD_SITE (default datadoghq.com) must be a known Datadog site; anything else is refused before any request.",
    `${TEST_BASE_ENV} is a test-only API base override, honored only for localhost/127.0.0.1/[::1].`,
    "Output: compact text by default, --json for the raw API response. Errors go to stderr; exit 1 (2 for usage errors).",
    "Writes (monitor mute/unmute, event post) support --dry-run: prints the exact request (credentials redacted) and sends nothing.",
    "Time values: now, now-15m, -2h, 3d, ISO timestamps, epoch seconds/millis/micros/nanos.",
    "A query starting with '-' needs --query=<value>.",
    "",
    "Commands:",
    ...rows,
  ].join("\n");
}

/* ------------------------------------------------------------------ main */

/**
 * "--from -2h" is the documented way to write a relative window, but parseArgs treats "-2h" as
 * a flag. Rewrite it to "--from=-2h" for the time flags only (value like -15m / -2h / -3d).
 */
function joinDashTimes(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.push(...argv.slice(i));
      break;
    }
    if (["--from", "--to", "--end"].includes(a) && /^-\s*\d+\s*[smhdw]$/i.test(argv[i + 1] ?? "")) {
      out.push(`${a}=${argv[++i]}`);
    } else out.push(a);
  }
  return out;
}

function resolveCommand(positionals) {
  const p = [...positionals];
  const alias = ALIASES[p[0]];
  if (alias) p.splice(0, 1, ...(Array.isArray(alias) ? alias : [alias]));
  const two = p.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, pos: p.slice(2) };
  if (COMMANDS[p[0]]) return { name: p[0], pos: p.slice(1) };
  return { name: null, pos: p };
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl } = {}) {
  const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const err = (s) => stderr.write(s.endsWith("\n") ? s : `${s}\n`);
  let json = argv.includes("--json");
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: joinDashTimes(argv), options: OPTION_TYPES, allowPositionals: true, strict: true });
    } catch (e) {
      throw usageErr(`${e.message}\nRun "datadog --help" for usage.`);
    }
    const { values: v, positionals } = parsed;
    json = !!v.json;
    if (!positionals.length || (positionals[0] === "help" && positionals.length === 1)) {
      out(helpText());
      return 0;
    }
    const { name, pos } = resolveCommand(positionals[0] === "help" ? positionals.slice(1) : positionals);
    if (!name) {
      const known = Object.keys(COMMANDS).filter((k) => k.startsWith(positionals[0]));
      throw usageErr(`Unknown command "${positionals.slice(0, 2).join(" ")}".${known.length ? ` Did you mean: ${known.join(", ")}?` : ""}\nRun "datadog --help".`);
    }
    if (v.help || positionals[0] === "help") {
      out(helpText(name));
      return 0;
    }
    const cmd = COMMANDS[name];
    const allowed = new Set([...cmd.opts, ...GLOBAL_OPTS]);
    const extra = Object.keys(v).filter((k) => !allowed.has(k));
    if (extra.length) throw usageErr(`Flag(s) not valid for "${name}": ${extra.map((k) => `--${k}`).join(", ")}.\nUsage: datadog ${cmd.usage}`);

    // Both checks run before any request: a bad DD_SITE or a non-loopback test base sends nothing.
    const creds = loadCreds(env);
    const base = testBase(env[TEST_BASE_ENV]);
    const client = new Client(creds, { base, dryRun: !!v["dry-run"], fetchImpl });
    const result = await cmd.run({ client, pos, v, env });

    if (v["dry-run"] && client.planned.length) {
      out(json ? JSON.stringify({ dryRun: true, intents: client.intents, requests: client.planned }) : dryRunText(client));
    } else {
      out(json ? JSON.stringify(result.data) : result.text);
    }
    return 0;
  } catch (e) {
    const status = e instanceof DatadogError ? e.status : undefined;
    const message = e?.message ?? String(e);
    err(json ? JSON.stringify({ error: message, status, code: e?.code }) : `Error: ${message}`);
    return e?.code === "usage" ? 2 : 1;
  }
}
