/**
 * Time parsing and compact text renderers. Text is the default output (token-cheap); --json
 * bypasses all rendering and prints the raw API response.
 */

/* ------------------------------------------------------------------ time */

export const REL = /^(?:now)?\s*-\s*(\d+)\s*([smhdw])$/i;
const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/**
 * Accepts "now", "now-15m", "-2h", "3d" / "3d ago" (implicitly ago), an ISO date, or epoch
 * seconds / millis / micros / nanos (by digit count). Returns a Date, or null when unparseable.
 */
export function parseTime(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return new Date();
  const rel = REL.exec(s) ?? /^(\d+)\s*([smhdw])(?:\s*ago)?$/i.exec(s);
  if (rel) return new Date(Date.now() - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()]);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    // ~10 digits = seconds, ~13 = millis, ~16 = micros, ~19 = nanos (APM spans report nanoseconds).
    if (s.length >= 18) return new Date(n / 1e6);
    if (s.length >= 15) return new Date(n / 1e3);
    return new Date(s.length >= 12 ? n : n * 1000);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Mute end time. A duration ("2h", "+2h", "-2h", "now+2h", "now-2h") means "for that long",
 * i.e. forward from now; anything else is an absolute time parsed by parseTime.
 */
export function parseEnd(input) {
  const s = String(input ?? "").trim();
  const dur = /^(?:now)?\s*[+-]?\s*(\d+)\s*([smhdw])$/i.exec(s);
  if (dur) return new Date(Date.now() + Number(dur[1]) * UNIT_MS[dur[2].toLowerCase()]);
  return parseTime(s);
}

export const iso = (d) => d.toISOString();
export const sec = (d) => Math.floor(d.getTime() / 1000);
export const ago = (ms) => new Date(Date.now() - ms);

/** Short stamp for log/event lines: "05-14 09:12:33Z" keeps rows narrow. */
export function stamp(v) {
  const d = v instanceof Date ? v : parseTime(typeof v === "number" ? String(v) : v);
  if (!d || Number.isNaN(d.getTime())) return "?";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z").slice(5);
}

export const trunc = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const fmtNum = (n) =>
  !Number.isFinite(n)
    ? String(n)
    : Math.abs(n) >= 1e4 || (Math.abs(n) < 1e-3 && n !== 0)
      ? n.toExponential(3)
      : Number(n.toFixed(4)).toString();

/* ------------------------------------------------------------------ links */

/** Parse a Datadog app URL. Returns null for anything that is not an http(s) URL on a Datadog host. */
export function parseAppUrl(s) {
  if (!/^https?:\/\//i.test(String(s ?? "").trim())) return null;
  let u;
  try {
    u = new URL(String(s).trim());
  } catch {
    return null;
  }
  if (!/(^|\.)(datadoghq\.com|datadoghq\.eu|ddog-gov\.com)$/.test(u.hostname)) return null;
  return u;
}

/** Monitor id from "123" or ".../monitors/123...". */
export function monitorIdFrom(ref) {
  const u = parseAppUrl(ref);
  const id = u ? /\/monitors\/(\d+)/.exec(u.pathname)?.[1] : String(ref ?? "").trim();
  return id && /^\d+$/.test(id) ? id : null;
}

/** Dashboard id from "abc-def-ghi" or ".../dashboard/abc-def-ghi/title". */
export function dashboardIdFrom(ref) {
  const u = parseAppUrl(ref);
  const id = u ? /\/dashboard\/([a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3})/i.exec(u.pathname)?.[1] : String(ref ?? "").trim();
  return id && /^[\w-]+$/.test(id) ? id : null;
}

/**
 * A logs/APM/events explorer link carries the query and window in its search params
 * (query=..., from_ts=<ms>, to_ts=<ms>). Returns {query, from, to} or null.
 */
export function explorerFromUrl(ref) {
  const u = parseAppUrl(ref);
  if (!u) return null;
  const p = u.searchParams;
  const trace = /\/apm\/trace\/([\w-]+)/.exec(u.pathname)?.[1];
  return {
    query: p.get("query") ?? (trace ? `trace_id:${trace}` : undefined),
    from: p.get("from_ts") ?? undefined,
    to: p.get("to_ts") ?? undefined,
  };
}

/* ------------------------------------------------------------------ renderers */

/**
 * Metric responses carry a full pointlist per series, often thousands of [ts,value] pairs.
 * Each series is reduced to shape statistics plus a coarse sparkline.
 */
export function summarizeSeries(s) {
  const pts = Array.isArray(s?.pointlist) ? s.pointlist : [];
  const vals = pts.map((p) => p?.[1]).filter((v) => typeof v === "number" && Number.isFinite(v));
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

export function logLine(d) {
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

/** Strip mustache conditionals ({{#is_alert}}...) from monitor names, for display only. */
export const cleanName = (n) =>
  String(n ?? "")
    .replace(/\{\{[#^/][^}]*\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim() || String(n ?? "");

export function monitorLine(m) {
  const states = m?.state?.group_states ?? m?.state?.groups;
  const alerting =
    states && typeof states === "object" ? Object.values(states).filter((g) => g?.status && g.status !== "OK").length : undefined;
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

export function eventLine(d) {
  const a = d.attributes ?? {};
  const at = a.attributes ?? {};
  return `${stamp(a.timestamp)} | ${trunc(at.status ?? at.alert_type ?? at.priority ?? "-", 8).padEnd(8)} | ${trunc(a.message ?? at.title ?? "", 180)}${
    at.service ? `  service=${at.service}` : ""
  }`;
}

/**
 * The spans payload nests differently from logs and has moved between API revisions: the
 * timestamp is start_timestamp (ISO or epoch-ns) and the duration lives under
 * attributes.duration or custom.duration, in NANOSECONDS.
 */
export function spanRows(data) {
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
  let unresolved = false;
  const rows = data.map((d) => {
    const a = d.attributes ?? {};
    const n = a.attributes ?? {};
    const ts = pick(a.start_timestamp, a.timestamp, n.start_timestamp, n.timestamp, n.start);
    const durNs = pick(a.duration, n.duration, a.custom?.duration, n.custom?.duration);
    if (ts === undefined || durNs === undefined) unresolved = true;
    const dur = durNs !== undefined && Number.isFinite(Number(durNs)) ? `${fmtNum(Number(durNs) / 1e6)}ms` : "?";
    const isErr = (n.status ?? a.status) === "error" || n["error.type"] !== undefined || a.custom?.error !== undefined;
    return `${stamp(ts)} | ${trunc(pick(a.service, n.service) ?? "-", 20).padEnd(20)} | ${dur.padStart(10)} | ${isErr ? "ERROR " : "      "}${trunc(
      pick(a.resource_name, n.resource_name, n.resource, n.operation_name) ?? "",
      120,
    )}`;
  });
  // Self-diagnosis instead of a silent row of "?": name the keys the API actually sent.
  const diag = unresolved
    ? `\n\nNOTE: some spans had no resolvable timestamp/duration. Keys present on the first span: ${Object.keys(data[0]?.attributes ?? {}).join(", ")} | nested: ${Object.keys(
        data[0]?.attributes?.attributes ?? {},
      )
        .slice(0, 25)
        .join(", ")}`
    : "";
  return { rows, diag };
}

/** A dashboard definition is huge JSON; report the queries it contains, not the layout. */
export function dashboardWidgetRows(widgets) {
  const rows = [];
  const walk = (ws, depth) => {
    for (const w of ws ?? []) {
      const def = w?.definition ?? {};
      if (Array.isArray(def.widgets)) {
        rows.push(`${"  ".repeat(depth)}▸ group: ${trunc(def.title, 70)}`);
        walk(def.widgets, depth + 1);
        continue;
      }
      const qs = (def.requests ?? [])
        .flatMap((rq) => [rq?.q, rq?.query, ...(rq?.queries ?? []).map((x) => x?.query ?? x?.q)])
        .filter(Boolean)
        .map((s) => trunc(s, 140));
      const pad = "  ".repeat(depth);
      rows.push(`${pad}• [${def.type ?? "?"}] ${trunc(def.title, 70) || "(untitled)"}${qs.length ? `\n${pad}    ${qs.join(`\n${pad}    `)}` : ""}`);
    }
  };
  walk(widgets ?? [], 0);
  return rows;
}

export function dryRunText(client) {
  const out = ["DRY RUN: nothing was sent."];
  for (const i of client.intents) out.push(`  ${i}`);
  out.push(client.planned.length === 1 ? "Request that would be sent:" : "Requests that would be sent:");
  for (const r of client.planned) {
    out.push(`  ${r.method} ${r.url}`);
    out.push(`  Headers: ${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    if (r.body !== undefined) out.push(`  Body: ${JSON.stringify(r.body)}`);
  }
  return out.join("\n");
}
