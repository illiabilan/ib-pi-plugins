import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.mjs";
import { Client } from "../client.mjs";
import { parseDue } from "../cli.mjs";

/** In-process fake Trello. Records every request so tests can assert on exact wire traffic. */
let server;
let base;
let log = [];
let rateLimitOnce = false;

const BOARD = { id: "b".repeat(24), shortLink: "BoArD001", name: "Mobile Roadmap", url: "https://trello.com/b/BoArD001" };
const BOARD2 = { id: "c".repeat(24), shortLink: "BoArD002", name: "Mobile Support", url: "https://trello.com/b/BoArD002" };
const LISTS = [
  { id: "1".repeat(24), name: "To Do" },
  { id: "2".repeat(24), name: "Doing" },
  { id: "3".repeat(24), name: "Done" },
];
const CARD = {
  id: "d".repeat(24), shortLink: "CaRd0001", name: "Fix login crash", idBoard: BOARD.id, idList: LISTS[0].id,
  idLabels: ["l1".padEnd(24, "0")], idMembers: ["m1".padEnd(24, "0")], url: "https://trello.com/c/CaRd0001", closed: false,
  desc: "Crashes on cold start", due: "2026-08-01T12:00:00.000Z", dueComplete: false, labels: [{ id: "l1".padEnd(24, "0"), name: "bug", color: "red" }],
  dateLastActivity: "2026-07-20T10:00:00.000Z",
};
const LABELS = [
  { id: "l1".padEnd(24, "0"), name: "bug", color: "red" },
  { id: "l2".padEnd(24, "0"), name: "ui", color: "blue" },
  { id: "l3".padEnd(24, "0"), name: "", color: "green" },
];
const MEMBERS = [
  { id: "m1".padEnd(24, "0"), username: "alice", fullName: "Alice Smith" },
  { id: "m2".padEnd(24, "0"), username: "bob", fullName: "Bob Jones" },
];

function route(req, url, body) {
  const p = url.pathname;
  const m = req.method;
  if (m === "GET" && p === "/members/me") return { id: "me1", username: "alice", fullName: "Alice Smith" };
  if (m === "GET" && p === "/members/me/boards") return [BOARD, BOARD2];
  if (m === "GET" && p === `/boards/${BOARD.id}`) return BOARD;
  if (m === "GET" && p === "/boards/BoArD001") return BOARD;
  if (m === "GET" && p === "/boards/Personal") return null; // 404: 8-char name, not a short link
  if (m === "GET" && p === `/boards/${BOARD.id}/lists`) return url.searchParams.get("cards") ? LISTS.map((l, i) => ({ ...l, cards: i === 0 ? [CARD] : [] })) : LISTS;
  if (m === "GET" && p === `/boards/${BOARD.id}/members`) return MEMBERS;
  if (m === "GET" && p === `/boards/${BOARD.id}/labels`) return LABELS;
  if (m === "GET" && p === `/boards/${BOARD.id}/cards`) return [CARD];
  if (m === "GET" && p === `/lists/${LISTS[0].id}/cards`) return [CARD];
  if (m === "GET" && (p === `/cards/CaRd0001` || p === `/cards/${CARD.id}`)) {
    return url.searchParams.get("members") ? { ...CARD, members: [MEMBERS[0]], checklists: [{ id: "k".repeat(24), name: "Release", checkItems: [{ id: "i1".padEnd(24, "0"), name: "Tag build", state: "complete" }, { id: "i2".padEnd(24, "0"), name: "Notify QA", state: "incomplete" }] }], attachments: [{ id: "a".repeat(24), name: "crash.log", isUpload: true, bytes: 2048, mimeType: "text/plain", url: `${base}/files/crash.log` }], board: { name: BOARD.name }, list: { name: "To Do" } } : CARD;
  }
  if (m === "GET" && (p === `/cards/${CARD.id}/actions` || p === "/cards/CaRd0001/actions")) return [{ date: "2026-07-19T09:00:00.000Z", memberCreator: { fullName: "Bob Jones" }, data: { text: "Repro on Pixel 8" } }];
  if (m === "GET" && p === `/cards/${CARD.id}/checklists`) return [{ id: "k".repeat(24), name: "Release", checkItems: [{ id: "i1".padEnd(24, "0"), name: "Tag build", state: "complete" }, { id: "i2".padEnd(24, "0"), name: "Notify QA", state: "incomplete" }] }];
  if (m === "GET" && p === `/cards/CaRd0001/attachments`) return [{ id: "a".repeat(24), name: "crash.log", fileName: "crash.log", isUpload: true, bytes: 2048, mimeType: "text/plain", url: `${base}/files/crash.log` }, { id: "z".repeat(24), name: "spec", isUpload: false, url: "https://example.com/spec" }];
  if (m === "GET" && p === "/files/crash.log") return "line1\nline2\n";
  if (m === "GET" && p === "/search") return { cards: [{ ...CARD, board: { name: BOARD.name }, list: { name: "To Do" } }] };
  if (m === "POST" && p === "/cards") return { id: "n".repeat(24), shortLink: "NeW00001", url: "https://trello.com/c/NeW00001", name: body.name };
  if (m === "PUT" && p === `/cards/${CARD.id}`) return { ...CARD, ...body };
  if (m === "DELETE" && p === `/cards/${CARD.id}`) return {};
  if (m === "POST" && p === `/cards/${CARD.id}/actions/comments`) return { id: "act1" };
  if (m === "POST" && p === `/cards/${CARD.id}/idLabels`) return [];
  if (m === "POST" && p === `/cards/${CARD.id}/attachments`) return { id: "att1" };
  if (m === "POST" && p === "/checklists") return { id: "newchecklist" };
  if (m === "POST" && p.endsWith("/checkItems")) return { id: "newitem" };
  if (m === "PUT" && p.startsWith(`/cards/${CARD.id}/checkItem/`)) return {};
  if (m === "POST" && p === "/lists") return { id: "nl".padEnd(24, "0") };
  return undefined; // 404
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const ctype = req.headers["content-type"] ?? "";
    const body = ctype.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    const url = new URL(req.url, "http://x");
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization, rawUrl: req.url, multipart: ctype.includes("multipart") ? raw.toString("latin1") : undefined });
    if (rateLimitOnce) {
      rateLimitOnce = false;
      res.writeHead(429, { "retry-after": "0" }).end("rate limited");
      return;
    }
    const r = route(req, url, body);
    if (r === undefined || r === null) return void res.writeHead(r === null ? 404 : 404).end("invalid id");
    if (typeof r === "string") return void res.writeHead(200, { "content-type": "text/plain" }).end(r);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ENV = () => ({ TRELLO_API_KEY: "KEY123", TRELLO_TOKEN: "TOK456", TRELLO_API_BASE: base });

async function run(args, env = ENV()) {
  let o = "";
  let e = "";
  log = [];
  const code = await main(args, { env, stdout: { write: (s) => (o += s) }, stderr: { write: (s) => (e += s) } });
  return { code, out: o.trimEnd(), err: e.trimEnd() };
}
const writes = () => log.filter((r) => r.method !== "GET");

test("auth header is used and the token never appears in a URL", async () => {
  const r = await run(["me"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /@alice \(Alice Smith\)/);
  assert.equal(log[0].auth, 'OAuth oauth_consumer_key="KEY123", oauth_token="TOK456"');
  assert.ok(!log.some((x) => x.rawUrl.includes("TOK456") || x.rawUrl.includes("KEY123")));
});

test("missing credentials: exit 1 with setup instructions, no request sent", async () => {
  const r = await run(["me"], { TRELLO_API_BASE: base });
  assert.equal(r.code, 1);
  assert.match(r.err, /TRELLO_API_KEY/);
  assert.equal(log.length, 0);
});

test("board overview resolves a board by name and renders cards with members", async () => {
  const r = await run(["board", "Mobile Roadmap"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /## To Do/);
  assert.match(r.out, /\[CaRd0001\] Fix login crash \| due 2026-08-01T12:00Z \| bug \| @alice/);
});

test("ambiguous board name fails and lists candidates", async () => {
  const r = await run(["board", "Mobile"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /matches 2 boards/);
  assert.match(r.err, /Mobile Support/);
});

test("8-char board name that is not a short link falls back to name matching", async () => {
  const r = await run(["board", "Personal"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /No board matches "Personal"/);
});

test("unique substring resolves a board", async () => {
  const r = await run(["lists", "roadmap"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /To Do/);
});

test("card show: checklist, attachment and comment are rendered", async () => {
  const r = await run(["card", "https://trello.com/c/CaRd0001/1-fix-login"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /checklist "Release" \(id k+\) 1\/2/);
  assert.match(r.out, /\[x\] Tag build/);
  assert.match(r.out, /crash\.log {2}2\.0 KB/);
  assert.match(r.out, /Bob Jones: Repro on Pixel 8/);
});

test("--json prints parseable raw data", async () => {
  const r = await run(["card", "CaRd0001", "--json"]);
  const j = JSON.parse(r.out);
  assert.equal(j.card.shortLink, "CaRd0001");
  assert.equal(j.comments.length, 1);
});

test("card create --dry-run sends no write and prints the resolved plan", async () => {
  const r = await run(["card", "create", "New thing", "--board", "BoArD001", "--list", "doing", "--label", "ui,bug", "--member", "@bob", "--due", "2026-09-01", "--dry-run"]);
  assert.equal(r.code, 0);
  assert.equal(writes().length, 0);
  assert.match(r.out, /DRY RUN/);
  assert.match(r.out, /Create card "New thing" in list "Doing"/);
  assert.match(r.out, /"idLabels":"l2\w+,l1\w+"/);
  assert.match(r.out, /"due":"2026-09-01T12:00:00.000Z"/);
});

test("card create sends the exact JSON body", async () => {
  const r = await run(["--board", "BoArD001", "--list", "Doing", "--desc=multi\nline", "--", "card", "create", "- leading dash"]);
  assert.equal(r.code, 0, r.err);
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].path, "/cards");
  assert.deepEqual(w[0].body, { idList: "2".repeat(24), name: "- leading dash", desc: "multi\nline" });
  assert.match(r.out, /Created card \[NeW00001\]/);
});

test("card move resolves the list on the card's own board", async () => {
  const r = await run(["card", "move", "CaRd0001", "--list", "Done"]);
  assert.equal(r.code, 0, r.err);
  const w = writes();
  assert.equal(w[0].method, "PUT");
  assert.deepEqual(w[0].body, { idList: "3".repeat(24) });
});

test("unknown list lists the available ones", async () => {
  const r = await run(["card", "move", "CaRd0001", "--list", "Nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Available:[\s\S]*Doing/);
  assert.equal(writes().length, 0);
});

test("card label skips labels already on the card and adds the new one", async () => {
  const r = await run(["card", "label", "CaRd0001", "--add", "bug,ui", "--remove", "ui"]);
  assert.equal(r.code, 0, r.err);
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].path, `/cards/${CARD.id}/idLabels`);
  assert.deepEqual(w[0].body, { value: "l2".padEnd(24, "0") });
});

test("unnamed label can be addressed by color", async () => {
  const r = await run(["card", "label", "CaRd0001", "--add", "green"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes()[0].body, { value: "l3".padEnd(24, "0") });
});

test("card delete refuses without --yes and sends nothing", async () => {
  const r = await run(["card", "delete", "CaRd0001"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /without --yes/);
  assert.equal(writes().length, 0);
  const ok = await run(["card", "delete", "CaRd0001", "--yes"]);
  assert.equal(ok.code, 0);
  assert.equal(writes()[0].method, "DELETE");
});

test("card update validates input and clears due with null", async () => {
  assert.equal((await run(["card", "update", "CaRd0001"])).code, 2);
  assert.equal((await run(["card", "update", "CaRd0001", "--due", "not-a-date"])).code, 2);
  const r = await run(["card", "update", "CaRd0001", "--clear-due", "--incomplete"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes()[0].body, { due: null, dueComplete: false });
});

test("comment, archive and checklist flows hit the right endpoints", async () => {
  await run(["card", "comment", "CaRd0001", "Shipped in 4.2"]);
  assert.deepEqual(writes().at(-1).body, { text: "Shipped in 4.2" });
  await run(["card", "archive", "CaRd0001"]);
  assert.deepEqual(writes().at(-1).body, { closed: true });
  await run(["checklist", "add", "CaRd0001", "QA", "--item", "one", "--item", "two"]);
  assert.deepEqual(writes().map((w) => w.path), ["/checklists", "/checklists/newchecklist/checkItems", "/checklists/newchecklist/checkItems"]);
  await run(["checklist", "check", "CaRd0001", "notify"]);
  const w = writes()[0];
  assert.equal(w.path, `/cards/${CARD.id}/checkItem/${"i2".padEnd(24, "0")}`);
  assert.deepEqual(w.body, { state: "complete" });
});

test("search passes operators and board filter, prints board and list", async () => {
  const r = await run(["search", "label:bug", "--board", "BoArD001"]);
  assert.equal(r.code, 0, r.err);
  const q = log.find((x) => x.path === "/search").query;
  assert.equal(q.query, "label:bug");
  assert.equal(q.idBoards, BOARD.id);
  assert.match(r.out, /list: To Do \| board: Mobile Roadmap/);
});

test("attachment upload sends multipart; download saves the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trello-test-"));
  const f = join(dir, "note.txt");
  writeFileSync(f, "hello upload");
  const up = await run(["attachment", "add", "CaRd0001", "--file", f]);
  assert.equal(up.code, 0, up.err);
  const w = writes()[0];
  assert.ok(w.multipart.includes('filename="note.txt"') && w.multipart.includes("hello upload"));

  const dl = await run(["attachment", "get", "CaRd0001", "crash", "--out", dir]);
  assert.equal(dl.code, 0, dl.err);
  assert.equal(readFileSync(join(dir, "crash.log"), "utf8"), "line1\nline2\n");

  const link = await run(["attachment", "get", "CaRd0001", "spec"]);
  assert.match(link.out, /is a link, not an upload: https:\/\/example.com\/spec/);
});

test("credentials are never sent to a foreign host", async () => {
  const c = new Client({ key: "K", token: "T" }, { base });
  await assert.rejects(() => c.download("https://evil.example.com/x"), /untrusted host/);
  assert.equal(c.isTrustedUrl("https://trello.com/1/cards/x/attachments/y/download/z.png"), true);
  assert.equal(c.isTrustedUrl("https://trello.com.evil.com/x"), false);
});

test("429 is retried", async () => {
  rateLimitOnce = true;
  const r = await run(["me"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.length, 2);
});

test("usage errors: unknown flag, wrong flag for command, unknown command", async () => {
  assert.equal((await run(["me", "--bogus"])).code, 2);
  const wrong = await run(["card", "move", "CaRd0001", "--due", "2026-01-01"]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /not valid for "card move"/);
  const unk = await run(["cardd"]);
  assert.equal(unk.code, 2);
  assert.equal(log.length, 0);
});

test("--json errors are structured", async () => {
  const r = await run(["card", "NoSuchCd", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.err).status, 404);
});

test("parseDue", () => {
  assert.equal(parseDue("2026-09-01"), "2026-09-01T12:00:00.000Z");
  assert.equal(parseDue("2026-09-01T08:30:00+02:00"), "2026-09-01T06:30:00.000Z");
  assert.throws(() => parseDue("tomorrow"));
});
