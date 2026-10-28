/**
 * Minimal Slack Web API client acting as the user via browser client credentials (fetch only).
 *
 * Auth: the xoxc token goes in the POST form body (never in a URL, never in an error message);
 * the xoxd `d` cookie authenticates the session. Both are required together.
 *
 * Dry-run: every call to a write method (chat.postMessage, reactions.add, file upload steps) is
 * recorded in `planned` instead of being sent, and a placeholder result is returned so multi-step
 * flows (upload) can finish and print their full plan. Read calls still run so names resolve.
 */

export class SlackError extends Error {
  constructor(message, { code, slackError } = {}) {
    super(message);
    this.name = "SlackError";
    this.code = code;
    this.slackError = slackError;
  }
}

export const DEFAULT_BASE = "https://slack.com/api";
export const DEFAULT_EDGE_BASE = "https://edgeapi.slack.com";

/** Methods that change something in Slack. Only these are intercepted by --dry-run. */
export const WRITE_METHODS = new Set(["chat.postMessage", "reactions.add", "files.getUploadURLExternal", "files.completeUploadExternal"]);

export const SETUP_HELP = `Slack credentials are not configured.

This tool talks to Slack as YOU using browser client tokens, so it needs two values
from a logged-in Slack web session (DevTools on the Slack tab):

  SLACK_TOKEN   the xoxc- token   (Console: JSON.parse(localStorage.localConfig_v2).teams -> your team's token,
                                   or any /api/ request's form field "token")
  SLACK_COOKIE  the xoxd- cookie  (Application -> Cookies -> app.slack.com -> cookie named "d", copy its Value)

Add to your shell profile (~/.zshrc etc.) and open a new terminal / restart Claude Code:

  export SLACK_TOKEN="xoxc-..."
  export SLACK_COOKIE="xoxd-..."
  export SLACK_WORKSPACE="myco"     # optional, your workspace subdomain

Both tokens are required together and rotate on logout; re-copy them if you get invalid_auth.`;

/** Accept either the bare cookie value or a full "d=xoxd-...; other=..." pasting. */
export function normalizeCookie(raw) {
  const v = String(raw).trim();
  const m = v.match(/(?:^|;\s*)d=([^;]+)/);
  return (m ? m[1] : v).trim();
}

export function loadCreds(env = process.env) {
  const token = env.SLACK_TOKEN?.trim();
  const cookie = env.SLACK_COOKIE?.trim();
  if (!token || !cookie) throw new SlackError(SETUP_HELP, { code: "no_credentials" });
  return { token, cookie: normalizeCookie(cookie), workspace: env.SLACK_WORKSPACE?.trim() || undefined };
}

export function apiErr(method, r) {
  const hint =
    r.error === "invalid_auth" || r.error === "not_authed"
      ? " (SLACK_TOKEN/SLACK_COOKIE are invalid or expired. Re-copy both from a fresh Slack web session; they rotate on logout.)"
      : r.error === "missing_scope"
        ? " (this client token lacks a capability the Slack web app itself would have; unusual for xoxc, re-copy the token.)"
        : "";
  return `Slack API error (${method}): ${r.error ?? "unknown"}${hint}`;
}

/** Throw a SlackError for a failed API result; auth failures get their own code. */
export function failed(method, r) {
  const auth = r.error === "invalid_auth" || r.error === "not_authed";
  return new SlackError(apiErr(method, r), { code: auth ? "auth" : "api", slackError: r.error });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Base-URL overrides must be https, or plain http only on loopback (tests). */
function checkBase(raw, name) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new SlackError(`${name} is not a valid URL.`, { code: "usage" });
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname)))
    throw new SlackError(`${name} must be https (http is allowed only for localhost).`, { code: "usage" });
  return raw.replace(/\/+$/, "");
}

const SLACK_FILE_HOST = /(^|\.)slack\.com$|(^|\.)slack-files\.com$/;

const netMsg = (e) => e?.cause?.message ?? e?.message ?? String(e);

export class Client {
  /**
   * @param {{token:string, cookie:string, workspace?:string}} creds
   * @param {{base?:string, edgeBase?:string, dryRun?:boolean, fetchImpl?:typeof fetch, timeoutMs?:number, maxRetryWaitS?:number}} [opts]
   */
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.base = checkBase(opts.base || DEFAULT_BASE, "SLACK_API_BASE");
    this.edgeBase = checkBase(opts.edgeBase || DEFAULT_EDGE_BASE, "SLACK_EDGE_BASE");
    this.dryRun = !!opts.dryRun;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetryWaitS = opts.maxRetryWaitS ?? 30;
    /** @type {object[]} writes that --dry-run intercepted, in order. Never contains credentials. */
    this.planned = [];
  }

  /**
   * Call a Slack Web API method. Returns the parsed `{ok, error?, ...}` result (never throws for
   * API-level errors). Honors 429 Retry-After with at most 4 tries.
   */
  async call(method, params = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    if (this.dryRun && WRITE_METHODS.has(method)) {
      this.planned.push({ kind: "api", method, params: clean });
      if (method === "files.getUploadURLExternal") return { ok: true, __dryRun: true, upload_url: "<upload_url from files.getUploadURLExternal>", file_id: "<file_id>" };
      return { ok: true, __dryRun: true, ts: "<ts>", files: [] };
    }
    const body = new URLSearchParams();
    body.set("token", this.creds.token);
    for (const [k, v] of Object.entries(clean)) body.set(k, String(v));

    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(`${this.base}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `d=${this.creds.cookie}` },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        return { ok: false, error: `network_error: ${netMsg(e)}` };
      }
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") ?? "1");
        const wait = Number.isFinite(retry) && retry >= 0 ? retry : 1;
        if (attempt === 3) return { ok: false, error: `rate_limited (Retry-After ${wait}s, gave up after 4 tries)` };
        await new Promise((r) => setTimeout(r, Math.min(wait, this.maxRetryWaitS) * 1000));
        continue;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: `non_json_response (HTTP ${res.status}): ${text.slice(0, 200)}` };
      }
    }
    return { ok: false, error: "rate_limited" };
  }

  /**
   * The endpoint the Slack client itself uses for @-autocomplete. Fuzzy, so results are only
   * candidates; callers still require an exact name match. Failures yield [].
   */
  async searchUsers(scopes, query) {
    for (const scope of scopes.filter(Boolean)) {
      try {
        const res = await this.fetchImpl(`${this.edgeBase}/cache/${encodeURIComponent(scope)}/users/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: `d=${this.creds.cookie}` },
          body: JSON.stringify({ token: this.creds.token, query, count: 30, present_first: true }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) continue;
        const j = await res.json();
        if (j?.ok && Array.isArray(j.results) && j.results.length) return j.results;
      } catch {
        /* best-effort */
      }
    }
    return [];
  }

  /** True when `url` may receive the Slack credentials: https Slack file hosts, or the API origin itself. */
  isTrustedFileUrl(url) {
    try {
      const u = new URL(url);
      if (u.origin === new URL(this.base).origin) return true;
      return u.protocol === "https:" && SLACK_FILE_HOST.test(u.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Fetch a Slack-hosted file with the client credentials. Redirects are followed manually so
   * every hop is re-checked and credentials never reach a non-Slack host.
   */
  async fetchFile(url, maxBytes) {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!this.isTrustedFileUrl(current)) {
        let host = current;
        try {
          host = new URL(current).hostname;
        } catch {
          throw new SlackError(`Invalid file URL: ${current}`, { code: "usage" });
        }
        throw new SlackError(`Refusing to send Slack credentials to non-Slack host ${host}.`, { code: "untrusted_url" });
      }
      let res;
      try {
        res = await this.fetchImpl(current, {
          headers: { Authorization: `Bearer ${this.creds.token}`, Cookie: `d=${this.creds.cookie}` },
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs * 4),
        });
      } catch (e) {
        throw new SlackError(`network_error: ${netMsg(e)}`, { code: "network" });
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), current).toString();
        continue;
      }
      if (!res.ok) throw new SlackError(`Download failed: HTTP ${res.status}`, { code: "http" });
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > maxBytes) throw new SlackError(`File too large to download (${len} bytes).`, { code: "too_large" });
      const contentType = res.headers.get("content-type") ?? "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new SlackError(`File too large to download (${buf.length} bytes).`, { code: "too_large" });
      if (contentType.startsWith("text/html") && /<html|<!doctype/i.test(buf.subarray(0, 200).toString("utf8")))
        throw new SlackError("Slack returned an HTML page instead of the file (auth expired or no access to this file).", { code: "html" });
      return { buf, contentType, url: current };
    }
    throw new SlackError("Too many redirects while downloading the file.", { code: "http" });
  }

  /** Step 2 of the external upload flow: POST raw bytes to the one-time upload URL (no credentials). */
  async uploadBytes(uploadUrl, buf, label) {
    if (this.dryRun) {
      this.planned.push({ kind: "upload", url: uploadUrl, bytes: buf.length, file: label });
      return;
    }
    let u;
    try {
      u = new URL(uploadUrl);
    } catch {
      throw new SlackError("files.getUploadURLExternal returned an invalid upload_url.", { code: "api" });
    }
    let up;
    try {
      up = await this.fetchImpl(u, { method: "POST", body: new Uint8Array(buf), signal: AbortSignal.timeout(this.timeoutMs * 10) });
    } catch (e) {
      throw new SlackError(`upload_network_error: ${netMsg(e)}`, { code: "network" });
    }
    if (!up.ok) throw new SlackError(`Upload of bytes failed: HTTP ${up.status}`, { code: "http" });
  }
}
