/**
 * Slack extension for pi — acts as YOU, using browser client tokens.
 *
 * Slack's official app tokens (xoxb/xoxp) can only see channels the app was invited
 * to and are rate-limited to 1 req/min for non-Marketplace apps. To get true parity
 * with what you see in the Slack client (every channel, DM, private group, search,
 * unread badges), this extension uses the desktop/web client credentials instead:
 *
 *   SLACK_TOKEN     the client token, starts with "xoxc-"      (required)
 *   SLACK_COOKIE    the "d" session cookie, starts with "xoxd-" (required)
 *   SLACK_WORKSPACE workspace host, e.g. "myco" or "myco.slack.com" (optional)
 *
 * Both are needed together: the xoxc token is worthless without the matching xoxd
 * cookie, which is what actually authenticates the session.
 *
 * How to get them (Slack in a browser, DevTools open on the Slack tab):
 *   xoxc  ->  Console:  JSON.parse(localStorage.localConfig_v2).teams  then find your
 *             team's `token` (starts with xoxc-). Or Network tab: any /api/ request's
 *             form data has a `token` field.
 *   xoxd  ->  Application tab -> Cookies -> https://app.slack.com -> cookie named `d`.
 *             Copy its Value (starts with xoxd-). It is URL-encoded; paste it as-is.
 *
 * Then, in your shell profile (~/.zshrc etc.) and restart pi:
 *   export SLACK_TOKEN="xoxc-..."
 *   export SLACK_COOKIE="xoxd-..."
 *   export SLACK_WORKSPACE="myco"
 *
 * These tokens rotate on logout and periodically; a 401/invalid_auth means re-copy them.
 * Treat them like a password — they grant full access to your Slack account.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const PROFILES = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc", ".profile"];
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache");
const CACHE_FILE = join(CACHE_DIR, "slack-names.json");
const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** Max messages returned in one rendered block, regardless of what the API returns. */
const MAX_RENDER = 60;

/* --------------------------------------------------------------- credentials */

type Creds = {
  token: string;
  cookie: string;
  workspace?: string;
  source: "env" | "shell-profile";
};

let credsCache: Creds | null = null;
let credsPromise: Promise<Creds | { error: string }> | null = null;

function normalizeCookie(raw: string): string {
  const v = raw.trim();
  // Accept either the bare value or a full "d=xoxd-..." pasting.
  const m = v.match(/(?:^|;\s*)d=([^;]+)/);
  return (m ? m[1] : v).trim();
}

function fromEnv(): Creds | null {
  const token = process.env.SLACK_TOKEN?.trim();
  const cookie = process.env.SLACK_COOKIE?.trim();
  if (!token || !cookie) return null;
  return {
    token,
    cookie: normalizeCookie(cookie),
    workspace: process.env.SLACK_WORKSPACE?.trim() || undefined,
    source: "env",
  };
}

function fromLoginShell(): Promise<Creds | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    if (!PROFILES.some((p) => existsSync(join(homedir(), p)))) return resolve(null);
    execFile(
      shell,
      ["-l", "-i", "-c", 'printf "%s\\n%s\\n%s\\n" "$SLACK_TOKEN" "$SLACK_COOKIE" "$SLACK_WORKSPACE"'],
      { timeout: 10_000, env: { ...process.env, PI_SLACK_PROBE: "1" } },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        const [token = "", cookie = "", workspace = ""] = stdout.split("\n").map((s) => s.trim());
        if (!token || !cookie) return resolve(null);
        resolve({ token, cookie: normalizeCookie(cookie), workspace: workspace || undefined, source: "shell-profile" });
      },
    );
  });
}

const SETUP_HELP = `Slack credentials are not configured.

This extension talks to Slack as YOU using browser client tokens, so it needs two values
from a logged-in Slack web session (DevTools on the Slack tab):

  SLACK_TOKEN   the xoxc- token   (Console: JSON.parse(localStorage.localConfig_v2).teams -> your team's token,
                                   or any /api/ request's form field "token")
  SLACK_COOKIE  the xoxd- cookie  (Application -> Cookies -> app.slack.com -> cookie named "d", copy its Value)

Add to your shell profile (~/.zshrc etc.) and restart pi:

  export SLACK_TOKEN="xoxc-..."
  export SLACK_COOKIE="xoxd-..."
  export SLACK_WORKSPACE="myco"     # optional, your workspace subdomain

Both tokens are required together and rotate on logout — re-copy them if you get invalid_auth.`;

async function getCreds(): Promise<Creds | { error: string }> {
  if (credsCache) return credsCache;
  if (!credsPromise) {
    credsPromise = (async () => {
      const direct = fromEnv();
      if (direct) return (credsCache = direct);
      const shell = await fromLoginShell();
      if (shell) return (credsCache = shell);
      credsPromise = null; // allow retry after the user fixes their profile
      return { error: SETUP_HELP };
    })();
  }
  return credsPromise;
}

/* ------------------------------------------------------------- Slack Web API */

type ApiResult = { ok: boolean; error?: string; [k: string]: any };

/**
 * Call a Slack Web API method with client credentials.
 * The xoxc token goes in the form body; the xoxd cookie authenticates the session.
 * Honors 429 Retry-After with a bounded number of retries.
 */
async function call(
  creds: Creds,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
  signal?: AbortSignal,
): Promise<ApiResult> {
  const body = new URLSearchParams();
  body.set("token", creds.token);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));

  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `d=${creds.cookie}`,
        },
        body,
        signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      return { ok: false, error: `network_error: ${e?.message ?? String(e)}` };
    }

    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "1");
      if (attempt === 3) return { ok: false, error: `rate_limited (Retry-After ${retry}s, gave up after 4 tries)` };
      await new Promise((r) => setTimeout(r, Math.min(retry, 30) * 1000));
      continue;
    }

    const text = await res.text();
    let json: ApiResult;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `non_json_response (HTTP ${res.status}): ${text.slice(0, 200)}` };
    }
    return json;
  }
  return { ok: false, error: "rate_limited" };
}

function apiErr(method: string, r: ApiResult): string {
  const hint =
    r.error === "invalid_auth" || r.error === "not_authed"
      ? " — SLACK_TOKEN/SLACK_COOKIE are invalid or expired. Re-copy both from a fresh Slack web session (they rotate on logout)."
      : r.error === "missing_scope"
        ? " — this client token lacks a capability the Slack web app itself would have; unusual for xoxc, re-copy the token."
        : "";
  return `Slack API error (${method}): ${r.error ?? "unknown"}${hint}`;
}

/* ------------------------------------------------------------------ name cache */

type NameCache = { users: Record<string, string>; channels: Record<string, string> };
let names: NameCache | null = null;

function loadNames(): NameCache {
  if (names) return names;
  try {
    names = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    names = { users: {}, channels: {} };
  }
  if (!names!.users) names!.users = {};
  if (!names!.channels) names!.channels = {};
  return names!;
}

function saveNames(): void {
  try {
    // 0700/0600: this maps Slack ids to the real names of the user's colleagues and
    // private channels. It is not a secret, but it is other people's data and there is
    // no reason for every account on the machine to be able to read it.
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_FILE, JSON.stringify(names ?? { users: {}, channels: {} }), { mode: 0o600 });
  } catch {
    /* cache is best-effort */
  }
}

/** Resolve a set of user ids to display names, filling the cache with one users.info per miss. */
async function resolveUsers(creds: Creds, ids: Iterable<string>, signal?: AbortSignal): Promise<void> {
  const c = loadNames();
  const misses = [...new Set([...ids])].filter((id) => id && !c.users[id]);
  let changed = false;
  for (const id of misses) {
    const r = await call(creds, "users.info", { user: id }, signal);
    if (r.ok && r.user) {
      c.users[id] = r.user.profile?.display_name || r.user.profile?.real_name || r.user.name || id;
      changed = true;
    } else {
      c.users[id] = id; // negative-cache so we don't refetch a dead id every render
    }
  }
  if (changed) saveNames();
}

function userName(id: string): string {
  return loadNames().users[id] || id;
}

/**
 * Resolve a conversation id to a readable label: "#channel" / "#private" for channels,
 * "@user (DM)" for direct messages. Cached; one conversations.info per miss.
 */
async function channelLabel(creds: Creds, id: string, signal?: AbortSignal): Promise<string> {
  if (!id) return "?";
  const c = loadNames();
  if (c.channels[id]) return c.channels[id];
  const r = await call(creds, "conversations.info", { channel: id }, signal);
  let label = id;
  if (r.ok && r.channel) {
    const ch = r.channel;
    if (ch.is_im && ch.user) {
      await resolveUsers(creds, [ch.user], signal);
      label = `@${userName(ch.user)} (DM)`;
    } else if (ch.is_mpim) {
      label = `${ch.name ?? "group DM"} (group DM)`;
    } else if (ch.name) {
      label = `#${ch.name}`;
    }
  }
  c.channels[id] = label;
  saveNames();
  return label;
}

/* ---------------------------------------------------------- markup rendering */

/** Collect every user id referenced by Slack `<@U…>` markup across a batch of messages. */
function collectUserIds(msgs: any[]): Set<string> {
  const ids = new Set<string>();
  for (const m of msgs) {
    if (m.user) ids.add(m.user);
    for (const mm of String(m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(mm[1]);
  }
  return ids;
}

/** Turn Slack mrkdwn entity markup into readable text using the resolved name cache. */
function renderText(text: string): string {
  if (!text) return "";
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `@${label || userName(id)}`)
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_, _id, label) => `#${label || _id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || "@team")
    .replace(/<!(here|channel|everyone)>/g, (_, k) => `@${k}`)
    .replace(/<!date\^(\d+)\^([^>|]*)(?:\^[^>|]*)?(?:\|([^>]*))?>/g, (_, __, ___, fb) => fb || "(date)")
    .replace(/<(https?:[^>|]+)\|([^>]*)>/g, (_, url, label) => `${label} (${url})`)
    .replace(/<(https?:[^>]+)>/g, (_, url) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const tsToDate = (ts: string): string => {
  const ms = Math.floor(Number(ts) * 1000);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
};

const tsToTime = (ts: string): string => {
  const ms = Math.floor(Number(ts) * 1000);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString().slice(11, 16);
};

/** Render one message line. `withDate` prefixes the full date, else just HH:MM. */
function msgLine(m: any, withDate: boolean): string {
  const who = m.user ? userName(m.user) : m.username || m.bot_id || "?";
  const when = withDate ? tsToDate(m.ts) : tsToTime(m.ts);
  const body = renderText(m.text ?? "").replace(/\n/g, "\n    ");
  const extras: string[] = [];
  if (Array.isArray(m.files) && m.files.length)
    extras.push(`📎 ${m.files.map((f: any) => `${f.name ?? "file"}${f.filetype ? `.${f.filetype}` : ""}`).join(", ")}`);
  if (Array.isArray(m.reactions) && m.reactions.length)
    extras.push(m.reactions.map((r: any) => `:${r.name}:×${r.count}`).join(" "));
  if (m.reply_count) extras.push(`↳ ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}`);
  const tail = extras.length ? `\n    ${extras.join("  ·  ")}` : "";
  return `[${when}] ${who}: ${body || "(no text)"}${tail}`;
}

/* ---------------------------------------------------- permalink / conversation ids */

/**
 * Parse a Slack message permalink into { channel, ts, thread_ts? }.
 * Format: https://<ws>.slack.com/archives/<C…|D…|G…>/p<digits>[?thread_ts=…&cid=…]
 * The p-timestamp "p1700000000123456" maps to ts "1700000000.123456".
 */
function parsePermalink(url: string): { channel: string; ts: string; thread_ts?: string } | null {
  const m = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) return null;
  const out: { channel: string; ts: string; thread_ts?: string } = { channel: m[1], ts: `${m[2]}.${m[3]}` };
  const t = url.match(/[?&]thread_ts=([0-9.]+)/);
  if (t) out.thread_ts = t[1];
  const cid = url.match(/[?&]cid=([A-Z0-9]+)/);
  if (cid) out.channel = cid[1];
  return out;
}

/** Resolve a channel reference the user might give: id, #name, or already-an-id. */
async function resolveChannel(creds: Creds, ref: string, signal?: AbortSignal): Promise<string | null> {
  const r = ref.trim().replace(/^#/, "");
  if (/^[CDG][A-Z0-9]+$/.test(r)) return r; // already a channel/dm/group id
  // Name lookup: page conversations.list. Bounded; client token sees all the user's convos.
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await call(
      creds,
      "conversations.list",
      { limit: 1000, exclude_archived: true, types: "public_channel,private_channel", cursor },
      signal,
    );
    if (!res.ok) return null;
    for (const ch of res.channels ?? []) if (ch.name === r) return ch.id;
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return null;
}

/* ------------------------------------------------------------- read renderers */

/** Render search.messages matches (each carries its own channel + permalink). */
async function renderMatches(creds: Creds, matches: any[], signal?: AbortSignal): Promise<string> {
  await resolveUsers(creds, collectUserIds(matches), signal);
  const lines: string[] = [];
  for (const m of matches) {
    const chan = m.channel?.name
      ? `#${m.channel.name}`
      : m.channel?.id
        ? await channelLabel(creds, m.channel.id, signal)
        : "?";
    const who = m.user ? userName(m.user) : m.username ?? "?";
    lines.push(`[${tsToDate(m.ts)}] ${chan}  ${who}: ${renderText(m.text ?? "")}\n    ${m.permalink ?? ""}`);
  }
  return lines.join("\n");
}

async function renderMessages(
  creds: Creds,
  header: string,
  msgs: any[],
  withDate: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const shown = msgs.slice(0, MAX_RENDER);
  await resolveUsers(creds, collectUserIds(shown), signal);
  const lines = shown.map((m) => msgLine(m, withDate));
  const more = msgs.length > shown.length ? `\n… ${msgs.length - shown.length} more not shown (cap ${MAX_RENDER})` : "";
  return `${header}\n${"-".repeat(Math.min(header.length, 60))}\n${lines.join("\n")}${more}`;
}

/* --------------------------------------------------------------- approval gate */

type Pending = { action: string; createdAt: number };
const pending = new Map<string, Pending>();
const TOKEN_SALT = randomBytes(16).toString("hex");

function tokenFor(action: string, payload: unknown): string {
  const canonical = JSON.stringify({ salt: TOKEN_SALT, action, payload });
  return `slack-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > APPROVAL_TTL_MS) pending.delete(k);
}

/* ------------------------------------------------------------------- schema */

const schema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("whoami"),
      Type.Literal("resolve"),
      Type.Literal("history"),
      Type.Literal("thread"),
      Type.Literal("search"),
      Type.Literal("channels"),
      Type.Literal("users"),
      Type.Literal("mentions"),
      Type.Literal("post"),
      Type.Literal("reply"),
      Type.Literal("react"),
    ],
    {
      description:
        "Read: whoami, resolve (a message/thread permalink -> full thread), history (a channel), thread, search (Slack query), channels, users, mentions (recent @-mentions of me). Write (preview+confirm): post, reply, react.",
    },
  ),
  link: Type.Optional(Type.String({ description: "A Slack message permalink, for action=resolve." })),
  channel: Type.Optional(
    Type.String({ description: "Channel id (C…/D…/G…) or #name. For history/thread/post/reply/react." }),
  ),
  ts: Type.Optional(
    Type.String({ description: "Message timestamp e.g. 1700000000.123456. For thread (root), reply, react." }),
  ),
  query: Type.Optional(
    Type.String({ description: 'search query, e.g. `from:@ostap in:#backend after:2024-06-01 "deploy failed"`.' }),
  ),
  text: Type.Optional(Type.String({ description: "Message body for post/reply." })),
  emoji: Type.Optional(Type.String({ description: "Reaction emoji name (no colons), e.g. thumbsup. For react." })),
  limit: Type.Optional(Type.Number({ description: "Max items for history/search/channels/mentions (default 30)." })),
  oldest: Type.Optional(Type.String({ description: "history: only messages after this ts or ISO date." })),
  confirm_token: Type.Optional(
    Type.String({
      description:
        "Approval token from a previous preview of the SAME write payload. Only pass after the user approved it.",
    }),
  ),
});

export type SlackToolInput = Static<typeof schema>;

/* ---------------------------------------------------------------------- tool */

/**
 * Serialize approval dialogs process-wide.
 *
 * pi runs the tool calls of one assistant message in parallel unless a tool sets
 * executionMode:"sequential" (which forces the whole batch sequential). The TUI has
 * exactly ONE dialog slot: showExtensionSelector() overwrites this.extensionSelector
 * and clears the editor container, so a second concurrent ctx.ui.confirm() evicts the
 * first from the widget tree and its promise NEVER resolves — that tool call never
 * returns and the whole turn deadlocks. executionMode covers the in-batch case; this
 * queue also covers dialogs raised concurrently from elsewhere (a subagent, an event
 * handler, another gated extension). It lives on globalThis so all extensions in the
 * process share one chain.
 */
function uiExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { __piUiDialogQueue?: Promise<void> };
  const next = (g.__piUiDialogQueue ?? Promise.resolve()).then(fn, fn);
  g.__piUiDialogQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "slack",
    label: "Slack",
    // Raises an approval dialog: must never run concurrently with another tool call.
    executionMode: "sequential",
    description: `Read and act in Slack as the user, via their browser client tokens (xoxc/xoxd), so it sees exactly what they see: every channel, DM, private group, and search.

Read actions run immediately:
  whoami    — verify auth, show the logged-in identity
  resolve   — {link:"<permalink>"} turn a pasted message/thread link into the full thread as readable text (authors by name, files, reactions). The go-to first step when the user pastes a Slack link.
  history   — {channel:"#backend", limit, oldest} recent messages in a channel/DM
  thread    — {channel, ts} the replies under a root message
  search    — {query:"from:@ana in:#api after:2024-06-01 deploy"} Slack search (client-token only)
  channels  — {query?} list channels (optionally name-filtered)
  users     — {query?} list/lookup people
  mentions  — {limit} recent messages that @-mention the user

Write actions (post, reply, react) are preview-first: the call returns the resolved payload plus a one-time confirm_token and sends nothing. In an interactive session the user instead gets a confirm dialog. Posting happens as the user's own identity in a real workspace — never write without explicit approval.

Example: user pastes a thread link and says "log this as a bug" -> slack {action:"resolve", link:"…"} to read it, then hand the content to the jira tool.`,
    promptSnippet: "Slack: read/search/resolve-thread + preview-gated post/reply/react, acting as the user",
    promptGuidelines: [
      "Use slack {action:'resolve', link} whenever the user pastes a Slack message/thread URL — it returns the whole thread with real names, far better than asking them to copy-paste it.",
      "slack write actions (post, reply, react) act as the user in a real, human-visible workspace: call the action once with full parameters and let the tool handle approval — interactive sessions show a confirm dialog; non-interactive returns a preview + confirm_token to relay, then repeat the identical call with the token after the user approves. Never invent or reuse a token, never write twice in one turn.",
      "When a slack result ends with slack_status: preview_pending_approval, nothing was posted — relay the preview and wait; do not report success or retry.",
      "When a slack result ends with slack_status: auth_error, tell the user their SLACK_TOKEN/SLACK_COOKIE are expired and must be re-copied from a fresh Slack web session; do not retry.",
      "Prefer slack {action:'search'} or {action:'mentions'} over asking the user to find a message; use Slack search operators (from:, in:, before:, after:) in query.",
    ],
    parameters: schema,
    async execute(_id, params: SlackToolInput, signal, _onUpdate, ctx: ExtensionContext) {
      sweep();
      const fin = (text: string, status: string) => ({
        content: [{ type: "text" as const, text: `${text}\n\nslack_status: ${status}` }],
        details: { status },
        isError: status !== "ok" && status !== "preview_pending_approval",
      });

      const creds = await getCreds();
      if ("error" in creds) return fin(creds.error, "auth_error");

      const authFail = (r: ApiResult, method: string) =>
        r.error === "invalid_auth" || r.error === "not_authed"
          ? fin(apiErr(method, r), "auth_error")
          : fin(apiErr(method, r), "error");

      const lim = Math.max(1, Math.min(params.limit ?? 30, MAX_RENDER));

      try {
        switch (params.action) {
          case "whoami": {
            const r = await call(creds, "auth.test", {}, signal);
            if (!r.ok) return authFail(r, "auth.test");
            return fin(
              `Authenticated as ${r.user} (${r.user_id}) on ${r.team} — ${r.url}\ncredentials source: ${creds.source}`,
              "ok",
            );
          }

          case "resolve": {
            if (!params.link) return fin("resolve needs a `link` (a Slack message permalink).", "error");
            const p = parsePermalink(params.link);
            if (!p)
              return fin(
                `Could not parse that as a Slack permalink. Expected .../archives/CXXXX/p1700000000123456. Got: ${params.link}`,
                "error",
              );
            const root = p.thread_ts ?? p.ts;
            const r = await call(creds, "conversations.replies", { channel: p.channel, ts: root, limit: 100 }, signal);
            if (!r.ok) {
              // Not a thread — fetch the single message via history around its ts.
              const h = await call(
                creds,
                "conversations.history",
                { channel: p.channel, latest: p.ts, inclusive: true, limit: 1 },
                signal,
              );
              if (!h.ok) return authFail(h, "conversations.replies/history");
              const label = await channelLabel(creds, p.channel, signal);
              const hdr = `${label}  single message  ${tsToDate(p.ts)}`;
              return fin(await renderMessages(creds, hdr, h.messages ?? [], true, signal), "ok");
            }
            const msgs = r.messages ?? [];
            const label = await channelLabel(creds, p.channel, signal);
            const hdr = `${label}  thread ${tsToDate(root)}  (${msgs.length} message${msgs.length === 1 ? "" : "s"})`;
            return fin(await renderMessages(creds, hdr, msgs, false, signal), "ok");
          }

          case "history": {
            if (!params.channel) return fin("history needs a `channel` (id or #name).", "error");
            const chan = await resolveChannel(creds, params.channel, signal);
            if (!chan) return fin(`Channel not found: ${params.channel}`, "error");
            let oldest: string | undefined;
            if (params.oldest) {
              oldest = /^\d+(\.\d+)?$/.test(params.oldest)
                ? params.oldest
                : String(Math.floor(new Date(params.oldest).getTime() / 1000));
            }
            const r = await call(creds, "conversations.history", { channel: chan, limit: lim, oldest }, signal);
            if (!r.ok) return authFail(r, "conversations.history");
            const msgs = (r.messages ?? []).slice().reverse(); // API returns newest-first
            const label = await channelLabel(creds, chan, signal);
            return fin(await renderMessages(creds, `${label}  last ${msgs.length}`, msgs, true, signal), "ok");
          }

          case "thread": {
            if (!params.channel || !params.ts)
              return fin("thread needs `channel` and the root message `ts`.", "error");
            const chan = await resolveChannel(creds, params.channel, signal);
            if (!chan) return fin(`Channel not found: ${params.channel}`, "error");
            const r = await call(creds, "conversations.replies", { channel: chan, ts: params.ts, limit: 100 }, signal);
            if (!r.ok) return authFail(r, "conversations.replies");
            const msgs = r.messages ?? [];
            const label = await channelLabel(creds, chan, signal);
            return fin(
              await renderMessages(creds, `${label}  thread ${tsToDate(params.ts)}  (${msgs.length})`, msgs, false, signal),
              "ok",
            );
          }

          case "search": {
            if (!params.query) return fin("search needs a `query`.", "error");
            const r = await call(creds, "search.messages", { query: params.query, count: lim, sort: "timestamp" }, signal);
            if (!r.ok) return authFail(r, "search.messages");
            const matches = r.messages?.matches ?? [];
            const rendered = await renderMatches(creds, matches, signal);
            const total = r.messages?.total ?? matches.length;
            return fin(`search "${params.query}" — ${total} hits, showing ${matches.length}\n${"-".repeat(40)}\n${rendered}`, "ok");
          }

          case "channels": {
            const r = await call(
              creds,
              "conversations.list",
              { limit: 1000, exclude_archived: true, types: "public_channel,private_channel" },
              signal,
            );
            if (!r.ok) return authFail(r, "conversations.list");
            let chans = r.channels ?? [];
            if (params.query) {
              const q = params.query.replace(/^#/, "").toLowerCase();
              chans = chans.filter((c: any) => c.name?.toLowerCase().includes(q));
            }
            chans.sort((a: any, b: any) => (b.num_members ?? 0) - (a.num_members ?? 0));
            const lines = chans
              .slice(0, Math.max(lim, 30))
              .map((c: any) => `#${c.name}  ${c.id}${c.is_private ? "  (private)" : ""}  ${c.num_members ?? "?"} members`);
            return fin(`${chans.length} channels${params.query ? ` matching "${params.query}"` : ""}\n${lines.join("\n")}`, "ok");
          }

          case "users": {
            const r = await call(creds, "users.list", { limit: 500 }, signal);
            if (!r.ok) return authFail(r, "users.list");
            let members = (r.members ?? []).filter((u: any) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT");
            if (params.query) {
              const q = params.query.replace(/^@/, "").toLowerCase();
              members = members.filter((u: any) =>
                [u.name, u.real_name, u.profile?.display_name, u.profile?.email].some((s: string) =>
                  s?.toLowerCase().includes(q),
                ),
              );
            }
            const lines = members
              .slice(0, Math.max(lim, 30))
              .map((u: any) => `${u.profile?.display_name || u.real_name || u.name}  @${u.name}  ${u.id}`);
            return fin(`${members.length} users${params.query ? ` matching "${params.query}"` : ""}\n${lines.join("\n")}`, "ok");
          }

          case "mentions": {
            const me = await call(creds, "auth.test", {}, signal);
            if (!me.ok) return authFail(me, "auth.test");
            const r = await call(
              creds,
              "search.messages",
              { query: `to:@${me.user} OR <@${me.user_id}>`, count: lim, sort: "timestamp" },
              signal,
            );
            if (!r.ok) return authFail(r, "search.messages");
            const matches = r.messages?.matches ?? [];
            const rendered = await renderMatches(creds, matches, signal);
            return fin(
              `recent mentions of @${me.user}${matches.length ? "" : " (none found)"}\n${"-".repeat(40)}\n${rendered}`,
              "ok",
            );
          }

          /* ---------------------------------------------------------- writes */
          case "post":
          case "reply":
          case "react": {
            const plan = await buildWritePlan(creds, params, signal);
            if ("error" in plan) return fin(plan.error, "error");

            const token = tokenFor(params.action, plan.payload);
            const execApproved = async () => {
              pending.delete(token);
              const r = await call(creds, plan.method, plan.args, signal);
              if (!r.ok) return fin(`${plan.successNote} FAILED — nothing changed.\n\n${apiErr(plan.method, r)}`, "error");
              return fin(`${plan.successNote}.\n${plan.resultLine(r)}`, "ok");
            };

            if (ctx.hasUI) {
              const ok = await uiExclusive(() =>
                ctx.ui.confirm(`slack ${params.action}`, plan.previewLines.join("\n").slice(0, 4000)),
              );
              if (!ok)
                return fin(`User declined the slack ${params.action}. Nothing was sent. Ask what to change.`, "declined");
              return await execApproved();
            }

            if (params.confirm_token !== token) {
              pending.set(token, { action: params.action, createdAt: Date.now() });
              const mismatch =
                params.confirm_token && params.confirm_token !== token
                  ? `The confirm_token you passed (${params.confirm_token}) does not match this payload and is void. Re-show the payload and get fresh approval.\n\n`
                  : "";
              return fin(
                [
                  `${mismatch}NOTHING HAS BEEN SENT TO SLACK YET. Preview of slack ${params.action}:`,
                  "",
                  ...plan.previewLines,
                  "",
                  `Show this to the user. If they approve, call slack again with IDENTICAL parameters plus confirm_token:"${token}".`,
                  `The token expires in ${APPROVAL_TTL_MS / 60000} minutes and works once.`,
                ].join("\n"),
                "preview_pending_approval",
              );
            }

            if (!pending.get(token))
              return fin(
                `Approval token ${token} is unknown or expired (single-use, ${APPROVAL_TTL_MS / 60000} min). Call slack again without confirm_token to regenerate the preview.`,
                "refused_unapproved",
              );

            if (process.env.PI_SLACK_ALLOW_UNATTENDED_WRITES !== "1")
              return fin(
                `Refusing to execute slack ${params.action}: no interactive UI (mode=${ctx.mode}), so no human could confirm the payload. Nothing was sent. This needs an interactive pi session.`,
                "refused_unapproved",
              );

            return await execApproved();
          }

          default:
            return fin(`Unknown action.`, "error");
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return fin("Cancelled.", "error");
        return fin(`slack tool failed: ${e?.message ?? String(e)}`, "error");
      }
    },
    renderCall(args: SlackToolInput, theme: any) {
      const bits = [args.action, args.channel, args.link, args.query].filter(Boolean).join(" ");
      return new Text(theme.fg("accent", `slack ${bits}`), 0, 0);
    },
  });
}

/* ---------------------------------------------------------- write plan builder */

type WritePlan = {
  method: string;
  args: Record<string, string | number | boolean>;
  payload: Record<string, unknown>;
  previewLines: string[];
  successNote: string;
  resultLine: (r: ApiResult) => string;
};

async function buildWritePlan(
  creds: Creds,
  params: SlackToolInput,
  signal?: AbortSignal,
): Promise<WritePlan | { error: string }> {
  if (params.action === "react") {
    if (!params.channel || !params.ts || !params.emoji)
      return { error: "react needs `channel`, `ts`, and `emoji` (name without colons)." };
    const chan = await resolveChannel(creds, params.channel, signal);
    if (!chan) return { error: `Channel not found: ${params.channel}` };
    const emoji = params.emoji.replace(/:/g, "");
    return {
      method: "reactions.add",
      args: { channel: chan, timestamp: params.ts, name: emoji },
      payload: { channel: chan, ts: params.ts, emoji },
      previewLines: [`React :${emoji}: on message ${params.ts} in ${params.channel} (${chan}).`],
      successNote: `Reacted :${emoji}:`,
      resultLine: () => `on ${params.ts} in ${params.channel}`,
    };
  }

  // post / reply
  if (!params.channel || !params.text) return { error: `${params.action} needs \`channel\` and \`text\`.` };
  if (params.action === "reply" && !params.ts) return { error: "reply needs the thread root `ts`." };
  const chan = await resolveChannel(creds, params.channel, signal);
  if (!chan) return { error: `Channel not found: ${params.channel}` };

  const args: Record<string, string | number | boolean> = { channel: chan, text: params.text };
  if (params.action === "reply") args.thread_ts = params.ts!;

  return {
    method: "chat.postMessage",
    args,
    payload: { channel: chan, thread_ts: params.action === "reply" ? params.ts : undefined, text: params.text },
    previewLines: [
      `Channel:  ${params.channel} (${chan})`,
      params.action === "reply" ? `Thread:   reply under ${params.ts}` : `Post:     new message in channel`,
      `Sent as:  YOU (your Slack identity)`,
      "",
      `Text (${params.text.length} chars):`,
      "----------------------------------------",
      params.text.slice(0, 3500),
      "----------------------------------------",
    ],
    successNote: params.action === "reply" ? "Reply posted" : "Message posted",
    resultLine: (r) => `ts ${r.ts ?? "?"} in ${params.channel}`,
  };
}
