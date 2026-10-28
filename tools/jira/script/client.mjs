/**
 * Minimal Jira Cloud REST client (fetch only, no dependencies).
 *
 * Config comes ONLY from the environment: JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN.
 * There is deliberately NO default instance URL: a hardcoded company host both leaks which
 * organisation this was written for and silently points a misconfigured setup at someone else's
 * Jira, sending the user's Basic-auth header there.
 *
 * Auth: `Authorization: Basic base64(user:token)` header. The token is never placed in a URL and is
 * redacted from every error message. The header is only ever sent to the JIRA_URL origin; redirects
 * to another origin (attachment content is served from a media CDN) are followed WITHOUT it.
 *
 * Dry-run: every non-GET request is recorded in `planned` instead of being sent, and a placeholder
 * object is returned so multi-step commands can finish.
 */

export class JiraError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "JiraError";
    this.status = status;
    this.code = code;
  }
}

export const SETUP_HELP = `Jira credentials are not configured. Set all three variables (e.g. in ~/.zshrc), then restart Claude Code:

  export JIRA_USERNAME="your-email@example.com"
  export JIRA_API_TOKEN="your-atlassian-api-token"
  export JIRA_URL="https://yourcompany.atlassian.net"   # required: your Jira instance

Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
(Atlassian API tokens commonly expire after 90 days: regenerate and re-export if you get 401.)`;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function loadCreds(env = process.env) {
  const username = env.JIRA_USERNAME?.trim();
  const token = env.JIRA_API_TOKEN?.trim();
  const rawUrl = env.JIRA_URL?.trim();
  if (!username || !token || !rawUrl) {
    const missing = [!rawUrl && "JIRA_URL", !username && "JIRA_USERNAME", !token && "JIRA_API_TOKEN"].filter(Boolean);
    throw new JiraError(`Missing: ${missing.join(", ")}.\n${SETUP_HELP}`, { code: "no_credentials" });
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new JiraError(`JIRA_URL is not a valid URL: "${rawUrl}". Expected e.g. https://yourcompany.atlassian.net`, { code: "bad_config" });
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    throw new JiraError(`JIRA_URL must use https:// (Basic auth over plain http would expose the token): "${rawUrl}".`, { code: "bad_config" });
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new JiraError("JIRA_URL must be a plain base URL without credentials, query or fragment.", { code: "bad_config" });
  }
  return { url: `${u.origin}${u.pathname}`.replace(/\/+$/, ""), username, token };
}

export class Client {
  /**
   * @param {{url:string, username:string, token:string}} creds
   * @param {{dryRun?:boolean, fetchImpl?:typeof fetch, timeoutMs?:number}} [opts]
   */
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.base = creds.url;
    this.origin = creds.url ? new URL(creds.url).origin : "";
    this.dryRun = !!opts.dryRun;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    /** @type {{method:string, path:string, query?:object, body?:unknown, files?:string[]}[]} */
    this.planned = [];
    /** @type {string[]} human-readable descriptions of intended writes (shown on --dry-run). */
    this.intents = [];
    this.encoded = Buffer.from(`${creds.username}:${creds.token}`).toString("base64");
  }

  get authHeader() {
    return `Basic ${this.encoded}`;
  }

  intent(text) {
    this.intents.push(text);
  }

  /** Remove anything secret from a string before it can reach stdout/stderr. */
  redact(s) {
    let out = String(s ?? "");
    for (const secret of [this.creds.token, this.encoded]) if (secret) out = out.split(secret).join("***");
    return out;
  }

  /** Build an absolute URL under JIRA_URL. Absolute or protocol-relative paths are rejected. */
  url(path, query) {
    const p = String(path);
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) {
      throw new JiraError(`Refusing absolute URL "${p}": paths are relative to JIRA_URL.`, { code: "usage" });
    }
    const u = new URL(`${this.base}/${p.replace(/^\/+/, "")}`);
    if (u.origin !== this.origin) throw new JiraError(`Refusing request outside JIRA_URL: ${u.origin}`, { code: "untrusted_url" });
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return u;
  }

  /** True when `url` may receive the Authorization header: exactly the JIRA_URL origin. */
  isTrustedUrl(url) {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} method
   * @param {string} path  relative to JIRA_URL, e.g. "rest/api/2/myself"
   * @param {{query?:object, body?:unknown, form?:FormData, files?:string[], headers?:object, readOnly?:boolean}} [o]
   *   readOnly: a POST that only reads (JQL search) and is therefore sent even under --dry-run.
   */
  async request(method, path, o = {}) {
    const m = method.toUpperCase();
    const url = this.url(path, o.query);
    if (this.dryRun && m !== "GET" && !o.readOnly) {
      this.planned.push({ method: m, path: url.pathname + url.search, body: o.body, files: o.files });
      return { id: "<new-id>", key: "<NEW-KEY>", __dryRun: true };
    }
    const headers = { Authorization: this.authHeader, Accept: "application/json", ...(o.headers ?? {}) };
    /** @type {RequestInit} */
    const init = { method: m, headers, redirect: "manual" };
    if (o.form) init.body = o.form;
    else if (o.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    for (let attempt = 0; ; attempt++) {
      init.signal = AbortSignal.timeout(this.timeoutMs);
      let res;
      try {
        res = await this.fetchImpl(url, init);
      } catch (e) {
        throw new JiraError(this.redact(`Request failed: ${e?.cause?.message ?? e?.message ?? e} (check JIRA_URL=${this.base} and network access)`), { code: "network" });
      }
      if (res.status === 429 && attempt < 2) {
        const ra = res.headers.get("retry-after");
        const wait = Math.min(ra !== null && Number.isFinite(Number(ra)) ? Number(ra) : 2, 10);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON (HTML error page etc.) */
      }
      if (!res.ok) throw new JiraError(this.redact(errText(res.status, json, text)), { status: res.status, code: "http" });
      return json ?? (text || {});
    }
  }

  /** Platform REST API (/rest/api/2|3). */
  api(version, method, endpoint, o) {
    return this.request(method, `rest/api/${version}/${endpoint}`, o);
  }

  /** Agile/Software API (/rest/agile/1.0): boards, backlogs, sprints. Not part of the platform API. */
  agile(method, endpoint, o) {
    return this.request(method, `rest/agile/1.0/${endpoint}`, o);
  }

  /**
   * Authenticated binary GET of a path under JIRA_URL. Redirects are followed manually so the
   * Authorization header is only sent while the URL stays on the JIRA_URL origin.
   */
  async download(path, maxBytes) {
    let url = this.url(path);
    for (let hop = 0; hop < 6; hop++) {
      const headers = this.isTrustedUrl(url) ? { Authorization: this.authHeader } : {};
      let res;
      try {
        res = await this.fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs * 4) });
      } catch (e) {
        throw new JiraError(this.redact(`Download failed: ${e?.cause?.message ?? e?.message ?? e}`), { code: "network" });
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.arrayBuffer().catch(() => {});
        const next = new URL(res.headers.get("location"), url);
        if (next.protocol !== "https:" && !this.isTrustedUrl(next) && !(next.protocol === "http:" && LOCAL_HOSTS.has(next.hostname))) throw new JiraError(`Refusing non-https redirect to ${next.origin}`, { code: "untrusted_url" });
        url = next;
        continue;
      }
      if (!res.ok) throw new JiraError(this.redact(`Download failed: HTTP ${res.status} ${res.statusText ?? ""}`.trim()), { status: res.status, code: "http" });
      const len = Number(res.headers.get("content-length") ?? "0");
      if (maxBytes && len > maxBytes) throw new JiraError(`File too large to download (${len} bytes).`, { code: "too_large" });
      const buf = Buffer.from(await res.arrayBuffer());
      if (maxBytes && buf.length > maxBytes) throw new JiraError(`File too large to download (${buf.length} bytes).`, { code: "too_large" });
      return { buf, contentType: res.headers.get("content-type") ?? "" };
    }
    throw new JiraError("Too many redirects while downloading.", { code: "http" });
  }
}

/** Jira error body -> one line: HTTP status, errorMessages, field errors, auth hint. */
export function errText(status, j, text) {
  const parts = [`HTTP ${status}`];
  if (j?.errorMessages?.length) parts.push(...j.errorMessages);
  if (j?.errors && typeof j.errors === "object") for (const [k, v] of Object.entries(j.errors)) parts.push(`${k}: ${v}`);
  if (parts.length === 1) {
    // Non-JSON body (CDN/proxy HTML error page): strip markup and keep it short.
    const plain = String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    parts.push(plain.slice(0, 300) || "(empty response)");
  }
  if (status === 401 || (status === 403 && j)) parts.push("Auth failed: JIRA_API_TOKEN may be expired/invalid, or JIRA_USERNAME is wrong.");
  if (status === 429) parts.push("Rate limited: retry shortly.");
  return `Jira API error: ${parts.join(" | ")}`;
}
