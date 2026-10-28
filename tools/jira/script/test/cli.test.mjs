import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, issueKey } from "../cli.mjs";
import { Client, loadCreds } from "../client.mjs";

/** In-process fake Jira (+ a second "media" origin for attachment redirects). Records every request. */
let server;
let media;
let base;
let mediaBase;
let log = [];
let mediaLog = [];
let rateLimitOnce = false;

const USER = "me@example.com";
const TOKEN = "SECRET-TOKEN-123";
const BASIC = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;

const ISSUE = {
  key: "PROJ-1",
  names: { customfield_10236: "Steps to Reproduce", customfield_10014: "Epic Link" },
  fields: {
    summary: "Login crashes",
    issuetype: { name: "Bug" },
    status: { name: "To Do" },
    priority: { name: "High" },
    assignee: { displayName: "Alice" },
    reporter: { displayName: "Bob" },
    customfield_10014: "PROJ-900",
    customfield_10236: "1. Open app\n2. Tap login",
    parent: { key: "PROJ-900" },
    created: "2026-01-02T10:00:00.000+0000",
    updated: "2026-02-03T10:00:00.000+0000",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Crashes on cold start" }] }] },
    issuelinks: [{ type: { name: "Blocks", outward: "blocks", inward: "is blocked by" }, outwardIssue: { key: "PROJ-2", fields: { summary: "Release" } } }],
    attachment: [{ id: "10001", filename: "crash.log", mimeType: "text/plain", size: 12, author: { displayName: "Bob" }, created: "2026-01-03T00:00:00.000+0000" }],
  },
};
const TRANSITIONS = [
  { id: "11", name: "Start", to: { name: "In Progress", statusCategory: { name: "In Progress" } } },
  { id: "31", name: "Close", to: { name: "Done", statusCategory: { name: "Done" } } },
];
const mkIssue = (key, summary, cat = "To Do") => ({ key, fields: { summary, status: { name: cat, statusCategory: { name: cat } }, issuetype: { name: "Story" }, created: "2026-01-01T00:00:00.000+0000", issuelinks: [], assignee: null, priority: { name: "Low" }, updated: "2026-01-05T00:00:00.000+0000" } });
const SEARCH_POOL = [
  mkIssue("PROJ-10", "Add promo banner to the cart screen"),
  mkIssue("PROJ-11", "Add promotional banner in cart screen"),
  mkIssue("PROJ-12", "Upgrade Gradle to 8.7"),
];

function route(req, url, body) {
  const p = url.pathname;
  const m = req.method;
  if (m === "GET" && p === "/rest/api/2/myself") return { displayName: "Alice Smith", emailAddress: USER, accountId: "acc1", active: true };
  if (m === "GET" && p === "/rest/api/2/project") return [{ id: "1", key: "PROJ", name: "Project" }, { id: "2", key: "SUBS", name: "Subscriptions" }];
  if (m === "GET" && p === "/rest/api/2/issue/PROJ-1") return url.searchParams.get("fields") ? { key: "PROJ-1", fields: { attachment: ISSUE.fields.attachment } } : ISSUE;
  if (m === "GET" && p === "/rest/api/2/issue/LEAK-1") return { status: 400, body: { errorMessages: [`bad token ${TOKEN}`] } };
  if (m === "GET" && /^\/rest\/api\/2\/issue\/PROJ-\d+\/transitions$/.test(p)) return { transitions: TRANSITIONS };
  if (m === "POST" && p === "/rest/api/2/issue/PROJ-2/transitions" && body?.fields?.resolution) return { status: 400, body: { errors: { resolution: "Field 'resolution' cannot be set." } } };
  if (m === "POST" && /\/transitions$/.test(p)) return { status: 204 };
  if (m === "GET" && p === "/rest/api/2/issueLinkType") return { issueLinkTypes: [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }] };
  if (m === "POST" && p === "/rest/api/2/issueLink") return { status: 201 };
  if (m === "POST" && p === "/rest/api/2/issue") return { status: 201, body: { id: "100", key: "PROJ-100" } };
  if (m === "PUT" && p === "/rest/api/2/issue/PROJ-1") return { status: 204 };
  if (m === "POST" && /\/comment$/.test(p)) return p.includes("PROJ-404") ? { status: 404, body: { errorMessages: ["Issue does not exist or you do not have permission to see it."] } } : { status: 201, body: { id: "c1" } };
  if (m === "DELETE" && p === "/rest/api/2/issue/PROJ-1") return { status: 204 };
  if (m === "POST" && p === "/rest/api/2/issue/PROJ-1/attachments") return [{ id: "20001" }];
  if (m === "GET" && p === "/rest/api/2/attachment/10001") return ISSUE.fields.attachment[0];
  if (m === "GET" && p === "/rest/api/2/attachment/content/10001") return { status: 303, headers: { location: `${mediaBase}/file/crash.log?token=media` } };
  if (m === "GET" && p === "/rest/api/3/issue/createmeta/PROJ/issuetypes") return { issueTypes: [{ id: "10", name: "Story" }, { id: "11", name: "Bug" }] };
  if (m === "GET" && p === "/rest/api/3/issue/createmeta/PROJ/issuetypes/10") return { fields: [{ fieldId: "summary", name: "Summary", required: true }, { fieldId: "priority", name: "Priority", required: false, allowedValues: [{ id: "1", name: "High" }] }] };
  if (m === "POST" && p === "/rest/api/3/search/jql") {
    // Two pages: first returns 2 issues + token, second the rest.
    if (!body.nextPageToken) return { issues: SEARCH_POOL.slice(0, 2), nextPageToken: "page2" };
    return { issues: SEARCH_POOL.slice(2) };
  }
  if (m === "GET" && p === "/rest/agile/1.0/board") {
    const pk = url.searchParams.get("projectKeyOrId");
    if (pk === "NOBOARD") return { values: [] };
    return { isLast: true, values: [{ id: 7, name: "Other team", type: "scrum", location: { projectKey: "OTHER" } }, { id: 5, name: "Proj board", type: "kanban", location: { projectKey: "PROJ" } }] };
  }
  if (m === "GET" && p === "/rest/agile/1.0/board/5/backlog") return { issues: [mkIssue("PROJ-20", "First"), mkIssue("OTHER-3", "Foreign")], isLast: true, total: 2 };
  return undefined;
}

before(async () => {
  media = http.createServer((req, res) => {
    mediaLog.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/plain" }).end("line1\nline2\n");
  });
  await new Promise((r) => media.listen(0, "127.0.0.1", r));
  mediaBase = `http://localhost:${media.address().port}`; // different origin from base (127.0.0.1)

  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const ctype = req.headers["content-type"] ?? "";
    const body = ctype.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    const url = new URL(req.url, "http://x");
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization, rawUrl: req.url, xToken: req.headers["x-atlassian-token"], multipart: ctype.includes("multipart") ? raw.toString("latin1") : undefined });
    if (rateLimitOnce) {
      rateLimitOnce = false;
      return void res.writeHead(429, { "retry-after": "0" }).end("rate limited");
    }
    const r = route(req, url, body);
    if (r === undefined) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }));
    if (r && typeof r.status === "number") {
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      return void res.end(r.body ? JSON.stringify(r.body) : "");
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  media.close();
});

const ENV = () => ({ JIRA_URL: `${base}/`, JIRA_USERNAME: USER, JIRA_API_TOKEN: TOKEN });

async function run(args, env = ENV()) {
  let o = "";
  let e = "";
  log = [];
  mediaLog = [];
  const code = await main(args, { env, stdout: { write: (s) => (o += s) }, stderr: { write: (s) => (e += s) } });
  return { code, out: o.trimEnd(), err: e.trimEnd() };
}
const writes = () => log.filter((r) => r.method !== "GET" && r.path !== "/rest/api/3/search/jql");

test("Basic auth header is sent; the token never appears in a URL", async () => {
  const r = await run(["me"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Name: {4}Alice Smith/);
  assert.match(r.out, new RegExp(`Site: {4}${base}$`, "m"));
  assert.equal(log[0].auth, BASIC);
  assert.ok(!log.some((x) => x.rawUrl.includes(TOKEN)));
});

test("missing credentials: exit 1 with setup instructions, no request sent", async () => {
  const r = await run(["me"], { JIRA_USERNAME: USER, JIRA_API_TOKEN: TOKEN });
  assert.equal(r.code, 1);
  assert.match(r.err, /Missing: JIRA_URL/);
  assert.match(r.err, /export JIRA_URL=/);
  assert.equal(log.length, 0);
});

test("JIRA_URL must be https (plain http only for localhost)", () => {
  assert.throws(() => loadCreds({ JIRA_URL: "http://jira.example.com", JIRA_USERNAME: "u", JIRA_API_TOKEN: "t" }), /https/);
  assert.equal(loadCreds({ JIRA_URL: "https://x.atlassian.net/", JIRA_USERNAME: "u", JIRA_API_TOKEN: "t" }).url, "https://x.atlassian.net");
  assert.throws(() => loadCreds({ JIRA_URL: "https://u:p@x.atlassian.net", JIRA_USERNAME: "u", JIRA_API_TOKEN: "t" }), /plain base URL/);
});

test("test-token reports OK", async () => {
  const r = await run(["test-token"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Token OK - authenticated as Alice Smith <me@example.com>/);
});

test("show renders fields, links, attachments, ADF description and Details; accepts a browse URL", async () => {
  const r = await run(["show", "https://x.atlassian.net/browse/proj-1"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].path, "/rest/api/2/issue/PROJ-1");
  assert.equal(log[0].query.expand, "names");
  assert.match(r.out, /URL: {6}http:\/\/127\.0\.0\.1:\d+\/browse\/PROJ-1/);
  assert.match(r.out, /Epic: {5}PROJ-900/);
  assert.match(r.out, /blocks PROJ-2 \(Release\)/);
  assert.match(r.out, /\[10001\] crash\.log \(text\/plain, 12 B, Bob, 2026-01-03\)/);
  assert.match(r.out, /Description:\nCrashes on cold start/);
  assert.match(r.out, /Steps to Reproduce:\n1\. Open app\n2\. Tap login/);
});

test("--json prints raw issue data", async () => {
  const r = await run(["show", "PROJ-1", "--json"]);
  assert.equal(JSON.parse(r.out).key, "PROJ-1");
});

test("search follows nextPageToken and sends the JQL as-is", async () => {
  const r = await run(["search", 'project = PROJ AND status = "To Do"', "--limit", "50"]);
  assert.equal(r.code, 0, r.err);
  const calls = log.filter((x) => x.path === "/rest/api/3/search/jql");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.jql, 'project = PROJ AND status = "To Do"');
  assert.equal(calls[1].body.nextPageToken, "page2");
  assert.match(r.out, /Results \(3 shown\)/);
  assert.match(r.out, /\[PROJ-12\] Upgrade Gradle to 8\.7\n {2}Status: {3}To Do\n {2}Assignee: Unassigned/);
});

test("search --limit truncates and says so", async () => {
  const r = await run(["search", "project = PROJ", "--limit", "2"]);
  assert.match(r.out, /2 shown, more available - raise --limit/);
});

test("projects filter and stats", async () => {
  const p = await run(["projects", "subs"]);
  assert.match(p.out, /\[SUBS\] Subscriptions/);
  assert.doesNotMatch(p.out, /\[PROJ\]/);
  const s = await run(["stats", "--days", "7"]);
  assert.match(log[0].body.jql, /updated >= -7d/);
  assert.match(s.out, /Total issues: 3\n\nBy status:\n {2}To Do: 3/);
});

test("backlog prefers the board owned by the project and warns about foreign keys", async () => {
  const r = await run(["backlog", "--project", "PROJ"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(log.some((x) => x.path === "/rest/agile/1.0/board/5/backlog"));
  assert.match(r.out, /WARNING: Backlog also contains issues from: OTHER/);
  assert.match(r.out, /Backlog of Proj board \(id 5, PROJ\) - 2 issues/);
});

test("backlog without a board falls back to a Rank-ordered JQL scan", async () => {
  const r = await run(["backlog", "--project", "NOBOARD"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.find((x) => x.path === "/rest/api/3/search/jql").body.jql, "project = NOBOARD AND statusCategory != Done ORDER BY Rank ASC");
  assert.match(r.out, /Backlog fallback for NOBOARD/);
});

test("find-duplicates clusters the scope and prints a CLI cleanup line", async () => {
  const r = await run(["find-duplicates", "--project", "PROJ"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].body.jql, "project = PROJ AND statusCategory != Done ORDER BY created ASC");
  assert.match(r.out, /Found 1 candidate cluster/);
  assert.match(r.out, /cleanup: jira link PROJ-11 --type duplicates --target PROJ-10/);
  const j = JSON.parse((await run(["find-duplicates", "--jql", "project = PROJ", "--json"])).out);
  assert.deepEqual(j.clusters[0].members.map((m) => m.key).sort(), ["PROJ-10", "PROJ-11"]);
});

test("transitions and createmeta", async () => {
  const t = await run(["transitions", "PROJ-1"]);
  assert.match(t.out, /31 {2}"Close" -> Done \[Done\]/);
  const c = await run(["createmeta", "PROJ", "--issue-type", "story"]);
  assert.match(c.out, /\* summary {2}\[Summary\]/);
  assert.match(c.out, /Values: 1: High/);
  const bad = await run(["createmeta", "PROJ", "--issue-type", "Epic"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Available: Story, Bug/);
});

test("transition --dry-run reads transitions but sends no write", async () => {
  const r = await run(["transition", "PROJ-1", "PROJ-2", "--to", "done", "--resolution", "Duplicate", "--comment", "dup of PROJ-9", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(writes().length, 0);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /POST \/rest\/api\/2\/issue\/PROJ-1\/transitions \{"transition":\{"id":"31"\},"fields":\{"resolution":\{"name":"Duplicate"\}\},"update":\{"comment":\[\{"add":\{"body":"dup of PROJ-9"\}\}\]\}\}/);
});

test("transition retries without resolution on 400 and matches by status name", async () => {
  const r = await run(["transition", "PROJ-2", "--to", "Done", "--resolution", "Duplicate"]);
  assert.equal(r.code, 0, r.err);
  const w = writes();
  assert.equal(w.length, 2);
  assert.deepEqual(w[1].body, { transition: { id: "31" } });
  assert.match(r.out, /PROJ-2 -> Done \(resolution "Duplicate" not on the transition screen/);
});

test("transition with no matching name fails per key, exit 1", async () => {
  const r = await run(["transition", "PROJ-1", "--to", "Nope"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED PROJ-1: no transition matching "Nope" \(available: Start->In Progress, Close->Done\)/);
  assert.equal(writes().length, 0);
});

test("bulk comment: one failure does not abort the batch", async () => {
  const r = await run(["comment", "PROJ-1", "PROJ-404", "PROJ-3", "--body", "Superseded by PROJ-100"]);
  assert.equal(r.code, 1);
  assert.equal(writes().length, 3);
  assert.deepEqual(writes()[0].body, { body: "Superseded by PROJ-100" });
  assert.match(r.out, /2 ok, 1 failed/);
  assert.match(r.out, /FAILED PROJ-404: Jira API error: HTTP 404/);
});

test("link direction: shortcut phrase reads source-relative", async () => {
  await run(["link", "PROJ-1", "--type", "blocks", "--target", "PROJ-2"]);
  assert.deepEqual(writes()[0].body, { type: { name: "Blocks" }, inwardIssue: { key: "PROJ-1" }, outwardIssue: { key: "PROJ-2" } });
  await run(["link", "PROJ-1", "--type", "child-of", "--target", "PROJ-900"]);
  assert.deepEqual(writes()[0].body, { type: { name: "Child-Issue" }, inwardIssue: { key: "PROJ-900" }, outwardIssue: { key: "PROJ-1" } });
  const self = await run(["link", "PROJ-2", "PROJ-1", "--type", "duplicates", "--target", "PROJ-1"]);
  assert.equal(self.code, 1);
  assert.match(self.out, /FAILED PROJ-1: cannot link an issue to itself/);
  assert.equal(writes().length, 1);
});

test("create merges shortcut flags over --fields; dry-run sends nothing", async () => {
  const args = ["create", "--fields", '{"fields":{"customfield_10014":"PROJ-900"}}', "--project", "PROJ", "--issue-type", "Story", "--summary", "New thing", "--description", "Body"];
  const dry = await run([...args, "--dry-run"]);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(log.length, 0);
  assert.match(dry.out, /POST \/rest\/api\/2\/issue \{"fields":\{"customfield_10014":"PROJ-900","project":\{"key":"PROJ"\},"issuetype":\{"name":"Story"\},"summary":"New thing","description":"Body"\}\}/);
  const r = await run(args);
  assert.equal(r.code, 0, r.err);
  assert.equal(writes()[0].body.fields.summary, "New thing");
  assert.match(r.out, /Created PROJ-100\nURL: .*\/browse\/PROJ-100/);
});

test("update needs fields; sends PUT with the fields", async () => {
  assert.equal((await run(["update", "PROJ-1"])).code, 2);
  assert.equal((await run(["update", "PROJ-1", "--fields", "not json"])).code, 2);
  const r = await run(["update", "PROJ-1", "--summary", "New title"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes()[0], { ...writes()[0], method: "PUT", path: "/rest/api/2/issue/PROJ-1", body: { fields: { summary: "New title" } } });
});

test("delete refuses without --yes; with --yes deletes sub-tasks too", async () => {
  const r = await run(["delete", "PROJ-1"]);
  assert.equal(r.code, 2);
  assert.equal(log.length, 0);
  const ok = await run(["delete", "PROJ-1", "--yes"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(writes()[0].method, "DELETE");
  assert.equal(writes()[0].query.deleteSubtasks, "true");
});

test("attachment add sends multipart with X-Atlassian-Token; dry-run lists the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-test-"));
  const f = join(dir, "note.txt");
  writeFileSync(f, "hello upload");
  const dry = await run(["attachment", "add", "PROJ-1", "--file", f, "--dry-run"]);
  assert.equal(log.length, 0);
  assert.match(dry.out, /multipart file\(s\)=.*note\.txt/);
  const up = await run(["attachment", "add", "PROJ-1", "--file", f]);
  assert.equal(up.code, 0, up.err);
  const w = writes()[0];
  assert.equal(w.xToken, "no-check");
  assert.ok(w.multipart.includes('filename="note.txt"') && w.multipart.includes("hello upload"));
  assert.equal((await run(["attachment", "add", "PROJ-1", "--file", join(dir, "missing")])).code, 2);
});

test("attachment get follows the cross-origin redirect WITHOUT credentials and saves the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jira-dl-"));
  const r = await run(["attachment", "get", "10001", "--out", dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.find((x) => x.path === "/rest/api/2/attachment/content/10001").auth, BASIC);
  assert.equal(mediaLog.length, 1);
  assert.equal(mediaLog[0].auth, undefined);
  assert.equal(readFileSync(join(dir, "crash.log"), "utf8"), "line1\nline2\n");
  assert.match(r.out, /Saved: .*crash\.log\nName: crash\.log {2}Type: text\/plain {2}Size: 12 B\n\(text: Read the file\.\)/);
  // By issue + filename; a second download does not overwrite.
  const r2 = await run(["attachment", "get", "PROJ-1", "CRASH.LOG", "--out", dir]);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /crash-1\.log/);
  const missing = await run(["attachment", "get", "PROJ-1", "nope.png"]);
  assert.match(missing.err, /Available: crash\.log/);
});

test("credentials are only sent to the JIRA_URL origin", async () => {
  const c = new Client({ url: "https://acme.atlassian.net", username: "u", token: "t" });
  assert.equal(c.isTrustedUrl("https://acme.atlassian.net/rest/api/2/x"), true);
  assert.equal(c.isTrustedUrl("https://acme.atlassian.net.evil.com/x"), false);
  assert.equal(c.isTrustedUrl("https://api.media.atlassian.com/file/x"), false);
  assert.throws(() => c.url("https://evil.example.com/x"), /Refusing absolute URL/);
  assert.throws(() => c.url("//evil.example.com/x"), /Refusing absolute URL/);
  const r = await run(["api", "GET", "https://evil.example.com/rest/api/2/myself"]);
  assert.equal(r.code, 2);
  assert.equal(log.length, 0);
});

test("the token is redacted from error output", async () => {
  const r = await run(["show", "LEAK-1"]);
  assert.equal(r.code, 1);
  assert.ok(!r.err.includes(TOKEN), r.err);
  assert.match(r.err, /bad token \*\*\*/);
});

test("404 errors are readable; --json errors are structured", async () => {
  const r = await run(["show", "PROJ-999"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Error: Jira API error: HTTP 404 \| Issue does not exist/);
  const j = await run(["show", "PROJ-999", "--json"]);
  assert.equal(JSON.parse(j.err).status, 404);
});

test("api escape hatch: GET prints JSON, writes honor --dry-run", async () => {
  const r = await run(["api", "GET", "rest/api/2/myself"]);
  assert.equal(JSON.parse(r.out).displayName, "Alice Smith");
  const w = await run(["api", "POST", "/rest/api/2/issue/PROJ-1/comment", "--data", '{"body":"x"}', "--dry-run"]);
  assert.equal(log.length, 0);
  assert.match(w.out, /POST \/rest\/api\/2\/issue\/PROJ-1\/comment \{"body":"x"\}/);
});

test("429 is retried", async () => {
  rateLimitOnce = true;
  const r = await run(["me"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.length, 2);
});

test("usage errors: unknown flag, wrong flag for command, unknown command, bad key", async () => {
  assert.equal((await run(["me", "--bogus"])).code, 2);
  const wrong = await run(["comment", "PROJ-1", "--to", "Done"]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /not valid for "comment"/);
  assert.equal((await run(["shoe"])).code, 2);
  assert.equal((await run(["show", "not a key"])).code, 2);
  assert.equal(log.length, 0);
});

test("issueKey normalisation", () => {
  assert.equal(issueKey("proj-12"), "PROJ-12");
  assert.equal(issueKey("https://x.atlassian.net/jira/software/projects/P/boards/1?selectedIssue=P-7"), "P-7");
  assert.equal(issueKey("10042"), "10042");
  assert.throws(() => issueKey("PROJ"));
});

test("help works without credentials", async () => {
  const r = await run(["--help"], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /Write commands/);
  const c = await run(["link", "--help"], {});
  assert.match(c.out, /Usage: jira link <issue\.\.\.> --type/);
});
