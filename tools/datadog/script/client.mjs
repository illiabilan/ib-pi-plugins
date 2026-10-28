/**
 * Minimal Datadog REST client (fetch only, no dependencies).
 *
 * Credentials come only from the environment. Two auth schemes:
 *   pair:   DD-API-KEY + DD-APPLICATION-KEY headers   (DD_API_KEY + DD_APP_KEY)
 *   bearer: Authorization: Bearer <token>              (DD_BEARER_TOKEN, or a ddpat_/ddsat_ value in DD_APP_KEY)
 *
 * The request host is api.<DD_SITE>, and credentials travel in the headers, so DD_SITE is
 * matched against an allow-list of real Datadog sites and anything else is refused BEFORE a
 * request is made. A typo-squatted or injected DD_SITE would otherwise hand live credentials
 * to an arbitrary host and come back with an ordinary-looking 401.
 *
 * Dry-run: requests flagged `write` are recorded in `planned` instead of being sent. Reads
 * (including POST-based searches such as logs/spans) always run.
 */

export class DatadogError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "DatadogError";
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_SITE = "datadoghq.com";

/** Every Datadog site, as of the public documentation. DD_SITE is matched against this list and nothing else. */
export const KNOWN_SITES = new Set([
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "ddog-gov.com",
]);

/**
 * Test-only API base override. Honored ONLY for loopback hosts, so it cannot be used to send
 * credentials anywhere else; any other value is refused before a request is made.
 */
export const TEST_BASE_ENV = "DD_TEST_API_BASE";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Users copy the *app* URL out of the browser, so accept every shape of it:
 * "https://app.datadoghq.eu/", "app.datadoghq.eu", "api.datadoghq.eu", "datadoghq.eu" -> "datadoghq.eu".
 * Returns null for anything not in KNOWN_SITES.
 */
export function normalizeSite(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return DEFAULT_SITE;
  s = s
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^(app|api)\./, "");
  if (!s) return DEFAULT_SITE;
  return KNOWN_SITES.has(s) ? s : null;
}

function badSiteError(raw) {
  return new DatadogError(
    [
      `Refusing to use DD_SITE="${String(raw).slice(0, 80)}": it is not a known Datadog site.`,
      "",
      "The site becomes the API host (api.<site>) and your DD_API_KEY / DD_APP_KEY are sent",
      "in the request headers, so an unrecognised host would receive live credentials.",
      "Nothing was sent.",
      "",
      `Valid values: ${[...KNOWN_SITES].join(", ")}.`,
      "Check your shell profile (and any project-local .envrc/.env that may have set DD_SITE).",
    ].join("\n"),
    { code: "bad_site" },
  );
}

export const SETUP_HELP = `Datadog credentials are not configured.

Export ONE of these in your shell profile (~/.zshrc, ~/.zprofile, ~/.bashrc), then retry:

  # classic key pair
  export DD_API_KEY="<api key>"          # Organization Settings > API Keys
  export DD_APP_KEY="ddapp_..."          # Organization Settings > Application Keys

  # or a scoped token (no API key needed)
  export DD_BEARER_TOKEN="ddpat_..."     # Personal Access Token (ddsat_ service token also works)

  export DD_SITE="${DEFAULT_SITE}"          # datadoghq.eu | us3.datadoghq.com | us5.datadoghq.com |
                                         # ap1.datadoghq.com | ap2.datadoghq.com | ddog-gov.com (must match your browser URL)

Scoped keys/tokens need at least: logs_read_data, logs_read_index_data, timeseries_query,
monitors_read, dashboards_read (plus apm_read for spans, events_read for events).`;

const isToken = (v) => !!v && /^dd(pat|sat)_/.test(v);

/** Resolve credentials from the environment. Throws (nothing sent) on a bad site or missing credentials. */
export function loadCreds(env = process.env) {
  const siteRaw = env.DD_SITE ?? env.DATADOG_SITE;
  const site = normalizeSite(siteRaw);
  if (site === null) throw badSiteError(siteRaw);
  const apiKey = (env.DD_API_KEY ?? env.DATADOG_API_KEY)?.trim() || undefined;
  const appKey = (env.DD_APP_KEY ?? env.DD_APPLICATION_KEY ?? env.DATADOG_APP_KEY)?.trim() || undefined;
  const tokenRaw = env.DD_BEARER_TOKEN ?? env.DATADOG_BEARER_TOKEN;
  // An explicit bearer token wins; a ddpat_/ddsat_ value parked in DD_APP_KEY counts as one.
  const token = tokenRaw?.trim() || (isToken(appKey) ? appKey : undefined);
  if (token) return { site, scheme: "bearer", token, apiKey };
  if (apiKey && appKey) return { site, scheme: "pair", apiKey, appKey };
  throw new DatadogError(SETUP_HELP, { code: "no_credentials" });
}

/** Validate the test-only base override. Returns the base URL or throws. */
export function testBase(raw) {
  if (raw === undefined || raw === "") return undefined;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new DatadogError(`${TEST_BASE_ENV}="${String(raw).slice(0, 80)}" is not a valid URL. Nothing was sent.`, { code: "bad_base" });
  }
  if (!["http:", "https:"].includes(u.protocol) || !LOOPBACK.has(u.hostname)) {
    throw new DatadogError(
      `Refusing ${TEST_BASE_ENV}="${String(raw).slice(0, 80)}": it is a test-only override and is honored only for localhost/127.0.0.1/[::1]. Nothing was sent. Unset it to use api.<DD_SITE>.`,
      { code: "bad_base" },
    );
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

export const schemeLabel = (creds) => (creds.scheme === "bearer" ? "Bearer token (ddpat_/ddsat_)" : "DD-API-KEY + DD-APPLICATION-KEY");

export class Client {
  /**
   * @param {{site:string, scheme:"pair"|"bearer", apiKey?:string, appKey?:string, token?:string}} creds
   * @param {{base?:string, dryRun?:boolean, fetchImpl?:typeof fetch, timeoutMs?:number, retryCapSec?:number}} [opts]
   */
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.base = opts.base || `https://api.${creds.site}`;
    this.dryRun = !!opts.dryRun;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retryCapSec = opts.retryCapSec ?? 10;
    /** @type {{method:string, url:string, headers:object, body?:object}[]} */
    this.planned = [];
    /** @type {string[]} */
    this.intents = [];
  }

  get site() {
    return this.creds.site;
  }

  intent(text) {
    this.intents.push(text);
  }

  headers() {
    const h = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.creds.scheme === "bearer") {
      h.Authorization = `Bearer ${this.creds.token}`;
      // Harmless when present; some ingest-adjacent endpoints still want the org key.
      if (this.creds.apiKey) h["DD-API-KEY"] = this.creds.apiKey;
    } else {
      h["DD-API-KEY"] = this.creds.apiKey;
      h["DD-APPLICATION-KEY"] = this.creds.appKey;
    }
    return h;
  }

  redactedHeaders() {
    const out = {};
    for (const [k, v] of Object.entries(this.headers())) {
      out[k] = k === "Authorization" ? "Bearer <redacted>" : k.startsWith("DD-") ? "<redacted>" : v;
    }
    return out;
  }

  url(path, query) {
    const u = new URL(this.base + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return u;
  }

  /**
   * Low-level request. Never throws on HTTP status; returns {ok, status, json, text}.
   * @param {string} method
   * @param {string} path
   * @param {{query?:object, body?:unknown, write?:boolean}} [o]
   */
  async raw(method, path, o = {}) {
    const m = method.toUpperCase();
    const url = this.url(path, o.query);
    if (this.dryRun && o.write) {
      this.planned.push({ method: m, url: url.toString(), headers: this.redactedHeaders(), body: o.body });
      return { ok: true, status: 0, json: { __dryRun: true }, text: "", dryRun: true };
    }
    /** @type {RequestInit} */
    const init = { method: m, headers: this.headers() };
    if (o.body !== undefined) init.body = JSON.stringify(o.body);
    for (let attempt = 0; ; attempt++) {
      init.signal = AbortSignal.timeout(this.timeoutMs);
      let res;
      try {
        res = await this.fetchImpl(url, init);
      } catch (e) {
        const why = e?.name === "TimeoutError" ? `timed out after ${this.timeoutMs / 1000}s` : (e?.cause?.message ?? e?.message ?? String(e));
        throw new DatadogError(`Request failed: ${why} (check network access and DD_SITE=${this.site}; the API host is api.${this.site})`, { code: "network" });
      }
      if (res.status === 429 && attempt < 2) {
        const hdr = res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset");
        const n = Number(hdr);
        const wait = Math.min(hdr !== null && Number.isFinite(n) ? n : 2, this.retryCapSec);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON (HTML/proxy error page) */
      }
      return { ok: res.ok, status: res.status, json, text };
    }
  }

  /** Request that throws a DatadogError with an actionable message on a non-2xx status. Returns parsed JSON. */
  async call(method, path, o = {}) {
    const r = await this.raw(method, path, o);
    if (!r.ok) throw new DatadogError(errText(r, this.creds), { status: r.status, code: "http" });
    return r.json ?? {};
  }

  get(path, query) {
    return this.call("GET", path, { query });
  }
}

export function errText(r, creds) {
  const parts = [`HTTP ${r.status}`];
  const errs = r.json?.errors;
  if (Array.isArray(errs)) parts.push(...errs.map((e) => (typeof e === "string" ? e : (e?.detail ?? e?.title ?? JSON.stringify(e)))));
  else if (typeof errs === "string") parts.push(errs);
  if (parts.length === 1) {
    parts.push(
      (r.text || "(empty response)").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "(empty response)",
    );
  }
  if (r.status === 401) {
    parts.push(
      creds.scheme === "bearer"
        ? "Auth failed: DD_BEARER_TOKEN is invalid, revoked or expired (PATs expire; max 1 year)."
        : "Auth failed: DD_API_KEY/DD_APP_KEY invalid, or DD_SITE is wrong for this org.",
    );
  }
  if (r.status === 403) {
    // Datadog answers 403 both for "key is fine but unscoped" and for a REVOKED/invalid
    // application key (401 only covers a bad API key), so never claim the credential is valid.
    parts.push(
      creds.scheme === "bearer"
        ? "Forbidden: either DD_BEARER_TOKEN lacks the scope this endpoint needs, or the token was revoked/expired. Check with `datadog validate`."
        : "Forbidden: either DD_APP_KEY lacks the scope this endpoint needs, or it was revoked/deleted (Datadog returns 403, not 401, for an invalid application key). Check with `datadog validate`; if EVERY command returns 403, assume the app key is gone and create a new one.",
    );
  }
  if (r.status === 404) parts.push(`Not found: check the id, and that DD_SITE=${creds.site} is the site holding this resource.`);
  if (r.status === 429) parts.push("Rate limited: wait and retry, or narrow the time window.");
  return `Datadog API error: ${parts.join(" | ")}`;
}
