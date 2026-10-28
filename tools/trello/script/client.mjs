/**
 * Minimal Trello REST client (fetch only, no dependencies).
 *
 * Auth: `Authorization: OAuth oauth_consumer_key=..., oauth_token=...` header, so the token is
 * never placed in a URL (URLs end up in proxy logs and error messages).
 *
 * Dry-run: every non-GET request is recorded in `planned` instead of being sent, and a
 * placeholder object is returned so multi-step commands can finish.
 */

export class TrelloError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "TrelloError";
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_BASE = "https://api.trello.com/1";

export function loadCreds(env = process.env) {
  const key = env.TRELLO_API_KEY?.trim();
  const token = env.TRELLO_TOKEN?.trim();
  if (!key || !token) {
    throw new TrelloError(
      [
        "Trello credentials are not configured. Set both variables and retry:",
        '  export TRELLO_API_KEY="..."   # https://trello.com/power-ups/admin (create a Power-Up, then API key)',
        '  export TRELLO_TOKEN="..."     # run `trello auth` for the authorization URL',
      ].join("\n"),
      { code: "no_credentials" },
    );
  }
  return { key, token };
}

export class Client {
  /**
   * @param {{key:string, token:string}} creds
   * @param {{base?:string, dryRun?:boolean, fetchImpl?:typeof fetch, timeoutMs?:number}} [opts]
   */
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.base = (opts.base || DEFAULT_BASE).replace(/\/+$/, "");
    this.dryRun = !!opts.dryRun;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    /** @type {{method:string, path:string, query?:object, body?:object, file?:string}[]} */
    this.planned = [];
    /** @type {string[]} human-readable descriptions of intended writes (shown on --dry-run). */
    this.intents = [];
  }

  get authHeader() {
    return `OAuth oauth_consumer_key="${this.creds.key}", oauth_token="${this.creds.token}"`;
  }

  intent(text) {
    this.intents.push(text);
  }

  url(path, query) {
    const u = new URL(this.base + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return u;
  }

  /** True when `url` may receive the Authorization header (same origin as the API, or trello.com). */
  isTrustedUrl(url) {
    try {
      const u = new URL(url);
      if (u.origin === new URL(this.base).origin) return true;
      return u.protocol === "https:" && (u.hostname === "trello.com" || u.hostname.endsWith(".trello.com"));
    } catch {
      return false;
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{query?:object, body?:object, form?:FormData, formLabel?:string}} [o]
   */
  async request(method, path, o = {}) {
    const m = method.toUpperCase();
    if (this.dryRun && m !== "GET") {
      this.planned.push({ method: m, path, query: o.query, body: o.body, file: o.formLabel });
      return { id: "<new-id>", __dryRun: true };
    }
    const url = this.url(path, o.query);
    const headers = { Authorization: this.authHeader, Accept: "application/json" };
    /** @type {RequestInit} */
    const init = { method: m, headers };
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
        throw new TrelloError(`Network error calling ${m} ${path}: ${e?.cause?.message ?? e?.message ?? e}`, { code: "network" });
      }
      if (res.status === 429 && attempt < 2) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Math.min(Number.isFinite(ra) && res.headers.get("retry-after") !== null ? ra : 2, 10);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw httpError(m, path, res.status, text);
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }
  post(path, body) {
    return this.request("POST", path, { body });
  }
  put(path, body) {
    return this.request("PUT", path, { body });
  }
  delete(path) {
    return this.request("DELETE", path);
  }

  /** Authenticated binary download. Refuses to send credentials to foreign hosts. */
  async download(url) {
    if (!this.isTrustedUrl(url)) throw new TrelloError(`Refusing to send credentials to untrusted host: ${url}`, { code: "untrusted_url" });
    const res = await this.fetchImpl(url, { headers: { Authorization: this.authHeader }, signal: AbortSignal.timeout(this.timeoutMs * 4) });
    if (!res.ok) throw httpError("GET", url, res.status, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }
}

function httpError(method, path, status, body) {
  const detail = String(body ?? "").trim().slice(0, 300);
  let msg;
  if (status === 401) msg = `Unauthorized (401): TRELLO_API_KEY or TRELLO_TOKEN is invalid, expired, or lacks scope. Detail: ${detail}`;
  else if (status === 403) msg = `Forbidden (403): the token has no access to this resource. Detail: ${detail}`;
  else if (status === 404) msg = `Not found (404) for ${method} ${path}: wrong id, or the token cannot see it. Detail: ${detail}`;
  else if (status === 400) msg = `Bad request (400) for ${method} ${path}: ${detail}`;
  else if (status === 429) msg = `Rate limited (429): Trello allows 100 requests per 10s per token. Retry shortly.`;
  else msg = `HTTP ${status} for ${method} ${path}: ${detail}`;
  return new TrelloError(msg, { status, code: "http" });
}
