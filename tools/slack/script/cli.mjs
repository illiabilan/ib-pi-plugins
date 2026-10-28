import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Client, SlackError, failed, loadCreds } from "./client.mjs";
import { Session } from "./session.mjs";
import { MAX_RENDER, collectUserIds, dryRunText, fmtSize, matchLine, messagesText, parsePermalink, tsToDate } from "./format.mjs";
import { MAX_DOWNLOAD_BYTES, describeFile, expandPath, readForUpload, safeName, saveBuffer } from "./files.mjs";

/** Superset of every flag. Each command declares which subset it accepts (typos fail loudly). */
const OPTION_TYPES = {
  limit: { type: "string" },
  oldest: { type: "string" },
  out: { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  stdin: { type: "boolean" },
  ts: { type: "string" },
  title: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const GLOBAL_OPTS = ["json", "dry-run", "help"];
const TEXT_OPTS = ["text", "text-file", "stdin"];

const usageErr = (m) => new SlackError(m, { code: "usage" });
const need = (v, what) => {
  if (v === undefined || v === "") throw usageErr(`Missing ${what}.`);
  return v;
};
const TS_RE = /^\d+\.\d+$/;
const needTs = (v, what = "message ts") => {
  need(v, what);
  if (!TS_RE.test(v)) throw usageErr(`Invalid ${what} "${v}": expected a Slack timestamp like 1700000000.123456.`);
  return v;
};

/** --limit, clamped to 1..MAX_RENDER (default 30). */
function limitFlag(v) {
  if (v.limit === undefined) return 30;
  const n = Number(v.limit);
  if (!Number.isInteger(n) || n < 1) throw usageErr(`--limit must be a positive integer, got "${v.limit}".`);
  return Math.min(n, MAX_RENDER);
}

/** Message text from positionals, --text, --text-file or --stdin (exactly one; undefined if none). */
function readText(v, positional = []) {
  const sources = [];
  if (positional.length) sources.push(["positional text", () => positional.join(" ")]);
  if (v.text !== undefined) sources.push(["--text", () => v.text]);
  if (v["text-file"] !== undefined) sources.push(["--text-file", () => readFileSync(expandPath(v["text-file"]), "utf8")]);
  if (v.stdin) sources.push(["--stdin", () => readFileSync(0, "utf8")]);
  if (sources.length > 1) throw usageErr(`Give the text only once (got ${sources.map((s) => s[0]).join(" and ")}).`);
  return sources[0]?.[1]();
}

async function channelOrFail(s, ref) {
  const chan = await s.resolveChannel(need(ref, "channel (id or #name)"));
  if (!chan) throw new SlackError(`Channel not found: ${ref}`, { code: "not_found" });
  return chan;
}

async function renderMessages(s, header, msgs, withDate) {
  await s.resolveUsers(collectUserIds(msgs.slice(0, MAX_RENDER)));
  return messagesText(header, msgs, withDate, (id) => s.userName(id));
}

async function renderMatches(s, matches) {
  await s.resolveUsers(collectUserIds(matches));
  const lines = [];
  for (const m of matches) {
    const chan = m.channel?.name ? `#${m.channel.name}` : m.channel?.id ? await s.channelLabel(m.channel.id) : "?";
    lines.push(matchLine(m, chan, (id) => s.userName(id)));
  }
  return lines.join("\n");
}

function mentionPreview(mentions) {
  const lines = [];
  if (mentions.linked.length)
    lines.push(`Mentions: ${mentions.linked.length} linked (these people/channels WILL be notified)`, ...mentions.linked.map((m) => `  ${m.raw} -> ${m.code}  ${m.label}`));
  if (mentions.unresolved.length) lines.push(`Not linked (posted as plain text, nobody notified): ${mentions.unresolved.join(", ")}`);
  if (lines.length) lines.push("");
  return lines;
}

const notLinkedNote = (m) => (m.unresolved.length ? `\nNot linked (plain text, nobody notified): ${m.unresolved.join(", ")}` : "");

/** post and reply share everything except thread_ts. */
async function postMessage({ s, client }, { channelRef, threadTs, text, isReply }) {
  const chan = await channelOrFail(s, channelRef);
  // `@ostap` in prose notifies nobody; Slack needs <@U…>. Rewrite before sending and show the
  // result in the preview so the user sees who gets pinged.
  const mentions = await s.linkMentions(text, chan);
  const args = { channel: chan, text: mentions.text };
  if (isReply) args.thread_ts = threadTs;
  const preview = [
    `Channel:  ${channelRef} (${chan})`,
    isReply ? `Thread:   reply under ${threadTs}` : "Post:     new message in channel",
    "Sent as:  YOU (your Slack identity)",
    "",
    ...mentionPreview(mentions),
    `Text as it will be sent (${mentions.text.length} chars):`,
    "----------------------------------------",
    mentions.text.slice(0, 3500),
    "----------------------------------------",
  ];
  const note = isReply ? "Reply posted" : "Message posted";
  const r = await client.call("chat.postMessage", args);
  if (!r.ok) throw new SlackError(`${note} FAILED, nothing changed. ${failed("chat.postMessage", r).message}`, { code: "api", slackError: r.error });
  return {
    preview,
    data: { ok: true, channel: chan, ts: r.ts, thread_ts: args.thread_ts, text: mentions.text, linked: mentions.linked, unresolved: mentions.unresolved },
    text: `${note}.\nts ${r.ts ?? "?"} in ${channelRef}${notLinkedNote(mentions)}`,
  };
}

/* ------------------------------------------------------------------ commands */

const COMMANDS = {
  whoami: {
    usage: "whoami",
    desc: "Verify auth and show the logged-in identity.",
    opts: [],
    async run({ client, creds }) {
      const r = await client.call("auth.test", {});
      if (!r.ok) throw failed("auth.test", r);
      const ws = creds.workspace ? `\nSLACK_WORKSPACE: ${creds.workspace}` : "";
      return { data: r, text: `Authenticated as ${r.user} (${r.user_id}) on ${r.team} — ${r.url}${ws}` };
    },
  },

  resolve: {
    usage: "resolve <permalink>",
    desc: "Turn a pasted message/thread permalink into the whole thread as readable text (authors by name, files, reactions). Falls back to the single message when it is not a thread.",
    opts: [],
    async run({ client, s, pos }) {
      const link = need(pos[0], "permalink");
      const p = parsePermalink(link);
      if (!p) throw usageErr(`Could not parse that as a Slack permalink. Expected .../archives/CXXXX/p1700000000123456. Got: ${link}`);
      const root = p.thread_ts ?? p.ts;
      const r = await client.call("conversations.replies", { channel: p.channel, ts: root, limit: 100 });
      if (!r.ok) {
        // Not a thread: fetch the single message via history around its ts.
        const h = await client.call("conversations.history", { channel: p.channel, latest: p.ts, inclusive: true, limit: 1 });
        if (!h.ok) throw failed("conversations.replies/history", h);
        const label = await s.channelLabel(p.channel);
        const msgs = h.messages ?? [];
        return { data: { channel: p.channel, label, thread: false, messages: msgs }, text: await renderMessages(s, `${label}  single message  ${tsToDate(p.ts)}`, msgs, true) };
      }
      const msgs = r.messages ?? [];
      const label = await s.channelLabel(p.channel);
      const hdr = `${label}  thread ${tsToDate(root)}  (${msgs.length} message${msgs.length === 1 ? "" : "s"})`;
      return { data: { channel: p.channel, label, thread: true, thread_ts: root, messages: msgs }, text: await renderMessages(s, hdr, msgs, false) };
    },
  },

  history: {
    usage: "history <channel> [--limit N] [--oldest <ts|ISO date>]",
    desc: "Recent messages in a channel or DM, oldest first (default 30, max 60). <channel> is an id (C…/D…/G…) or #name.",
    opts: ["limit", "oldest"],
    async run({ client, s, pos, v }) {
      const lim = limitFlag(v);
      let oldest;
      if (v.oldest !== undefined) {
        if (/^\d+(\.\d+)?$/.test(v.oldest)) oldest = v.oldest;
        else {
          const t = new Date(v.oldest).getTime();
          if (Number.isNaN(t)) throw usageErr(`Invalid --oldest "${v.oldest}". Use a Slack ts or an ISO date (2026-10-01).`);
          oldest = String(Math.floor(t / 1000));
        }
      }
      const chan = await channelOrFail(s, pos[0]);
      const r = await client.call("conversations.history", { channel: chan, limit: lim, oldest });
      if (!r.ok) throw failed("conversations.history", r);
      const msgs = (r.messages ?? []).slice().reverse(); // API returns newest-first
      const label = await s.channelLabel(chan);
      return { data: { channel: chan, label, messages: msgs }, text: await renderMessages(s, `${label}  last ${msgs.length}`, msgs, true) };
    },
  },

  thread: {
    usage: "thread <channel> <ts>",
    desc: "The replies under a root message (use `resolve` when you have a permalink).",
    opts: [],
    async run({ client, s, pos }) {
      const ts = needTs(pos[1], "root message ts");
      const chan = await channelOrFail(s, pos[0]);
      const r = await client.call("conversations.replies", { channel: chan, ts, limit: 100 });
      if (!r.ok) throw failed("conversations.replies", r);
      const msgs = r.messages ?? [];
      const label = await s.channelLabel(chan);
      return { data: { channel: chan, label, thread_ts: ts, messages: msgs }, text: await renderMessages(s, `${label}  thread ${tsToDate(ts)}  (${msgs.length})`, msgs, false) };
    },
  },

  search: {
    usage: "search <query> [--limit N]",
    desc: 'Slack message search, newest first. Operators work: from:@ana in:#api after:2026-06-01 "deploy failed".',
    opts: ["limit"],
    async run({ client, s, pos, v }) {
      const query = need(pos.join(" ").trim(), "search query");
      const lim = limitFlag(v);
      const r = await client.call("search.messages", { query, count: lim, sort: "timestamp" });
      if (!r.ok) throw failed("search.messages", r);
      const matches = r.messages?.matches ?? [];
      const total = r.messages?.total ?? matches.length;
      const rendered = await renderMatches(s, matches);
      return { data: r.messages ?? { matches: [] }, text: `search "${query}" — ${total} hits, showing ${matches.length}\n${"-".repeat(40)}\n${rendered}` };
    },
  },

  channels: {
    usage: "channels [name-filter] [--limit N]",
    desc: "List channels you can see (public and private), largest first, optionally filtered by name.",
    opts: ["limit"],
    async run({ client, pos, v }) {
      const lim = limitFlag(v);
      const query = pos.join(" ").trim();
      const r = await client.call("conversations.list", { limit: 1000, exclude_archived: true, types: "public_channel,private_channel" });
      if (!r.ok) throw failed("conversations.list", r);
      let chans = r.channels ?? [];
      if (query) {
        const q = query.replace(/^#/, "").toLowerCase();
        chans = chans.filter((c) => c.name?.toLowerCase().includes(q));
      }
      chans.sort((a, b) => (b.num_members ?? 0) - (a.num_members ?? 0));
      const shown = chans.slice(0, Math.max(lim, 30));
      const lines = shown.map((c) => `#${c.name}  ${c.id}${c.is_private ? "  (private)" : ""}  ${c.num_members ?? "?"} members`);
      return { data: shown, text: `${chans.length} channels${query ? ` matching "${query}"` : ""}\n${lines.join("\n")}` };
    },
  },

  users: {
    usage: "users [filter] [--limit N]",
    desc: "List or look up people (first 500 of users.list; matches handle, real name, display name, email).",
    opts: ["limit"],
    async run({ client, pos, v }) {
      const lim = limitFlag(v);
      const query = pos.join(" ").trim();
      const r = await client.call("users.list", { limit: 500 });
      if (!r.ok) throw failed("users.list", r);
      let members = (r.members ?? []).filter((u) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT");
      if (query) {
        const q = query.replace(/^@/, "").toLowerCase();
        members = members.filter((u) => [u.name, u.real_name, u.profile?.display_name, u.profile?.email].some((x) => x?.toLowerCase().includes(q)));
      }
      const shown = members.slice(0, Math.max(lim, 30));
      const lines = shown.map((u) => `${u.profile?.display_name || u.real_name || u.name}  @${u.name}  ${u.id}`);
      return { data: shown, text: `${members.length} users${query ? ` matching "${query}"` : ""}\n${lines.join("\n")}` };
    },
  },

  mentions: {
    usage: "mentions [--limit N]",
    desc: "Recent messages that @-mention you.",
    opts: ["limit"],
    async run({ client, s, v }) {
      const lim = limitFlag(v);
      const me = await client.call("auth.test", {});
      if (!me.ok) throw failed("auth.test", me);
      const r = await client.call("search.messages", { query: `to:@${me.user} OR <@${me.user_id}>`, count: lim, sort: "timestamp" });
      if (!r.ok) throw failed("search.messages", r);
      const matches = r.messages?.matches ?? [];
      const rendered = await renderMatches(s, matches);
      return { data: r.messages ?? { matches: [] }, text: `recent mentions of @${me.user}${matches.length ? "" : " (none found)"}\n${"-".repeat(40)}\n${rendered}` };
    },
  },

  download: {
    usage: "download <file-id|url> [--out dir]",
    desc: "Download an attachment (photo, video, document) by file id (the [F…] shown next to 📎) or files.slack.com URL. Saves to --out or a temp dir and prints the path; then Read it.",
    opts: ["out"],
    async run({ client, pos, v }) {
      const ref = need(pos[0], "file id or URL").trim();
      let url = ref;
      let name = "";
      let mime;
      if (!/^https?:/i.test(url)) {
        if (!/^F[A-Z0-9]+$/.test(url)) throw usageErr(`Not a Slack file id or URL: ${url}`);
        const info = await client.call("files.info", { file: url });
        if (!info.ok) throw failed("files.info", info);
        const f = info.file ?? {};
        url = f.url_private_download || f.url_private;
        if (!url) throw new SlackError(`File ${ref} has no downloadable URL (external/hosted elsewhere? permalink: ${f.permalink ?? "?"}).`, { code: "not_found" });
        name = f.name || f.title || ref;
        mime = f.mimetype;
      }
      const got = await client.fetchFile(url, MAX_DOWNLOAD_BYTES);
      if (!name) {
        const last = new URL(url).pathname.split("/").pop() || "file";
        try {
          name = decodeURIComponent(last);
        } catch {
          name = last;
        }
      }
      const type = mime || got.contentType.split(";")[0];
      const saved = saveBuffer(got.buf, safeName(name), v.out);
      const d = describeFile(saved, name, type, got.buf.length);
      return { data: { path: saved, name, mimetype: type, size: got.buf.length, kind: d.kind }, text: d.text };
    },
  },

  /* ------------------------------------------------------------------ writes */

  post: {
    usage: "post <channel> <text> | post <channel> (--text T | --text-file F | --stdin)",
    desc: "Post a new message as you. @name, @\"Full Name\", @here, @group and #channel in the text become real mentions.",
    opts: TEXT_OPTS,
    write: true,
    async run(ctx) {
      const { pos, v } = ctx;
      const channelRef = need(pos[0], "channel (id or #name)");
      const text = need(readText(v, pos.slice(1)), "message text");
      return postMessage(ctx, { channelRef, text, isReply: false });
    },
  },

  reply: {
    usage: "reply <channel> <thread-ts> <text> | reply <permalink> <text>   (or --text / --text-file / --stdin)",
    desc: "Reply in a thread as you. With a permalink, the reply goes into the thread that message belongs to.",
    opts: TEXT_OPTS,
    write: true,
    async run(ctx) {
      const { pos, v } = ctx;
      const first = need(pos[0], "channel or permalink");
      const p = parsePermalink(first);
      const channelRef = p ? p.channel : first;
      const threadTs = p ? p.thread_ts ?? p.ts : needTs(pos[1], "thread root ts");
      const text = need(readText(v, pos.slice(p ? 1 : 2)), "message text");
      return postMessage(ctx, { channelRef, threadTs, text, isReply: true });
    },
  },

  react: {
    usage: "react <channel> <ts> <emoji> | react <permalink> <emoji>",
    desc: "Add an emoji reaction (name without colons, e.g. thumbsup) to a message.",
    opts: [],
    write: true,
    async run({ client, s, pos }) {
      const first = need(pos[0], "channel or permalink");
      const p = parsePermalink(first);
      const channelRef = p ? p.channel : first;
      const ts = p ? p.ts : needTs(pos[1], "message ts");
      const emoji = need(pos[p ? 1 : 2], "emoji name").replace(/:/g, "");
      if (!emoji) throw usageErr("Missing emoji name.");
      const chan = await channelOrFail(s, channelRef);
      const preview = [`React :${emoji}: on message ${ts} in ${channelRef} (${chan}).`];
      const r = await client.call("reactions.add", { channel: chan, timestamp: ts, name: emoji });
      if (!r.ok) throw new SlackError(`Reacted :${emoji}: FAILED, nothing changed. ${failed("reactions.add", r).message}`, { code: "api", slackError: r.error });
      return { preview, data: { ok: true, channel: chan, ts, emoji }, text: `Reacted :${emoji}:.\non ${ts} in ${channelRef}` };
    },
  },

  upload: {
    usage: "upload <channel> <path> [--ts <thread-ts>] [--title T] [--text T | --text-file F | --stdin]",
    desc: "Upload a local file to a channel (or into a thread with --ts), optionally with a comment (mentions are linked like post).",
    opts: ["ts", "title", ...TEXT_OPTS],
    write: true,
    async run({ client, s, pos, v }) {
      const channelRef = need(pos[0], "channel (id or #name)");
      const f = readForUpload(need(pos[1], "file path"));
      if (f.error) throw new SlackError(f.error, { code: "usage" });
      if (pos.length > 2) throw usageErr("upload takes <channel> <path>; pass the comment with --text, --text-file or --stdin.");
      if (v.ts !== undefined) needTs(v.ts, "--ts");
      const chan = await channelOrFail(s, channelRef);
      const raw = readText(v);
      const mentions = raw ? await s.linkMentions(raw, chan) : { text: undefined, linked: [], unresolved: [] };
      const comment = mentions.text;
      const preview = [
        `Upload:   ${f.path} (${fmtSize(f.buf.length)})`,
        `Channel:  ${channelRef} (${chan})`,
        v.ts ? `Thread:   under ${v.ts}` : "Post:     new message in channel",
        "Sent as:  YOU (your Slack identity)",
        ...(comment ? ["", ...mentionPreview(mentions), "Comment:", comment.slice(0, 1500)] : []),
      ];
      const g = await client.call("files.getUploadURLExternal", { filename: f.name, length: f.buf.length });
      if (!g.ok) throw new SlackError(`File upload FAILED, nothing changed. ${failed("files.getUploadURLExternal", g).message}`, { code: "api", slackError: g.error });
      await client.uploadBytes(g.upload_url, f.buf, f.path);
      const c = await client.call("files.completeUploadExternal", {
        files: JSON.stringify([{ id: g.file_id, title: v.title || f.name }]),
        channel_id: chan,
        thread_ts: v.ts,
        initial_comment: comment,
      });
      if (!c.ok) throw new SlackError(`File upload FAILED. ${failed("files.completeUploadExternal", c).message}`, { code: "api", slackError: c.error });
      const permalink = c.files?.[0]?.permalink;
      return {
        preview,
        data: { ok: true, file_id: g.file_id, permalink, channel: chan, thread_ts: v.ts },
        text: `File uploaded.\nfile ${g.file_id}${permalink ? ` ${permalink}` : ""} in ${channelRef}${notLinkedNote(mentions)}`,
      };
    },
  },
};

/* ------------------------------------------------------------------ help */

function helpText(cmdName) {
  if (cmdName && COMMANDS[cmdName]) {
    const c = COMMANDS[cmdName];
    return `${c.desc}\n\nUsage: slack ${c.usage}\nFlags valid for every command: --json, --dry-run${c.write ? "" : " (writes only)"}, --help`;
  }
  const rows = Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.desc}`);
  return [
    "slack: Slack from the terminal, acting as YOU via browser client tokens (sees every channel, DM and search result you can).",
    "",
    "Auth: SLACK_TOKEN (xoxc-...) and SLACK_COOKIE (xoxd-..., the `d` cookie), both required. Optional: SLACK_WORKSPACE.",
    "Overrides (tests): SLACK_API_BASE, SLACK_EDGE_BASE. Cache: $XDG_CACHE_HOME/slack-cli (default ~/.cache/slack-cli).",
    "Output: compact text by default, --json for raw data. Errors go to stderr, exit code 1 (2 for usage errors).",
    "Writes (post, reply, react, upload) support --dry-run: names and mentions are resolved with read calls, the exact",
    "payload is printed, and nothing is sent. Message times are UTC; `ts` values feed thread/reply/react.",
    "Values starting with '-' must use --flag=value; a positional starting with '-' goes after '--' with the command words:",
    '  slack -- post "#general" "- first item"',
    "",
    "Commands:",
    ...rows,
  ].join("\n");
}

/* ------------------------------------------------------------------ main */

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl, maxRetryWaitS } = {}) {
  const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const err = (s) => stderr.write(s.endsWith("\n") ? s : `${s}\n`);
  let json = argv.includes("--json");
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTION_TYPES, allowPositionals: true, strict: true });
    } catch (e) {
      throw usageErr(`${e.message}\nRun "slack --help" for usage.`);
    }
    const { values: v, positionals } = parsed;
    json = !!v.json;
    if (!positionals.length) {
      out(helpText());
      return 0;
    }
    const name = COMMANDS[positionals[0]] ? positionals[0] : null;
    if (!name) {
      const known = Object.keys(COMMANDS).filter((k) => k.startsWith(positionals[0].slice(0, 2)));
      throw usageErr(`Unknown command "${positionals[0]}".${known.length ? ` Did you mean: ${known.join(", ")}?` : ""}\nRun "slack --help".`);
    }
    if (v.help) {
      out(helpText(name));
      return 0;
    }
    const cmd = COMMANDS[name];
    const allowed = new Set([...cmd.opts, ...GLOBAL_OPTS]);
    const extra = Object.keys(v).filter((k) => !allowed.has(k));
    if (extra.length) throw usageErr(`Flag(s) not valid for "${name}": ${extra.map((k) => `--${k}`).join(", ")}.\nUsage: slack ${cmd.usage}`);
    const pos = positionals.slice(1);

    const creds = loadCreds(env);
    const client = new Client(creds, { base: env.SLACK_API_BASE, edgeBase: env.SLACK_EDGE_BASE, dryRun: !!v["dry-run"], fetchImpl, maxRetryWaitS });
    const s = new Session(client, env);
    const result = await cmd.run({ client, s, pos, v, env, creds });

    if (v["dry-run"] && client.planned.length) {
      out(json ? JSON.stringify({ dryRun: true, preview: result.preview ?? [], requests: client.planned }) : dryRunText(result.preview ?? [], client.planned));
    } else if (v["dry-run"]) {
      out(json ? JSON.stringify({ dryRun: true, requests: [], note: "read-only command, executed normally", data: result.data }) : result.text);
    } else {
      out(json ? JSON.stringify(result.data) : result.text);
    }
    return 0;
  } catch (e) {
    const message = e?.message ?? String(e);
    err(json ? JSON.stringify({ error: message, code: e?.code, slack_error: e?.slackError }) : `Error: ${message}`);
    return e?.code === "usage" ? 2 : 1;
  }
}
