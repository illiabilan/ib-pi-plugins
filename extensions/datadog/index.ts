/**
 * Datadog extension for pi.
 *
 * Configuration comes ONLY from environment variables (never hardcoded).
 * Two auth schemes are supported; the tool picks one by inspecting the values.
 *
 *   Classic key pair:
 *     export DD_API_KEY="<32-hex api key>"          # Organization Settings > API Keys
 *     export DD_APP_KEY="ddapp_..."                 # Organization Settings > Application Keys
 *
 *   Token (Personal / Service Access Token, no API key needed):
 *     export DD_BEARER_TOKEN="ddpat_..."            # or ddsat_...
 *
 *   Site (default datadoghq.com = US1):
 *     export DD_SITE="datadoghq.com"                # datadoghq.eu | us3.datadoghq.com |
 *                                                   # us5.datadoghq.com | ap1.datadoghq.com | ddog-gov.com
 *
 * A ddpat_/ddsat_ token placed in DD_APP_KEY is also accepted (Datadog allows a token in the
 * dd-application-key header), so migrating from the key pair needs no config change here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SITE = "datadoghq.com";
const PROFILES = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc", ".profile"];

type Creds = {
  site: string;
  /** "pair" = DD-API-KEY + DD-APPLICATION-KEY, "bearer" = Authorization: Bearer <token>. */
  scheme: "pair" | "bearer";
  apiKey?: string;
  appKey?: string;
  token?: string;
  /** Provenance — "env" is normal, "shell-profile" means pi did not inherit the user's env. */
  source: "env" | "shell-profile";
};

/**
 * Datadog API hosts are api.<site>. Users almost always copy the *app* URL out of the
 * browser, so accept every shape of that and normalise: "https://app.datadoghq.eu/",
 * "app.datadoghq.eu", "api.datadoghq.eu", "datadoghq.eu" -> "datadoghq.eu".
 */
function normalizeSite(raw?: string): string {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return DEFAULT_SITE;
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^(app|api)\./, "");
  return s || DEFAULT_SITE;
}

const isToken = (v?: string) => !!v && /^dd(pat|sat)_/.test(v);

function buildCreds(
  apiKeyRaw: string | undefined,
  appKeyRaw: string | undefined,
  tokenRaw: string | undefined,
  siteRaw: string | undefined,
  source: Creds["source"],
): Creds | null {
  const apiKey = apiKeyRaw?.trim() || undefined;
  const appKey = appKeyRaw?.trim() || undefined;
  const site = normalizeSite(siteRaw);
  // An explicit bearer token wins; a ddpat_/ddsat_ value parked in DD_APP_KEY counts as one.
  const token = tokenRaw?.trim() || (isToken(appKey) ? appKey : undefined);
  if (token) return { site, scheme: "bearer", token, apiKey, source };
  if (apiKey && appKey) return { site, scheme: "pair", apiKey, appKey, source };
  return null;
}

let credsCache: Creds | null = null;
let credsPromise: Promise<Creds | { error: string; source: "none" }> | null = null;

const fromEnv = (): Creds | null =>
  buildCreds(
    process.env.DD_API_KEY ?? process.env.DATADOG_API_KEY,
    process.env.DD_APP_KEY ?? process.env.DD_APPLICATION_KEY ?? process.env.DATADOG_APP_KEY,
    process.env.DD_BEARER_TOKEN ?? process.env.DATADOG_BEARER_TOKEN,
    process.env.DD_SITE ?? process.env.DATADOG_SITE,
    "env",
  );

/** Fallback: pi may have been launched without a login shell (GUI launch, cron, CI). */
function fromLoginShell(): Promise<Creds | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    if (!PROFILES.some((p) => existsSync(join(homedir(), p)))) return resolve(null);
    execFile(
      shell,
      [
        "-l",
        "-i",
        "-c",
        'printf "%s\\n%s\\n%s\\n%s\\n" "$DD_API_KEY" "$DD_APP_KEY" "$DD_BEARER_TOKEN" "$DD_SITE"',
      ],
      { timeout: 10_000, env: { ...process.env, PI_DD_PROBE: "1" } },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        const [apiKey = "", appKey = "", token = "", site = ""] = stdout.split("\n").map((s) => s.trim());
        resolve(buildCreds(apiKey, appKey, token, site, "shell-profile"));
      },
    );
  });
}

const SETUP_HELP = `Datadog credentials are not configured.

Add ONE of these to your shell profile (~/.zshrc, ~/.zprofile, ~/.bashrc), then restart pi:

  # classic key pair
  export DD_API_KEY="<api key>"          # Organization Settings > API Keys
  export DD_APP_KEY="ddapp_..."          # Organization Settings > Application Keys

  # or a scoped token (no API key needed)
  export DD_BEARER_TOKEN="ddpat_..."     # Personal Access Token (ddsat_ service token also works)

  export DD_SITE="${DEFAULT_SITE}"          # datadoghq.eu | us3.datadoghq.com | us5.datadoghq.com |
                                         # ap1.datadoghq.com | ddog-gov.com — must match your browser URL

Scoped keys/tokens need at least: logs_read_data, logs_read_index_data, timeseries_query,
monitors_read, dashboards_read (plus apm_read for action=spans, events_read for action=events).`;

async function getCreds(): Promise<Creds | { error: string; source: "none" }> {
  if (credsCache) return credsCache;
  if (!credsPromise) {
    credsPromise = (async () => {
      const direct = fromEnv();
      if (direct) return (credsCache = direct);
      const shellCreds = await fromLoginShell();
      if (shellCreds) return (credsCache = shellCreds);
      credsPromise = null; // allow a retry once the user fixes their profile
      return { error: SETUP_HELP, source: "none" as const };
    })();
  }
  return credsPromise;
}

// ---------------------------------------------------------------------------- HTTP

type ApiResult = { ok: boolean; status: number; json: any; text: string };

async function api(
  creds: Creds,
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined>; signal?: AbortSignal } = {},
): Promise<ApiResult> {
  const url = new URL(`https://api.${creds.site}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (creds.scheme === "bearer") {
    headers.Authorization = `Bearer ${creds.token}`;
    // Harmless when present; some ingest-adjacent endpoints still want the org key.
    if (creds.apiKey) headers["DD-API-KEY"] = creds.apiKey;
  } else {
    headers["DD-API-KEY"] = creds.apiKey!;
    headers["DD-APPLICATION-KEY"] = creds.appKey!;
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (HTML/proxy error page) */
  }
  return { ok: res.ok, status: res.status, json, text };
}

function errText(r: ApiResult, creds: Creds): string {
  const parts: string[] = [`HTTP ${r.status}`];
  const errs = r.json?.errors;
  if (Array.isArray(errs))
    parts.push(...errs.map((e: any) => (typeof e === "string" ? e : e?.detail ?? e?.title ?? JSON.stringify(e))));
  else if (typeof errs === "string") parts.push(errs);
  if (parts.length === 1)
    parts.push(
      (r.text || "(empty response)").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) ||
        "(empty response)",
    );
  if (r.status === 401)
    parts.push(
      creds.scheme === "bearer"
        ? "Auth failed — DD_BEARER_TOKEN is invalid, revoked or expired (PATs expire; max 1 year)."
        : "Auth failed — DD_API_KEY/DD_APP_KEY invalid, or DD_SITE is wrong for this org.",
    );
  if (r.status === 403)
    // Datadog answers 403 both for "key is fine but unscoped" and for a REVOKED/invalid
    // application key (401 only covers a bad API key), so never claim the credential is valid.
    parts.push(
      creds.scheme === "bearer"
        ? "Forbidden — either DD_BEARER_TOKEN lacks the scope this endpoint needs, or the token was revoked/expired. Check with action=validate."
        : "Forbidden — either DD_APP_KEY lacks the scope this endpoint needs, or it was revoked/deleted (Datadog returns 403, not 401, for an invalid application key). Check with action=validate; if EVERY action returns 403, assume the app key is gone and create a new one.",
    );
  if (r.status === 404)
    parts.push(`Not found — check the id, and that DD_SITE=${creds.site} is the site holding this resource.`);
  if (r.status === 429) parts.push("Rate limited — wait and retry, or narrow the time window.");
  return `Datadog API error: ${parts.join(" | ")}`;
}

// ---------------------------------------------------------------------------- time

const REL = /^(?:now)?\s*-\s*(\d+)\s*([smhdw])$/i;
const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/**
 * Accepts "now", "now-15m", "-2h", "3d" (implicitly ago), an ISO date, epoch seconds or
 * epoch millis. Returns a Date, or null when unparseable.
 */
function parseTime(input: string | undefined): Date | null {
  if (input === undefined) return null;
  const s = input.trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return new Date();
  const rel = REL.exec(s) ?? /^(\d+)\s*([smhdw])(?:\s*ago)?$/i.exec(s);
  if (rel) return new Date(Date.now() - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()]);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    // Epoch precision by digit count: ~10 = seconds, ~13 = millis, ~16 = micros, ~19 = nanos
    // (APM spans report nanoseconds, so guessing millis there would land in the year 50000+).
    if (s.length >= 18) return new Date(n / 1e6);
    if (s.length >= 15) return new Date(n / 1e3);
    return new Date(s.length >= 12 ? n : n * 1000);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d: Date) => d.toISOString();
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const ago = (ms: number) => new Date(Date.now() - ms);

/** Short local-ish stamp for log/event lines: "05-14 09:12:33Z" keeps rows narrow. */
function stamp(v: any): string {
  const d = v instanceof Date ? v : parseTime(typeof v === "number" ? String(v) : v);
  if (!d) return "?";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z").slice(5);
}

const trunc = (s: any, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const fmtNum = (n: number) =>
  !Number.isFinite(n)
    ? String(n)
    : Math.abs(n) >= 1e4 || (Math.abs(n) < 1e-3 && n !== 0)
      ? n.toExponential(3)
      : Number(n.toFixed(4)).toString();

// ---------------------------------------------------------------------------- schema

const actionEnum = [
  "validate",
  "logs",
  "logs_aggregate",
  "metrics",
  "metric_search",
  "monitors",
  "monitor",
  "events",
  "spans",
  "dashboards",
  "dashboard",
  "slos",
  "hosts",
  "mute_monitor",
  "unmute_monitor",
  "post_event",
] as const;

const WRITE_ACTIONS = new Set(["mute_monitor", "unmute_monitor", "post_event"]);

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "Read: validate | logs | logs_aggregate | metrics | metric_search | monitors | monitor | events | spans | dashboards | dashboard | slos | hosts. Write (needs approval): mute_monitor | unmute_monitor | post_event.",
    },
  ),
  query: Type.Optional(
    Type.String({
      description:
        "The main query, syntax depends on action. logs/logs_aggregate/events: log search syntax ('service:checkout status:error -/health'). metrics: a metric query ('avg:trace.http.request.duration{service:checkout}by{resource_name}'). spans: APM search ('service:checkout status:error'). monitors: monitor search ('status:alert muted:false tag:team:core'). metric_search/dashboards/hosts/slos: a substring filter.",
    }),
  ),
  from: Type.Optional(
    Type.String({
      description:
        "Window start: 'now-15m', '-2h', '3d', an ISO timestamp or epoch. Defaults: logs/spans/events 15m ago, metrics 1h ago.",
    }),
  ),
  to: Type.Optional(Type.String({ description: "Window end (default: now)." })),
  limit: Type.Optional(Type.Number({ description: "Max rows returned (default 25, max 200)." })),
  id: Type.Optional(
    Type.String({ description: "Resource id: monitor id (monitor/mute_monitor/unmute_monitor) or dashboard id (dashboard)." }),
  ),
  indexes: Type.Optional(
    Type.String({ description: "Comma-separated log indexes for logs/logs_aggregate (default: all readable indexes)." }),
  ),
  group_by: Type.Optional(
    Type.String({
      description:
        "For logs_aggregate: comma-separated facets to group by, e.g. 'service,status'. Omit for a single total count.",
    }),
  ),
  end: Type.Optional(
    Type.String({ description: "For mute_monitor: when the mute expires ('now-...' makes no sense; use '2h', ISO or epoch). Omit = mute indefinitely." }),
  ),
  scope: Type.Optional(Type.String({ description: "For mute_monitor: restrict the mute to a scope, e.g. 'host:web-01'." })),
  title: Type.Optional(Type.String({ description: "For post_event: the event title." })),
  text: Type.Optional(Type.String({ description: "For post_event: the event body (supports Datadog markdown)." })),
  tags: Type.Optional(Type.String({ description: "For post_event: comma-separated tags, e.g. 'env:prod,team:core'." })),
  alert_type: Type.Optional(
    Type.String({ description: "For post_event: info (default) | warning | error | success." }),
  ),
  confirm_token: Type.Optional(
    Type.String({
      description:
        "Approval token from a previous preview of the SAME write payload (non-interactive sessions only). Only pass it after the user explicitly approved that preview; any change to the payload voids it.",
    }),
  ),
});

export type DatadogToolInput = Static<typeof schema>;

// ---------------------------------------------------------------------- write approval

/**
 * Non-interactive sessions (subagents, `--mode json`, CI) have no dialog, so a write must not
 * simply execute: the tool returns a preview plus a single-use token bound to a hash of the
 * exact payload, and only the identical call carrying that token proceeds. The salt is
 * per-process, so a token can neither be guessed nor replayed in another session.
 */
const TOKEN_SALT = randomBytes(16).toString("hex");
const issuedTokens = new Set<string>();

const writePayload = (p: DatadogToolInput) =>
  JSON.stringify({
    action: p.action,
    id: p.id,
    scope: p.scope,
    end: p.end,
    title: p.title,
    text: p.text,
    tags: p.tags,
    alert_type: p.alert_type,
  });

const tokenFor = (p: DatadogToolInput) =>
  `dd-${createHash("sha256").update(`${TOKEN_SALT}:${writePayload(p)}`).digest("hex").slice(0, 12)}`;

// ---------------------------------------------------------------------------- formatting

/**
 * Metric responses carry a full pointlist per series — often thousands of [ts,value] pairs.
 * Dumping those would blow the context budget for zero benefit, so each series is reduced to
 * shape statistics plus a coarse sparkline.
 */
function summarizeSeries(s: any): string {
  const pts: [number, number | null][] = Array.isArray(s?.pointlist) ? s.pointlist : [];
  const vals = pts.map((p) => p?.[1]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const head = `  ${s?.scope ?? s?.expression ?? "(no scope)"}`;
  if (!vals.length) return `${head}\n    no data points in window`;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const last = vals[vals.length - 1];
  const bars = "▁▂▃▄▅▆▇█";
  const step = Math.max(1, Math.ceil(vals.length / 24));
  const spark = vals
    .filter((_, i) => i % step === 0)
    .map((v) => bars[max === min ? 0 : Math.min(7, Math.floor(((v - min) / (max - min)) * 7.999))])
    .join("");
  return `${head}\n    min ${fmtNum(min)}  avg ${fmtNum(avg)}  max ${fmtNum(max)}  last ${fmtNum(last)}  (${vals.length} pts)\n    ${spark}`;
}

function logLine(d: any): string {
  const a = d?.attributes ?? {};
  const nested = a.attributes ?? {};
  const msg = a.message ?? nested.message ?? nested.msg ?? "";
  const bits = [
    stamp(a.timestamp),
    (a.status ?? nested.status ?? "?").toString().toUpperCase().slice(0, 5).padEnd(5),
    trunc(a.service ?? nested.service ?? "-", 24),
  ];
  const extra = a.host ? ` host=${trunc(a.host, 28)}` : "";
  return `${bits.join(" | ")} ${trunc(msg, 220)}${extra}`;
}

/**
 * Auto-generated monitor names are usually prefixed with a mustache conditional
 * ({{#is_alert}}...), which eats the readable part of the line. Strip the template
 * scaffolding for display only.
 */
const cleanName = (n: any) =>
  String(n ?? "")
    .replace(/\{\{[#^/][^}]*\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim() || String(n ?? "");

function monitorLine(m: any): string {
  const states = m?.state?.group_states ?? m?.state?.groups;
  const alerting =
    states && typeof states === "object"
      ? Object.values(states).filter((g: any) => g?.status && g.status !== "OK").length
      : undefined;
  return [
    `[${m?.id}] ${trunc(cleanName(m?.name), 90)}`,
    `  status: ${m?.overall_state ?? m?.status ?? "?"}${m?.options?.silenced && Object.keys(m.options.silenced).length ? " (MUTED)" : ""}${
      alerting ? `  groups_not_ok: ${alerting}` : ""
    }`,
    m?.type ? `  type: ${m.type}` : null,
    m?.tags?.length ? `  tags: ${m.tags.slice(0, 8).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "datadog",
    label: "Datadog",
    // Dialogs in execute() must not run in parallel: pi batches tool calls and the TUI has a
    // single dialog slot, so a second concurrent confirm would deadlock the turn.
    executionMode: "sequential",
    description: `Query Datadog over its REST API: logs, metrics, monitors, APM spans, events, dashboards, SLOs, hosts (credentials from DD_API_KEY+DD_APP_KEY, or DD_BEARER_TOKEN, plus DD_SITE).

Read actions (run immediately):
  validate                       — check credentials/site and report which auth scheme is in use
  logs {query, from, to, limit}   — search log events, newest first
  logs_aggregate {query, group_by}— counts instead of raw lines: "how many errors per service"
  metrics {query, from, to}       — timeseries; each series is reduced to min/avg/max/last + sparkline, never raw points
  metric_search {query}           — find metric names before querying them
  monitors {query}                — monitor search, e.g. query "status:alert muted:false"
  monitor {id}                    — one monitor with its query, message and per-group states
  events {query, from, to}        — the event stream (deploys, alerts)
  spans {query, from, to}         — APM spans with duration and status
  dashboards {query} / dashboard {id} — list dashboards / show one dashboard's widget inventory
  slos {query} / hosts {query}    — SLO definitions / reporting hosts

Write actions (mute_monitor, unmute_monitor, post_event) change state visible to the whole org and are never auto-run: interactive sessions get a confirm dialog on the call itself; non-interactive ones get back "PREVIEW ONLY" plus a one-time confirm_token to relay, which is then passed back in an identical call after the user approves.

Time windows accept 'now-15m', '-2h', '3d', ISO timestamps or epoch values.
Examples:
  {"action":"logs","query":"service:checkout status:error","from":"-1h","limit":30}
  {"action":"logs_aggregate","query":"status:error","from":"-24h","group_by":"service"}
  {"action":"metrics","query":"avg:system.cpu.user{env:prod} by {host}","from":"-4h"}
  {"action":"monitors","query":"status:alert"}

Every result ends with a "config_source:" marker: "env" means credentials came from the process environment (normal); "shell-profile" means they were recovered by probing a login shell, so pi did not inherit the user's env.`,
    promptSnippet: "Query Datadog logs, metrics, monitors, APM spans, events and dashboards",
    promptGuidelines: [
      "Use datadog for anything observability-related (production errors, latency, alert state, deploy events, host health) instead of curl/ddapi in bash — it handles auth, site routing and time parsing itself.",
      "When investigating an incident with datadog, start with {action:'logs_aggregate', group_by:'service'} or {action:'monitors', query:'status:alert'} to find WHERE the problem is, then drill into {action:'logs'} or {action:'spans'} for individual events — pulling raw log lines first wastes context.",
      "Never guess metric names for datadog action='metrics': call {action:'metric_search', query:'<substring>'} first, because a wrong metric name returns an empty series that looks exactly like a healthy one.",
      "datadog actions mute_monitor, unmute_monitor and post_event change state the whole org sees: call the action once with full parameters and let the tool present it for approval — do not ask for permission in prose first, and never retry a declined write.",
      "When a datadog write returns 'PREVIEW ONLY', nothing was sent: relay the preview verbatim, end the turn, and only repeat the identical call with confirm_token after the user replies approving it. Never pass confirm_token in the same turn as the preview that issued it, and never invent or reuse one.",
      "Keep datadog time windows as narrow as the question allows (from:'-15m' for a live incident, '-24h' for a trend); a wide window on a busy service is slower, rate-limit-prone and truncated anyway.",
      "If datadog returns HTTP 403, the key or token is valid but missing a scope (e.g. logs_read_data, timeseries_query, apm_read) — tell the user which scope to add instead of retrying; on HTTP 401 the credential is invalid/expired, and on 404 check DD_SITE matches the org.",
      "If a datadog result reports config_source: shell-profile, note that pi did not inherit the DD_* env vars and the user should restart pi from a shell where their profile is loaded.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // ---- approval gate for writes, before any network call
      if (WRITE_ACTIONS.has(params.action)) {
        const preview =
          params.action === "post_event"
            ? `title: ${params.title ?? "(missing)"}\ntags: ${params.tags ?? "(none)"}\ntype: ${params.alert_type ?? "info"}\n\n${trunc(params.text, 500) || "(no body)"}`
            : `monitor: ${params.id ?? "(missing)"}${params.scope ? `\nscope: ${params.scope}` : ""}${
                params.action === "mute_monitor" ? `\nuntil: ${params.end ?? "indefinitely"}` : ""
              }`;
        const declined = {
          content: [
            {
              type: "text" as const,
              text: `User declined the datadog ${params.action}. Nothing was changed. Ask what to adjust instead of retrying.`,
            },
          ],
          details: { action: params.action, declined: true },
          isError: true,
        };

        if (ctx.hasUI) {
          if (!(await ctx.ui.confirm(`Datadog ${params.action}`, preview))) return declined;
        } else {
          const expected = tokenFor(params);
          if (params.confirm_token !== expected || !issuedTokens.has(expected)) {
            issuedTokens.add(expected);
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `PREVIEW ONLY — nothing was sent to Datadog.`,
                    `This session is non-interactive, so this org-visible write needs explicit user approval.`,
                    ``,
                    `datadog ${params.action}`,
                    preview,
                    ``,
                    params.confirm_token
                      ? `The supplied confirm_token does not match this payload (it changed, or came from another session). A fresh token is issued below.`
                      : ``,
                    `Relay this preview to the user. Once THEY approve it, repeat the identical call with confirm_token: "${expected}"`,
                    `Never pass the token in the same turn as the preview that produced it, and never invent one.`,
                  ]
                    .filter((l) => l !== "")
                    .join("\n"),
                },
              ],
              details: { action: params.action, previewPending: true, confirmToken: expected },
            };
          }
          issuedTokens.delete(expected); // single use
        }
      }

      const creds = await getCreds();
      if ("error" in creds)
        return {
          content: [{ type: "text", text: `${creds.error}\n\nconfig_source: none` }],
          details: { action: params.action, configSource: "none" },
          isError: true,
        };

      const fin = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text: `${text}\n\nconfig_source: ${creds.source}` }],
        details: { action: params.action, configSource: creds.source, site: creds.site, isError },
        isError,
      });
      const bad = (msg: string) => fin(`Error: ${msg}`, true);
      const limit = Math.max(1, Math.min(params.limit ?? 25, 200));

      // Window resolution: a bad time string must fail loudly, not silently become "now".
      const winFrom = (defaultMs: number): Date | { err: string } => {
        if (params.from === undefined) return ago(defaultMs);
        const d = parseTime(params.from);
        return d ?? { err: `Could not parse from='${params.from}'. Use 'now-15m', '-2h', '3d', an ISO timestamp or epoch.` };
      };
      const winTo = (): Date | { err: string } => {
        if (params.to === undefined) return new Date();
        const d = parseTime(params.to);
        return d ?? { err: `Could not parse to='${params.to}'. Use 'now', an ISO timestamp or epoch.` };
      };

      try {
        switch (params.action) {
          case "validate": {
            // /api/v1/validate only checks the API key, so also hit an app-key/scope-gated
            // endpoint — a pair where only the API key is valid must not report "OK".
            const scopeProbe = await api(creds, "/api/v1/monitor", { query: { page_size: 1 }, signal });
            const who = await api(creds, "/api/v2/current_user", { signal });
            const lines = [
              `Site:   api.${creds.site}`,
              `Scheme: ${creds.scheme === "bearer" ? "Bearer token (ddpat_/ddsat_)" : "DD-API-KEY + DD-APPLICATION-KEY"}`,
            ];
            if (who.ok) {
              const a = who.json?.data?.attributes ?? {};
              if (a.name || a.email) lines.push(`User:   ${a.name ?? "?"} <${a.email ?? "?"}>`);
            }
            if (!scopeProbe.ok)
              return fin(
                [
                  ...lines,
                  "",
                  `Credentials NOT working for read queries.`,
                  errText(scopeProbe, creds),
                  who.ok
                    ? `The API key itself is accepted (current_user succeeded), so the problem is the ${creds.scheme === "bearer" ? "token" : "APPLICATION key"}: it is revoked, deleted or unscoped.`
                    : `Neither the monitor read nor current_user succeeded, so both credentials are suspect — or DD_SITE=${creds.site} is the wrong site for this org.`,
                ].join("\n"),
                true,
              );
            lines.push("Status: OK — authenticated and able to read monitors.");
            if (!who.ok)
              lines.push(
                `Note:   /api/v2/current_user returned HTTP ${who.status} (normal for service tokens and narrowly scoped keys).`,
              );
            return fin(lines.join("\n"));
          }

          case "logs": {
            const f = winFrom(15 * 6e4);
            const t = winTo();
            if ("err" in f) return bad(f.err);
            if ("err" in t) return bad(t.err);
            const body: any = {
              filter: { from: iso(f), to: iso(t), query: params.query ?? "*" },
              page: { limit },
              sort: "-timestamp",
            };
            if (params.indexes) body.filter.indexes = params.indexes.split(",").map((s) => s.trim()).filter(Boolean);
            const r = await api(creds, "/api/v2/logs/events/search", { method: "POST", body, signal });
            if (!r.ok) return fin(errText(r, creds), true);
            const data = r.json?.data ?? [];
            const head = `Logs "${params.query ?? "*"}"  ${iso(f)} → ${iso(t)}`;
            if (!data.length)
              return fin(
                `${head}\n\nNo matching log events. Check the query syntax (facets are case-sensitive, e.g. service:checkout), widen the window, or verify the index is readable by this key.`,
              );
            const more = r.json?.meta?.page?.after ? "\n(more results available — narrow the query or raise limit)" : "";
            return fin(`${head}\n${data.length} events, newest first:\n\n${data.map(logLine).join("\n")}${more}`);
          }

          case "logs_aggregate": {
            const f = winFrom(60 * 6e4);
            const t = winTo();
            if ("err" in f) return bad(f.err);
            if ("err" in t) return bad(t.err);
            const facets = (params.group_by ?? "").split(",").map((s) => s.trim()).filter(Boolean);
            const body: any = {
              filter: { from: iso(f), to: iso(t), query: params.query ?? "*" },
              compute: [{ aggregation: "count", type: "total" }],
              // No `sort` here: the API rejects an aggregation sort on a group_by unless it
              // also carries type:"measure", and buckets are sorted client-side below anyway.
              group_by: facets.map((facet) => ({ facet, limit: Math.min(limit, 50) })),
            };
            if (params.indexes) body.filter.indexes = params.indexes.split(",").map((s) => s.trim()).filter(Boolean);
            const r = await api(creds, "/api/v2/logs/analytics/aggregate", { method: "POST", body, signal });
            if (!r.ok) return fin(errText(r, creds), true);
            const buckets = r.json?.data?.buckets ?? [];
            const head = `Log counts "${params.query ?? "*"}"  ${iso(f)} → ${iso(t)}${facets.length ? `  by ${facets.join(", ")}` : ""}`;
            if (!buckets.length) return fin(`${head}\n\nNo matching log events in this window.`);
            const rows = buckets
              .map((b: any) => {
                const key = facets.length ? facets.map((k) => `${k}=${b.by?.[k] ?? "-"}`).join(" ") : "total";
                const c = b.computes?.c0 ?? b.computes?.["c0"] ?? Object.values(b.computes ?? {})[0];
                return { key, c: Number(c ?? 0) };
              })
              .sort((a: any, b: any) => b.c - a.c);
            const total = rows.reduce((a: number, r2: any) => a + r2.c, 0);
            return fin(
              `${head}\ntotal ${total} across ${rows.length} group(s):\n\n${rows.map((r2: any) => `  ${String(r2.c).padStart(9)}  ${r2.key}`).join("\n")}`,
            );
          }

          case "metrics": {
            if (!params.query?.trim())
              return bad(
                "query is required for action=metrics, e.g. 'avg:system.cpu.user{env:prod} by {host}'. Use action=metric_search to find metric names.",
              );
            const f = winFrom(60 * 6e4);
            const t = winTo();
            if ("err" in f) return bad(f.err);
            if ("err" in t) return bad(t.err);
            const r = await api(creds, "/api/v1/query", {
              query: { from: sec(f), to: sec(t), query: params.query },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            if (r.json?.status === "error" || r.json?.error)
              return fin(`Query rejected by Datadog: ${r.json.error ?? r.json.status}`, true);
            const series = r.json?.series ?? [];
            const head = `Metric "${params.query}"  ${iso(f)} → ${iso(t)}`;
            if (!series.length)
              return fin(
                `${head}\n\nNo series returned. Either the metric name does not exist (verify with action=metric_search), the tag filter matches nothing, or the metric reported no data in this window.`,
              );
            const shown = series.slice(0, Math.min(limit, 40));
            const note = series.length > shown.length ? `\n(${series.length - shown.length} more series not shown)` : "";
            return fin(
              `${head}\n${series.length} series${r.json?.unit?.[0]?.short_name ? `, unit ${r.json.unit[0].short_name}` : ""}:\n\n${shown
                .map(summarizeSeries)
                .join("\n")}${note}`,
            );
          }

          case "metric_search": {
            if (!params.query?.trim()) return bad("query is required for action=metric_search, e.g. 'trace.http'.");
            const r = await api(creds, "/api/v1/search", { query: { q: `metrics:${params.query}` }, signal });
            if (!r.ok) return fin(errText(r, creds), true);
            const metrics = r.json?.results?.metrics ?? [];
            if (!metrics.length)
              return fin(`No metric name contains "${params.query}". Metric names are case-sensitive and dot-separated (e.g. trace.http.request.duration).`);
            const shown = metrics.slice(0, Math.min(limit * 4, 200));
            return fin(
              `Metrics matching "${params.query}" (${shown.length} of ${metrics.length}):\n${shown.map((m: string) => `  ${m}`).join("\n")}`,
            );
          }

          case "monitors": {
            const r = await api(creds, "/api/v1/monitor/search", {
              query: { query: params.query ?? "", per_page: limit },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const monitors = r.json?.monitors ?? [];
            const total = r.json?.metadata?.total_count ?? monitors.length;
            const head = `Monitors${params.query ? ` matching "${params.query}"` : ""} (${monitors.length} of ${total})`;
            if (!monitors.length)
              return fin(
                `${head}\n\nNothing matched. Monitor search syntax: 'status:alert', 'muted:false', 'tag:team:core', 'type:metric alert', or free text on the name.`,
              );
            // An unfiltered search on a big org returns an arbitrary slice of tens of thousands
            // of monitors, which is rarely what the caller actually wanted.
            const hint =
              !params.query && total > monitors.length
                ? `\nNOTE: unfiltered — this is an arbitrary ${monitors.length} of ${total} monitors. Pass query:'status:alert', 'muted:false' or 'tag:service:<name>' to get a meaningful set.`
                : "";
            const counts = new Map<string, number>();
            for (const m of monitors) counts.set(m.status ?? "?", (counts.get(m.status ?? "?") ?? 0) + 1);
            return fin(
              `${head}\nby status: ${[...counts].map(([k, v]) => `${k}=${v}`).join(" ")}${hint}\n\n${monitors.map(monitorLine).join("\n")}`,
            );
          }

          case "monitor": {
            if (!params.id) return bad("id is required for action=monitor (numeric monitor id).");
            const r = await api(creds, `/api/v1/monitor/${encodeURIComponent(params.id)}`, {
              query: { group_states: "all" },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const m = r.json ?? {};
            const groups = Object.entries(m.state?.group_states ?? {}) as [string, any][];
            const notOk = groups.filter(([, g]) => g?.status && g.status !== "OK");
            const silenced = m.options?.silenced ?? {};
            return fin(
              [
                `Monitor: [${m.id}] ${cleanName(m.name)}`,
                `URL:     https://app.${creds.site}/monitors/${m.id}`,
                `Status:  ${m.overall_state ?? "?"}${Object.keys(silenced).length ? `  (MUTED: ${JSON.stringify(silenced)})` : ""}`,
                `Type:    ${m.type ?? "?"}`,
                `Query:   ${m.query ?? "?"}`,
                m.options?.thresholds ? `Thresh:  ${JSON.stringify(m.options.thresholds)}` : null,
                m.tags?.length ? `Tags:    ${m.tags.join(", ")}` : null,
                `Modified:${stamp(m.modified)}`,
                groups.length ? `\nGroups: ${groups.length} total, ${notOk.length} not OK` : null,
                ...notOk
                  .slice(0, Math.min(limit, 40))
                  .map(([name, g]) => `  ${g.status}  ${trunc(name, 80)}  since ${stamp(g.last_triggered_ts)}`),
                m.message ? `\nMessage:\n${trunc(m.message, 1200)}` : null,
              ]
                .filter((l) => l !== null)
                .join("\n"),
            );
          }

          case "events": {
            const f = winFrom(15 * 6e4);
            const t = winTo();
            if ("err" in f) return bad(f.err);
            if ("err" in t) return bad(t.err);
            const r = await api(creds, "/api/v2/events", {
              query: {
                "filter[query]": params.query ?? "",
                "filter[from]": iso(f),
                "filter[to]": iso(t),
                "page[limit]": limit,
                sort: "-timestamp",
              },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const data = r.json?.data ?? [];
            const head = `Events${params.query ? ` "${params.query}"` : ""}  ${iso(f)} → ${iso(t)}`;
            if (!data.length) return fin(`${head}\n\nNo events in this window.`);
            return fin(
              `${head}\n${data.length} events, newest first:\n\n${data
                .map((d: any) => {
                  const a = d.attributes ?? {};
                  const at = a.attributes ?? {};
                  return `${stamp(a.timestamp)} | ${trunc(at.status ?? at.alert_type ?? at.priority ?? "-", 8).padEnd(8)} | ${trunc(a.message ?? at.title ?? "", 180)}${
                    at.service ? `  service=${at.service}` : ""
                  }`;
                })
                .join("\n")}`,
            );
          }

          case "spans": {
            const f = winFrom(15 * 6e4);
            const t = winTo();
            if ("err" in f) return bad(f.err);
            if ("err" in t) return bad(t.err);
            const r = await api(creds, "/api/v2/spans/events/search", {
              method: "POST",
              body: {
                data: {
                  type: "search_request",
                  attributes: {
                    filter: { from: iso(f), to: iso(t), query: params.query ?? "*" },
                    page: { limit },
                    sort: "-timestamp",
                  },
                },
              },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const data = r.json?.data ?? [];
            const head = `APM spans "${params.query ?? "*"}"  ${iso(f)} → ${iso(t)}`;
            if (!data.length)
              return fin(`${head}\n\nNo spans matched. APM search uses facets like service:, resource_name:, operation_name:, status:error, @http.status_code:500.`);
            // The spans payload nests differently from logs and has moved between API
            // revisions: the timestamp is start_timestamp (ISO or epoch-ns) and the duration
            // lives under attributes.duration or custom.duration, in NANOSECONDS.
            const pick = (...vals: any[]) => vals.find((v) => v !== undefined && v !== null && v !== "");
            let unresolved = false;
            const rows = data.map((d: any) => {
              const a = d.attributes ?? {};
              const n = a.attributes ?? {};
              const ts = pick(a.start_timestamp, a.timestamp, n.start_timestamp, n.timestamp, n.start);
              const durNs = pick(a.duration, n.duration, a.custom?.duration, n.custom?.duration);
              if (ts === undefined || durNs === undefined) unresolved = true;
              const dur = Number.isFinite(Number(durNs)) ? `${fmtNum(Number(durNs) / 1e6)}ms` : "?";
              const isErr =
                (n.status ?? a.status) === "error" || n["error.type"] !== undefined || a.custom?.error !== undefined;
              return `${stamp(ts)} | ${trunc(pick(a.service, n.service) ?? "-", 20).padEnd(20)} | ${dur.padStart(10)} | ${
                isErr ? "ERROR " : "      "
              }${trunc(pick(a.resource_name, n.resource_name, n.resource, n.operation_name) ?? "", 120)}`;
            });
            // Self-diagnosis instead of a silent row of "?": name the keys the API actually sent.
            const diag = unresolved
              ? `\n\nNOTE: some spans had no resolvable timestamp/duration. Keys present on the first span: ${Object.keys(
                  data[0]?.attributes ?? {},
                ).join(", ")} | nested: ${Object.keys(data[0]?.attributes?.attributes ?? {}).slice(0, 25).join(", ")}`
              : "";
            return fin(`${head}\n${data.length} spans, newest first:\n\n${rows.join("\n")}${diag}`);
          }

          case "dashboards": {
            const r = await api(creds, "/api/v1/dashboard", { signal });
            if (!r.ok) return fin(errText(r, creds), true);
            const all = r.json?.dashboards ?? [];
            const q = params.query?.trim().toLowerCase();
            const list = q
              ? all.filter((d: any) => `${d.title ?? ""} ${d.description ?? ""}`.toLowerCase().includes(q))
              : all;
            if (!list.length)
              return fin(q ? `No dashboard title/description contains "${params.query}" (${all.length} visible).` : "No dashboards visible.");
            const shown = list.slice(0, Math.min(limit * 2, 100));
            return fin(
              `Dashboards (${shown.length} of ${list.length}${q ? ` matching "${params.query}"` : ""}):\n${shown
                .map((d: any) => `  ${d.id}  ${trunc(d.title, 80)}${d.is_read_only ? " [ro]" : ""}`)
                .join("\n")}\n\nUse {"action":"dashboard","id":"<id>"} for a widget inventory.`,
            );
          }

          case "dashboard": {
            if (!params.id) return bad("id is required for action=dashboard (see action=dashboards).");
            const r = await api(creds, `/api/v1/dashboard/${encodeURIComponent(params.id)}`, { signal });
            if (!r.ok) return fin(errText(r, creds), true);
            const d = r.json ?? {};
            // A dashboard definition is huge JSON; report the queries it contains, not the layout.
            const rows: string[] = [];
            const walk = (widgets: any[], depth: number) => {
              for (const w of widgets ?? []) {
                const def = w?.definition ?? {};
                if (Array.isArray(def.widgets)) {
                  rows.push(`${"  ".repeat(depth)}▸ group: ${trunc(def.title, 70)}`);
                  walk(def.widgets, depth + 1);
                  continue;
                }
                const qs = (def.requests ?? [])
                  .flatMap((rq: any) => [rq?.q, rq?.query, ...(rq?.queries ?? []).map((x: any) => x?.query ?? x?.q)])
                  .filter(Boolean)
                  .map((s: any) => trunc(s, 140));
                rows.push(
                  `${"  ".repeat(depth)}• [${def.type ?? "?"}] ${trunc(def.title, 70) || "(untitled)"}${
                    qs.length ? `\n${"  ".repeat(depth)}    ${qs.join(`\n${"  ".repeat(depth)}    `)}` : ""
                  }`,
                );
              }
            };
            walk(d.widgets ?? [], 0);
            const capped = rows.slice(0, Math.min(limit * 3, 150));
            return fin(
              [
                `Dashboard: ${d.title ?? "?"} (${d.id ?? params.id})`,
                `URL:       https://app.${creds.site}/dashboard/${d.id ?? params.id}`,
                d.description ? `Desc:      ${trunc(d.description, 300)}` : null,
                d.template_variables?.length
                  ? `Vars:      ${d.template_variables.map((v: any) => `$${v.name}=${v.default ?? "*"}`).join(" ")}`
                  : null,
                `\nWidgets (${rows.length}${capped.length < rows.length ? `, ${capped.length} shown` : ""}):`,
                ...capped,
              ]
                .filter((l) => l !== null)
                .join("\n"),
            );
          }

          case "slos": {
            const r = await api(creds, "/api/v1/slo", {
              query: { limit: Math.min(limit, 100), query: params.query },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const data = r.json?.data ?? [];
            if (!data.length) return fin(params.query ? `No SLO matched "${params.query}".` : "No SLOs defined.");
            return fin(
              `SLOs (${data.length}):\n${data
                .map(
                  (s: any) =>
                    `  ${s.id}  ${trunc(s.name, 70)}  type=${s.type ?? "?"}  targets=${(s.thresholds ?? [])
                      .map((t: any) => `${t.target}%/${t.timeframe}`)
                      .join(",")}`,
                )
                .join("\n")}`,
            );
          }

          case "hosts": {
            const r = await api(creds, "/api/v1/hosts", {
              query: { filter: params.query, count: Math.min(limit, 100), sort_field: "status" },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const list = r.json?.host_list ?? [];
            const total = r.json?.total_matching ?? list.length;
            if (!list.length) return fin(params.query ? `No host matched "${params.query}".` : "No hosts reporting.");
            return fin(
              `Hosts (${list.length} of ${total}${params.query ? ` matching "${params.query}"` : ""}):\n${list
                .map(
                  (h: any) =>
                    `  ${h.up ? "UP  " : "DOWN"} ${trunc(h.host_name ?? h.name, 44).padEnd(44)} ${trunc(
                      (h.tags_by_source?.Datadog ?? []).slice(0, 4).join(","),
                      60,
                    )}`,
                )
                .join("\n")}`,
            );
          }

          case "mute_monitor": {
            if (!params.id) return bad("id is required for action=mute_monitor.");
            const body: any = {};
            if (params.scope) body.scope = params.scope;
            if (params.end) {
              const e = parseTime(params.end);
              if (!e) return bad(`Could not parse end='${params.end}'. Use '2h', an ISO timestamp or epoch seconds.`);
              // A relative value means "for that long", i.e. forward from now.
              const forward = REL.test(params.end) ? new Date(Date.now() + (Date.now() - e.getTime())) : e;
              if (forward.getTime() <= Date.now())
                return bad(`end='${params.end}' resolves to the past (${iso(forward)}); the mute would expire immediately.`);
              body.end = sec(forward);
            }
            const r = await api(creds, `/api/v1/monitor/${encodeURIComponent(params.id)}/mute`, {
              method: "POST",
              body,
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            return fin(
              `Muted monitor [${r.json?.id ?? params.id}] ${r.json?.name ?? ""}${body.end ? ` until ${iso(new Date(body.end * 1000))}` : " indefinitely"}${
                params.scope ? ` for scope ${params.scope}` : ""
              }\nURL: https://app.${creds.site}/monitors/${params.id}`,
            );
          }

          case "unmute_monitor": {
            if (!params.id) return bad("id is required for action=unmute_monitor.");
            const r = await api(creds, `/api/v1/monitor/${encodeURIComponent(params.id)}/unmute`, {
              method: "POST",
              body: params.scope ? { scope: params.scope } : {},
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            return fin(`Unmuted monitor [${r.json?.id ?? params.id}] ${r.json?.name ?? ""}`);
          }

          case "post_event": {
            if (!params.title?.trim()) return bad("title is required for action=post_event.");
            const r = await api(creds, "/api/v1/events", {
              method: "POST",
              body: {
                title: params.title,
                text: params.text ?? params.title,
                tags: (params.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
                alert_type: params.alert_type ?? "info",
              },
              signal,
            });
            if (!r.ok) return fin(errText(r, creds), true);
            const id = r.json?.event?.id ?? r.json?.id;
            return fin(`Posted event${id ? ` id=${id}` : ""}: ${params.title}${id ? `\nURL: https://app.${creds.site}/event/event?id=${id}` : ""}`);
          }

          default:
            return bad(`Unknown action '${(params as any).action}'. Valid: ${actionEnum.join(", ")}`);
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return fin("Cancelled.", true);
        return fin(
          `Request failed: ${e?.message ?? String(e)} (check network access and DD_SITE=${creds.site} — the API host is api.${creds.site})`,
          true,
        );
      }
    },
    renderCall(args: DatadogToolInput, theme) {
      const bits = [
        args.id,
        args.query && `"${trunc(args.query, 60)}"`,
        args.group_by && `by ${args.group_by}`,
        (args.from || args.to) && `${args.from ?? "-15m"}→${args.to ?? "now"}`,
        args.title && `"${trunc(args.title, 40)}"`,
      ].filter(Boolean);
      return new Text(
        `${theme.fg("accent", "datadog")} ${theme.bold(args.action)}${bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""}`,
        0,
        0,
      );
    },
  });
}
