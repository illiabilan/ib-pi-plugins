/** Compact text renderers and pure parsers. Text is the default output; --json bypasses this. */

/** Max messages rendered in one block, regardless of what the API returns. */
export const MAX_RENDER = 60;

export function fmtSize(n) {
  if (n === undefined || n === null || !Number.isFinite(n)) return "?";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Parse a Slack message permalink into { channel, ts, thread_ts? }.
 * Format: https://<ws>.slack.com/archives/<C…|D…|G…>/p<digits>[?thread_ts=…&cid=…]
 * "p1700000000123456" maps to ts "1700000000.123456".
 */
export function parsePermalink(url) {
  const m = String(url).match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) return null;
  const out = { channel: m[1], ts: `${m[2]}.${m[3]}` };
  const t = url.match(/[?&]thread_ts=([0-9.]+)/);
  if (t) out.thread_ts = t[1];
  const cid = url.match(/[?&]cid=([A-Z0-9]+)/);
  if (cid) out.channel = cid[1];
  return out;
}

/** Every user id referenced by a message author or `<@U…>` markup across a batch. */
export function collectUserIds(msgs) {
  const ids = new Set();
  for (const m of msgs) {
    if (m.user) ids.add(m.user);
    for (const mm of String(m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(mm[1]);
  }
  return ids;
}

/** Turn Slack mrkdwn entity markup into readable text. `userName(id)` comes from the name cache. */
export function renderText(text, userName = (id) => id) {
  if (!text) return "";
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `@${label || userName(id)}`)
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || "@team")
    .replace(/<!(here|channel|everyone)>/g, (_, k) => `@${k}`)
    .replace(/<!date\^(\d+)\^([^>|]*)(?:\^[^>|]*)?(?:\|([^>]*))?>/g, (_, __, ___, fb) => fb || "(date)")
    .replace(/<(https?:[^>|]+)\|([^>]*)>/g, (_, url, label) => `${label} (${url})`)
    .replace(/<(https?:[^>]+)>/g, (_, url) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export const tsToDate = (ts) => {
  const ms = Math.floor(Number(ts) * 1000);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
};

export const tsToTime = (ts) => {
  const ms = Math.floor(Number(ts) * 1000);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString().slice(11, 16);
};

/**
 * One message. `withDate` prefixes the full date (UTC), else just HH:MM. The raw ts is shown so
 * it can be passed to `thread`, `reply` and `react`.
 */
export function msgLine(m, withDate, userName) {
  const who = m.user ? userName(m.user) : m.username || m.bot_id || "?";
  const when = withDate ? tsToDate(m.ts) : tsToTime(m.ts);
  const body = renderText(m.text ?? "", userName).replace(/\n/g, "\n    ");
  const extras = [];
  if (Array.isArray(m.files) && m.files.length)
    extras.push(
      `📎 ${m.files
        .map((f) => `${f.name ?? "file"} [${f.id ?? "?"}${f.mimetype ? `, ${f.mimetype}` : ""}${f.size ? `, ${fmtSize(f.size)}` : ""}]`)
        .join(", ")} (download: slack download <id>)`,
    );
  if (Array.isArray(m.reactions) && m.reactions.length) extras.push(m.reactions.map((r) => `:${r.name}:×${r.count}`).join(" "));
  if (m.reply_count) extras.push(`↳ ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}`);
  const tail = extras.length ? `\n    ${extras.join("  ·  ")}` : "";
  return `[${when} ts ${m.ts}] ${who}: ${body || "(no text)"}${tail}`;
}

export function messagesText(header, msgs, withDate, userName) {
  const shown = msgs.slice(0, MAX_RENDER);
  const lines = shown.map((m) => msgLine(m, withDate, userName));
  const more = msgs.length > shown.length ? `\n… ${msgs.length - shown.length} more not shown (cap ${MAX_RENDER})` : "";
  return `${header}\n${"-".repeat(Math.min(header.length, 60))}\n${lines.join("\n")}${more}`;
}

/** search.messages matches, each with its channel label and permalink. */
export function matchLine(m, chanLabel, userName) {
  const who = m.user ? userName(m.user) : m.username ?? "?";
  return `[${tsToDate(m.ts)}] ${chanLabel}  ${who}: ${renderText(m.text ?? "", userName)}\n    ${m.permalink ?? ""}`;
}

/** Plan of intercepted writes, without credentials. */
export function dryRunText(previewLines, planned) {
  const out = ["DRY RUN: nothing was sent to Slack.", "", ...previewLines, "", "Requests that would be sent:"];
  for (const r of planned) {
    if (r.kind === "upload") out.push(`  POST ${r.url}  (${fmtSize(r.bytes)} raw bytes of ${r.file})`);
    else out.push(`  POST ${r.method} ${JSON.stringify(r.params)}`);
  }
  return out.join("\n");
}
