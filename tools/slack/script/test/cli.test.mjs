import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.mjs";
import { Client } from "../client.mjs";
import { parsePermalink, renderText } from "../format.mjs";

/** In-process fake Slack (Web API + edge API + file host). Records every request. */
let server;
let base;
let log = [];
let rateLimitOnce = false;

const MSGS = [
  { user: "U001", ts: "1700000000.000100", text: "Crash on <#C100|backend> cc <@U002>", reply_count: 2, files: [{ id: "F1", name: "note.txt", mimetype: "text/plain", size: 2048 }] },
  { user: "U002", ts: "1700000060.000200", text: "Looking &amp; fixing", reactions: [{ name: "eyes", count: 2 }] },
];
const USERS = {
  U001: { id: "U001", name: "ostap", profile: { display_name: "ostap", real_name: "Ostap Bender" } },
  U002: { id: "U002", name: "ana", profile: { display_name: "Ana Silva", real_name: "Ana Silva" } },
  U003: { id: "U003", name: "chris", profile: { display_name: "", real_name: "Chris" } },
};

function api(method, f) {
  if (f.token === "BAD") return { ok: false, error: "invalid_auth" };
  switch (method) {
    case "auth.test":
      return { ok: true, user: "me", user_id: "U0ME", team: "Acme", url: "https://acme.slack.com/", team_id: "T1" };
    case "conversations.list":
      return { ok: true, channels: [{ id: "C100", name: "backend", num_members: 5 }, { id: "C101", name: "api-team", is_private: true, num_members: 9 }] };
    case "conversations.info":
      if (f.channel === "D200") return { ok: true, channel: { id: "D200", is_im: true, user: "U002" } };
      return { ok: true, channel: { id: f.channel, name: f.channel === "C100" ? "backend" : "api-team" } };
    case "users.info":
      if (f.users) return { ok: true, users: f.users.split(",").map((id) => USERS[id]).filter(Boolean) };
      return USERS[f.user] ? { ok: true, user: USERS[f.user] } : { ok: false, error: "user_not_found" };
    case "conversations.replies":
      return f.ts === "1700000000.000100" ? { ok: true, messages: MSGS } : { ok: false, error: "thread_not_found" };
    case "conversations.history":
      return { ok: true, messages: [...MSGS].reverse() };
    case "search.messages":
      return { ok: true, messages: { total: 7, matches: [{ ...MSGS[0], channel: { id: "C100", name: "backend" }, permalink: "https://acme.slack.com/archives/C100/p1700000000000100" }] } };
    case "users.list":
      return { ok: true, members: [...Object.values(USERS), { id: "USLACKBOT", name: "slackbot" }, { id: "U9", name: "gone", deleted: true }] };
    case "conversations.members":
      return { ok: true, members: ["U001", "U002", "U003"] };
    case "usergroups.list":
      return { ok: true, usergroups: [{ id: "S900", handle: "design", name: "Design Team" }] };
    case "chat.postMessage":
      return { ok: true, ts: "1700000099.000100" };
    case "reactions.add":
      return { ok: true };
    case "files.info":
      if (f.file === "F1") return { ok: true, file: { name: "note.txt", mimetype: "text/plain", url_private_download: `${base}/files/note.txt` } };
      if (f.file === "F2") return { ok: true, file: { name: "x.png", url_private_download: "https://evil.example.com/x.png" } };
      if (f.file === "F3") return { ok: true, file: { name: "y.png", url_private_download: `${base}/redirect` } };
      return { ok: false, error: "file_not_found" };
    case "files.getUploadURLExternal":
      return { ok: true, upload_url: `${base}/upload/abc`, file_id: "F9" };
    case "files.completeUploadExternal":
      return { ok: true, files: [{ id: "F9", permalink: "https://acme.slack.com/files/U0ME/F9/hello.txt" }] };
    default:
      return { ok: false, error: "unknown_method" };
  }
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const ctype = req.headers["content-type"] ?? "";
    const form = ctype.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw.toString())) : undefined;
    const jbody = ctype.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    log.push({ method: req.method, path: url.pathname, form, jbody, raw: raw.toString(), cookie: req.headers.cookie, auth: req.headers.authorization, rawUrl: req.url });
    if (rateLimitOnce) {
      rateLimitOnce = false;
      return void res.writeHead(429, { "retry-after": "0" }).end("slow down");
    }
    const send = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (url.pathname.startsWith("/api/")) return void send(api(url.pathname.slice(5), form ?? {}));
    if (url.pathname === "/edge/cache/T1/users/search") {
      const hit = Object.values(USERS).filter((u) => u.name === jbody?.query);
      return void send({ ok: true, results: hit });
    }
    if (url.pathname === "/files/note.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("hello file\n");
    if (url.pathname === "/redirect") return void res.writeHead(302, { location: "https://evil.example.com/stolen" }).end();
    if (url.pathname === "/upload/abc") return void res.writeHead(200).end("OK");
    res.writeHead(404).end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ENV = (extra = {}) => ({
  SLACK_TOKEN: "xoxc-SECRET",
  SLACK_COOKIE: "d=xoxd-COOKIE; other=1",
  SLACK_API_BASE: `${base}/api`,
  SLACK_EDGE_BASE: `${base}/edge`,
  XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "slack-cache-")),
  ...extra,
});

async function run(args, env = ENV()) {
  let o = "";
  let e = "";
  log = [];
  const code = await main(args, { env, stdout: { write: (s) => (o += s) }, stderr: { write: (s) => (e += s) }, maxRetryWaitS: 0 });
  return { code, out: o.trimEnd(), err: e.trimEnd() };
}
const apiCalls = (m) => log.filter((r) => r.path === `/api/${m}`);
const WRITE = ["chat.postMessage", "reactions.add", "files.getUploadURLExternal", "files.completeUploadExternal"];
const writes = () => log.filter((r) => WRITE.some((m) => r.path === `/api/${m}`) || r.path.startsWith("/upload"));

test("token goes in the form body, cookie in the header, never in a URL", async () => {
  const r = await run(["whoami"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Authenticated as me \(U0ME\) on Acme/);
  assert.equal(log[0].form.token, "xoxc-SECRET");
  assert.equal(log[0].cookie, "d=xoxd-COOKIE");
  assert.ok(!log.some((x) => x.rawUrl.includes("SECRET") || x.rawUrl.includes("COOKIE")));
});

test("missing credentials: exit 1 with setup instructions, no request sent", async () => {
  const r = await run(["whoami"], { SLACK_API_BASE: `${base}/api` });
  assert.equal(r.code, 1);
  assert.match(r.err, /SLACK_TOKEN/);
  assert.match(r.err, /SLACK_COOKIE/);
  assert.equal(log.length, 0);
});

test("invalid_auth: exit 1 with re-copy hint, token not echoed; --json error is structured", async () => {
  const r = await run(["whoami"], ENV({ SLACK_TOKEN: "BAD" }));
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid_auth.*Re-copy/);
  const j = await run(["whoami", "--json"], ENV({ SLACK_TOKEN: "BAD" }));
  const e = JSON.parse(j.err);
  assert.equal(e.code, "auth");
  assert.equal(e.slack_error, "invalid_auth");
  assert.ok(!j.err.includes("BAD") && !r.err.includes("BAD"));
});

test("resolve: thread permalink renders names, files, reactions, replies and ts", async () => {
  const r = await run(["resolve", "https://acme.slack.com/archives/C100/p1700000060000200?thread_ts=1700000000.000100&cid=C100"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^#backend {2}thread 2023-11-14 22:13 {2}\(2 messages\)/);
  assert.match(r.out, /\[22:13 ts 1700000000.000100\] ostap: Crash on #backend cc @Ana Silva/);
  assert.match(r.out, /📎 note.txt \[F1, text\/plain, 2.0 KB\]/);
  assert.match(r.out, /↳ 2 replies/);
  assert.match(r.out, /Ana Silva: Looking & fixing\n {4}:eyes:×2/);
  assert.equal(apiCalls("conversations.replies")[0].form.ts, "1700000000.000100");
});

test("resolve: non-thread message falls back to history; bad link is a usage error", async () => {
  const r = await run(["resolve", "https://acme.slack.com/archives/C100/p1700000001000200"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /single message/);
  assert.deepEqual({ ...apiCalls("conversations.history")[0].form, token: undefined }, { token: undefined, channel: "C100", latest: "1700000001.000200", inclusive: "true", limit: "1" });
  const bad = await run(["resolve", "https://example.com/nope"]);
  assert.equal(bad.code, 2);
});

test("history resolves #name, converts an ISO --oldest, prints oldest first", async () => {
  const r = await run(["history", "#api-team", "--limit", "5", "--oldest", "2023-11-14"]);
  assert.equal(r.code, 0, r.err);
  const h = apiCalls("conversations.history")[0].form;
  assert.equal(h.channel, "C101");
  assert.equal(h.limit, "5");
  assert.equal(h.oldest, String(Date.parse("2023-11-14") / 1000));
  assert.ok(r.out.indexOf("ostap:") < r.out.indexOf("Ana Silva:"));
  assert.equal((await run(["history", "#nope"])).code, 1);
  assert.equal((await run(["history", "C100", "--oldest", "yesterday"])).code, 2);
});

test("DM channel label resolves to the other user", async () => {
  const r = await run(["history", "D200"]);
  assert.match(r.out, /^@Ana Silva \(DM\)/);
});

test("search and mentions render channel and permalink", async () => {
  const s = await run(["search", "from:@ostap", "crash", "--limit", "3"]);
  assert.equal(s.code, 0, s.err);
  assert.equal(apiCalls("search.messages")[0].form.query, "from:@ostap crash");
  assert.equal(apiCalls("search.messages")[0].form.count, "3");
  assert.match(s.out, /— 7 hits, showing 1/);
  assert.match(s.out, /#backend {2}ostap: Crash/);
  assert.match(s.out, /https:\/\/acme.slack.com\/archives\/C100\/p1700000000000100/);
  const m = await run(["mentions"]);
  assert.equal(apiCalls("search.messages")[0].form.query, "to:@me OR <@U0ME>");
  assert.match(m.out, /recent mentions of @me/);
});

test("channels and users list and filter", async () => {
  const c = await run(["channels", "api"]);
  assert.match(c.out, /1 channels matching "api"\n#api-team {2}C101 {2}\(private\) {2}9 members/);
  const u = await run(["users", "silva"]);
  assert.match(u.out, /1 users matching "silva"\nAna Silva {2}@ana {2}U002/);
  const all = await run(["users", "--json"]);
  assert.deepEqual(JSON.parse(all.out).map((x) => x.id), ["U001", "U002", "U003"]);
});

test("post --dry-run resolves mentions, prints the exact payload, sends nothing", async () => {
  const r = await run(["post", "#backend", "hey @ostap and @design, see #api-team. ping @nobody", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(writes().length, 0);
  assert.match(r.out, /DRY RUN: nothing was sent/);
  assert.match(r.out, /@ostap -> <@U001> {2}ostap/);
  assert.match(r.out, /@design -> <!subteam\^S900>/);
  assert.match(r.out, /#api-team -> <#C101>/);
  assert.match(r.out, /Not linked \(posted as plain text, nobody notified\): @nobody/);
  assert.match(r.out, /POST chat.postMessage \{"channel":"C100","text":"hey <@U001> and <!subteam\^S900>, see <#C101>. ping @nobody"\}/);
  assert.ok(!r.out.includes("xoxc-SECRET"));
  // edge search got the token in the JSON body, the cookie in the header
  const edge = log.find((x) => x.path.startsWith("/edge/"));
  assert.equal(edge.jbody.token, "xoxc-SECRET");
  assert.equal(edge.cookie, "d=xoxd-COOKIE");
});

test("post sends chat.postMessage with linked text; --json returns the ts", async () => {
  const r = await run(["post", "C100", "hi @here", "--json"]);
  assert.equal(r.code, 0, r.err);
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].form.text, "hi <!here>");
  assert.equal(w[0].form.channel, "C100");
  assert.equal(JSON.parse(r.out).ts, "1700000099.000100");
});

test("reply via permalink posts into the thread; text from --text-file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-t-"));
  writeFileSync(join(dir, "msg.txt"), "- fixed in 4.2");
  const r = await run(["reply", "https://acme.slack.com/archives/C100/p1700000060000200?thread_ts=1700000000.000100&cid=C100", "--text-file", join(dir, "msg.txt")]);
  assert.equal(r.code, 0, r.err);
  const w = writes()[0].form;
  assert.equal(w.thread_ts, "1700000000.000100");
  assert.equal(w.text, "- fixed in 4.2");
  assert.match(r.out, /Reply posted\.\nts 1700000099.000100 in C100/);
  assert.equal((await run(["reply", "C100", "notats", "x"])).code, 2);
  assert.equal((await run(["reply", "C100", "1700000000.000100", "a", "--text", "b"])).code, 2);
});

test("react: dry-run sends nothing; real call strips colons", async () => {
  const d = await run(["react", "#backend", "1700000000.000100", ":thumbsup:", "--dry-run"]);
  assert.equal(d.code, 0, d.err);
  assert.equal(writes().length, 0);
  assert.match(d.out, /React :thumbsup: on message 1700000000.000100 in #backend \(C100\)/);
  const r = await run(["react", "https://acme.slack.com/archives/C100/p1700000060000200", "eyes"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual({ ...writes()[0].form, token: undefined }, { token: undefined, channel: "C100", timestamp: "1700000060.000200", name: "eyes" });
});

test("upload: dry-run plans all three steps; real run sends bytes without credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-t-"));
  const f = join(dir, "hello.txt");
  writeFileSync(f, "hello upload");
  const d = await run(["upload", "#backend", f, "--ts", "1700000000.000100", "--text", "for @ana", "--dry-run"]);
  assert.equal(d.code, 0, d.err);
  assert.equal(writes().length, 0);
  assert.match(d.out, /POST files.getUploadURLExternal \{"filename":"hello.txt","length":12\}/);
  assert.match(d.out, /POST <upload_url from files.getUploadURLExternal> {2}\(12 B raw bytes/);
  assert.match(d.out, /"initial_comment":"for <@U002>"/);

  const r = await run(["upload", "C100", f, "--title", "Greeting"]);
  assert.equal(r.code, 0, r.err);
  const up = log.find((x) => x.path === "/upload/abc");
  assert.equal(up.raw, "hello upload");
  assert.equal(up.cookie, undefined);
  assert.equal(up.auth, undefined);
  const c = apiCalls("files.completeUploadExternal")[0].form;
  assert.equal(c.channel_id, "C100");
  assert.deepEqual(JSON.parse(c.files), [{ id: "F9", title: "Greeting" }]);
  assert.match(r.out, /File uploaded\.\nfile F9 https:\/\/acme.slack.com\/files/);
  assert.equal((await run(["upload", "C100", join(dir, "missing.txt")])).code, 2);
});

test("download by file id saves to --out and prints the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-dl-"));
  const r = await run(["download", "F1", "--out", dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "hello file\n");
  assert.match(r.out, new RegExp(`Saved: ${join(dir, "note.txt").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r.out, /Read tool/);
  const dl = log.find((x) => x.path === "/files/note.txt");
  assert.equal(dl.auth, "Bearer xoxc-SECRET");
  const again = await run(["download", "F1", "--out", dir, "--json"]);
  assert.equal(JSON.parse(again.out).path, join(dir, "note-1.txt"));
});

test("credentials are never sent to a non-Slack host (direct or via redirect)", async () => {
  const r = await run(["download", "F2"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Refusing to send Slack credentials to non-Slack host evil.example.com/);
  const rd = await run(["download", "F3"]);
  assert.equal(rd.code, 1);
  assert.match(rd.err, /non-Slack host evil.example.com/);
  const c = new Client({ token: "t", cookie: "c" });
  assert.equal(c.isTrustedFileUrl("https://files.slack.com/files-pri/T1-F1/x.png"), true);
  assert.equal(c.isTrustedFileUrl("https://files.slack.com.evil.com/x"), false);
  assert.equal(c.isTrustedFileUrl("http://files.slack.com/x"), false);
  assert.throws(() => new Client({ token: "t", cookie: "c" }, { base: "http://example.com/api" }), /must be https/);
});

test("429 is retried", async () => {
  rateLimitOnce = true;
  const r = await run(["whoami"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.length, 2);
});

test("name cache persists in $XDG_CACHE_HOME/slack-cli with 0600", async () => {
  const env = ENV();
  await run(["history", "C100"], env);
  const f = join(env.XDG_CACHE_HOME, "slack-cli", "slack-names.json");
  const cache = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(cache.users.U002, "Ana Silva");
  assert.equal(cache.channels.C100, "#backend");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  await run(["history", "C100"], env);
  assert.equal(apiCalls("users.info").length, 0);
  assert.equal(apiCalls("conversations.info").length, 0);
  // names seen while reading make @mentions linkable without any lookup
  const p = await run(["post", "C100", "thanks @ostap", "--dry-run"], env);
  assert.match(p.out, /<@U001>/);
  assert.equal(log.filter((x) => x.path.startsWith("/edge")).length, 0);
});

test("usage errors: unknown flag, wrong flag for command, unknown command, missing args", async () => {
  assert.equal((await run(["whoami", "--bogus"])).code, 2);
  const wrong = await run(["history", "C100", "--title", "x"]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /not valid for "history"/);
  assert.equal((await run(["histroy"])).code, 2);
  assert.equal((await run(["post", "C100"])).code, 2);
  assert.equal((await run(["thread", "C100"])).code, 2);
  assert.equal(log.length, 0);
});

test("--help: top level and per command", async () => {
  const top = await run(["--help"]);
  assert.equal(top.code, 0);
  assert.match(top.out, /Commands:/);
  const one = await run(["post", "--help"]);
  assert.match(one.out, /Usage: slack post/);
});

test("parsePermalink and renderText", () => {
  assert.deepEqual(parsePermalink("https://x.slack.com/archives/C1/p1700000000123456"), { channel: "C1", ts: "1700000000.123456" });
  assert.deepEqual(parsePermalink("https://x.slack.com/archives/C1/p1700000000123456?thread_ts=1699999999.000001&cid=C2"), { channel: "C2", ts: "1700000000.123456", thread_ts: "1699999999.000001" });
  assert.equal(parsePermalink("nope"), null);
  assert.equal(renderText("<!here> <!subteam^S1|@design> <https://a.io|site> <!date^1^x|today> &lt;b&gt;"), "@here @design site (https://a.io) today <b>");
});
