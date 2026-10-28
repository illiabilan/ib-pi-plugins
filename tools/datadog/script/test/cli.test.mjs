import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { main } from "../cli.mjs";
import { loadCreds, normalizeSite, testBase } from "../client.mjs";
import { parseEnd, parseTime, monitorIdFrom, dashboardIdFrom, explorerFromUrl } from "../format.mjs";

/** In-process fake Datadog. Records every request so tests can assert on exact wire traffic. */
let server;
let base;
let log = [];
let rateLimitOnce = false;
let forceStatus = null;

const NOW_ISO = () => new Date().toISOString();
const MONITOR = {
  id: 123,
  name: "{{#is_alert}}ALERT{{/is_alert}} Checkout error rate",
  overall_state: "Alert",
  type: "query alert",
  query: "sum(last_5m):sum:trace.http.request.errors{service:checkout} > 10",
  options: { thresholds: { critical: 10 }, silenced: {} },
  tags: ["team:core", "service:checkout"],
  modified: "2026-10-01T10:00:00.000Z",
  message: "Checkout is failing @slack-core",
  state: { group_states: { "host:a": { status: "Alert", last_triggered_ts: 1790000000 }, "host:b": { status: "OK" } } },
};

function route(req, url, body) {
  const p = url.pathname;
  const m = req.method;
  if (m === "GET" && p === "/api/v1/monitor") return [MONITOR];
  if (m === "GET" && p === "/api/v2/current_user") return { data: { attributes: { name: "Alice", email: "alice@example.com" } } };
  if (m === "POST" && p === "/api/v2/logs/events/search") {
    return {
      data: [
        { attributes: { timestamp: NOW_ISO(), status: "error", service: "checkout", message: "payment failed\n  card declined", host: "web-01" } },
        { attributes: { timestamp: NOW_ISO(), service: "checkout", attributes: { status: "warn", msg: "slow" } } },
      ],
      meta: { page: { after: body?.page?.cursor ? undefined : "CURSOR2" } },
    };
  }
  if (m === "POST" && p === "/api/v2/logs/analytics/aggregate") {
    return { data: { buckets: [{ by: { service: "a" }, computes: { c0: 3 } }, { by: { service: "b" }, computes: { c0: 9 } }] } };
  }
  if (m === "GET" && p === "/api/v1/query") {
    if (url.searchParams.get("query").startsWith("bad")) return { status: "error", error: "Rule parsing error" };
    return { status: "ok", unit: [{ short_name: "%" }], series: [{ scope: "host:a", pointlist: [[1, 1], [2, 5], [3, null], [4, 3]] }] };
  }
  if (m === "GET" && p === "/api/v1/search") return { results: { metrics: ["trace.http.request.duration", "trace.http.request.hits"] } };
  if (m === "GET" && p === "/api/v1/monitor/search") return { monitors: [{ ...MONITOR, status: "Alert" }], metadata: { total_count: 500 } };
  if (m === "GET" && p === "/api/v1/monitor/123") return MONITOR;
  if (m === "GET" && p === "/api/v2/events") return { data: [{ attributes: { timestamp: NOW_ISO(), message: "Deployed checkout v42", attributes: { alert_type: "info", service: "checkout" } } }] };
  if (m === "POST" && p === "/api/v2/spans/events/search") {
    return {
      data: [
        { attributes: { start_timestamp: NOW_ISO(), service: "checkout", resource_name: "POST /pay", custom: { duration: 12_500_000, error: { type: "x" } } } },
        { attributes: { service: "cart", resource_name: "GET /cart" } },
      ],
    };
  }
  if (m === "GET" && p === "/api/v1/dashboard") return { dashboards: [{ id: "abc-def-ghi", title: "Checkout overview" }, { id: "zzz-yyy-xxx", title: "Infra", is_read_only: true }] };
  if (m === "GET" && p === "/api/v1/dashboard/abc-def-ghi") {
    return {
      id: "abc-def-ghi",
      title: "Checkout overview",
      template_variables: [{ name: "env", default: "prod" }],
      widgets: [
        { definition: { type: "group", title: "Errors", widgets: [{ definition: { type: "timeseries", title: "Error rate", requests: [{ q: "sum:errors{$env}" }] } }] } },
        { definition: { type: "note" } },
      ],
    };
  }
  if (m === "GET" && p === "/api/v1/slo") return { data: [{ id: "slo1", name: "Checkout availability", type: "metric", thresholds: [{ target: 99.9, timeframe: "30d" }] }] };
  if (m === "GET" && p === "/api/v1/hosts") return { host_list: [{ host_name: "web-01", up: true, tags_by_source: { Datadog: ["env:prod"] } }], total_matching: 1 };
  if (m === "POST" && p === "/api/v1/monitor/123/mute") return { id: 123, name: "Checkout error rate" };
  if (m === "POST" && p === "/api/v1/monitor/123/unmute") return { id: 123, name: "Checkout error rate" };
  if (m === "POST" && p === "/api/v1/events") return { event: { id: 777 }, status: "ok" };
  return undefined;
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, "http://x");
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers, rawUrl: req.url });
    if (rateLimitOnce) {
      rateLimitOnce = false;
      return void res.writeHead(429, { "retry-after": "0" }).end('{"errors":["Too many requests"]}');
    }
    if (forceStatus) return void res.writeHead(forceStatus, { "content-type": "application/json" }).end('{"errors":["Forbidden"]}');
    const r = route(req, url, body);
    if (r === undefined) return void res.writeHead(404, { "content-type": "application/json" }).end('{"errors":["Not found"]}');
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ENV = (extra = {}) => ({ DD_API_KEY: "APIKEY123", DD_APP_KEY: "APPKEY456", DD_TEST_API_BASE: base, ...extra });

async function run(args, env = ENV(), fetchImpl) {
  let o = "";
  let e = "";
  log = [];
  forceStatus = null;
  const code = await main(args, { env, fetchImpl, stdout: { write: (s) => (o += s) }, stderr: { write: (s) => (e += s) } });
  return { code, out: o.trimEnd(), err: e.trimEnd() };
}
const writes = () => log.filter((r) => r.method === "POST" && !r.path.includes("/search") && !r.path.includes("/aggregate"));

/* ------------------------------------------------------------- auth & safety */

test("key pair travels in headers, never in the URL", async () => {
  const r = await run(["validate"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Scheme: DD-API-KEY \+ DD-APPLICATION-KEY/);
  assert.match(r.out, /User: {3}Alice <alice@example.com>/);
  assert.match(r.out, /Status: OK/);
  assert.equal(log[0].headers["dd-api-key"], "APIKEY123");
  assert.equal(log[0].headers["dd-application-key"], "APPKEY456");
  assert.equal(log[0].headers.authorization, undefined);
  assert.ok(!log.some((x) => x.rawUrl.includes("APIKEY123") || x.rawUrl.includes("APPKEY456")));
});

test("DD_BEARER_TOKEN wins over the key pair", async () => {
  const r = await run(["monitor", "123"], ENV({ DD_BEARER_TOKEN: "ddpat_tok" }));
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].headers.authorization, "Bearer ddpat_tok");
  assert.equal(log[0].headers["dd-api-key"], "APIKEY123");
  assert.equal(log[0].headers["dd-application-key"], undefined);
});

test("a ddpat_ token in DD_APP_KEY is used as a bearer token", async () => {
  const r = await run(["monitor", "123"], { DD_APP_KEY: "ddsat_svc", DD_TEST_API_BASE: base });
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].headers.authorization, "Bearer ddsat_svc");
  assert.equal(log[0].headers["dd-api-key"], undefined);
});

test("missing credentials: exit 1 with setup help, nothing sent", async () => {
  const r = await run(["monitors"], { DD_API_KEY: "only-one", DD_TEST_API_BASE: base });
  assert.equal(r.code, 1);
  assert.match(r.err, /DD_BEARER_TOKEN/);
  assert.equal(log.length, 0);
});

test("unknown DD_SITE is refused before any request", async () => {
  const calls = [];
  const spy = async (u) => (calls.push(String(u)), new Response("{}"));
  const r = await run(["monitors"], { DD_API_KEY: "k", DD_APP_KEY: "a", DD_SITE: "datadoghq.com.evil.io" }, spy);
  assert.equal(r.code, 1);
  assert.match(r.err, /Refusing to use DD_SITE/);
  assert.match(r.err, /Nothing was sent/);
  assert.equal(calls.length, 0);
});

test("pasted app URL as DD_SITE is normalised and becomes api.<site>", async () => {
  const calls = [];
  const spy = async (u) => (calls.push(String(u)), new Response(JSON.stringify({ monitors: [], metadata: { total_count: 0 } })));
  const r = await run(["monitors", "status:alert"], { DD_API_KEY: "k", DD_APP_KEY: "a", DD_SITE: "https://app.datadoghq.eu/" }, spy);
  assert.equal(r.code, 0, r.err);
  assert.match(calls[0], /^https:\/\/api\.datadoghq\.eu\/api\/v1\/monitor\/search\?/);
  assert.equal(normalizeSite(""), "datadoghq.com");
  assert.equal(normalizeSite("api.us5.datadoghq.com"), "us5.datadoghq.com");
  assert.equal(normalizeSite("evil.com"), null);
});

test("test base override is honored only for loopback hosts", async () => {
  const calls = [];
  const spy = async (u) => (calls.push(String(u)), new Response("{}"));
  for (const bad of ["https://evil.example.com", "http://127.0.0.1.evil.com", "http://10.0.0.1:8080", "file:///etc/passwd", "not a url"]) {
    const r = await run(["monitors"], ENV({ DD_TEST_API_BASE: bad }), spy);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /DD_TEST_API_BASE/);
  }
  assert.equal(calls.length, 0);
  assert.equal(testBase("http://localhost:9/x/"), "http://localhost:9/x");
  assert.equal(testBase("http://[::1]:9"), "http://[::1]:9");
  assert.equal(testBase(undefined), undefined);
});

test("legacy env aliases are read", () => {
  const c = loadCreds({ DATADOG_API_KEY: "k", DATADOG_APP_KEY: "a", DATADOG_SITE: "us3.datadoghq.com" });
  assert.deepEqual([c.scheme, c.site], ["pair", "us3.datadoghq.com"]);
  assert.equal(loadCreds({ DATADOG_BEARER_TOKEN: "ddpat_x" }).scheme, "bearer");
});

/* ------------------------------------------------------------- reads */

test("logs: exact request body, compact lines, cursor hint", async () => {
  const r = await run(["logs", "service:checkout", "status:error", "--from", "-1h", "--limit", "500", "--indexes", "main, retention"]);
  assert.equal(r.code, 0, r.err);
  const b = log[0].body;
  assert.equal(b.filter.query, "service:checkout status:error");
  assert.equal(b.page.limit, 200);
  assert.equal(b.sort, "-timestamp");
  assert.deepEqual(b.filter.indexes, ["main", "retention"]);
  assert.ok(Math.abs(Date.parse(b.filter.to) - Date.parse(b.filter.from) - 36e5) < 5000);
  assert.match(r.out, /ERROR \| checkout payment failed card declined host=web-01/);
  assert.match(r.out, /WARN  \| checkout slow/);
  assert.match(r.out, /--cursor CURSOR2/);
  const next = await run(["logs", "--cursor", "CURSOR2"]);
  assert.equal(log[0].body.page.cursor, "CURSOR2");
  assert.equal(log[0].body.filter.query, "*");
  assert.doesNotMatch(next.out, /--cursor/);
});

test("logs accepts a Datadog explorer URL", async () => {
  const r = await run(["logs", "https://app.datadoghq.com/logs?query=service%3Aweb%20status%3Aerror&from_ts=1790000000000&to_ts=1790003600000"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].body.filter.query, "service:web status:error");
  assert.equal(log[0].body.filter.from, new Date(1790000000000).toISOString());
  assert.equal(log[0].body.filter.to, new Date(1790003600000).toISOString());
});

test("unparseable time is a usage error, nothing sent", async () => {
  const r = await run(["logs", "--from", "yesterday-ish"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Could not parse --from/);
  assert.equal(log.length, 0);
});

test("logs-aggregate: no sort in group_by, sorted client-side", async () => {
  const r = await run(["logs-aggregate", "status:error", "--group-by", "service"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(log[0].body.group_by, [{ facet: "service", limit: 25 }]);
  assert.deepEqual(log[0].body.compute, [{ aggregation: "count", type: "total" }]);
  assert.match(r.out, /total 12 across 2 group\(s\):\n\n {10}9 {2}service=b\n {10}3 {2}service=a/);
  const alias = await run(["logs_aggregate"]);
  assert.equal(alias.code, 0, alias.err);
});

test("metrics: series reduced to stats + sparkline; query errors are exit 1", async () => {
  const r = await run(["metrics", "avg:system.cpu.user{*} by {host}", "--from", "4h"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].query.query, "avg:system.cpu.user{*} by {host}");
  assert.ok(Number(log[0].query.to) - Number(log[0].query.from) >= 4 * 3600 - 2);
  assert.match(r.out, /1 series, unit %/);
  assert.match(r.out, /min 1 {2}avg 3 {2}max 5 {2}last 3 {2}\(3 pts\)/);
  assert.equal((await run(["metrics"])).code, 2);
  const bad = await run(["metrics", "bad:query"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Query rejected by Datadog: Rule parsing error/);
});

test("metric-search, monitors, events, slos, hosts, dashboards render", async () => {
  let r = await run(["metric-search", "trace.http"]);
  assert.equal(log[0].query.q, "metrics:trace.http");
  assert.match(r.out, /Metrics matching "trace.http" \(2 of 2\)/);

  r = await run(["monitors"]);
  assert.match(r.out, /\(1 of 500\)/);
  assert.match(r.out, /NOTE: unfiltered/);
  assert.match(r.out, /\[123\] ALERT Checkout error rate/);
  assert.match(r.out, /groups_not_ok: 1/);

  r = await run(["events", "source:deploy"]);
  assert.equal(log[0].query["filter[query]"], "source:deploy");
  assert.equal(log[0].query.sort, "-timestamp");
  assert.match(r.out, /info {5}\| Deployed checkout v42 {2}service=checkout/);

  r = await run(["slos", "checkout"]);
  assert.match(r.out, /slo1 {2}Checkout availability {2}type=metric {2}targets=99.9%\/30d/);

  r = await run(["hosts", "web"]);
  assert.equal(log[0].query.filter, "web");
  assert.match(r.out, /UP {3}web-01/);

  r = await run(["dashboards", "checkout"]);
  assert.match(r.out, /abc-def-ghi {2}Checkout overview/);
  assert.doesNotMatch(r.out, /Infra/);
});

test("monitor and dashboard accept app links", async () => {
  let r = await run(["monitor", "https://app.datadoghq.com/monitors/123?view=spans"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].query.group_states, "all");
  assert.match(r.out, /URL: {5}https:\/\/app\.datadoghq\.com\/monitors\/123/);
  assert.match(r.out, /Groups: 2 total, 1 not OK/);
  assert.match(r.out, /Alert {2}host:a/);

  r = await run(["dashboard", "https://app.datadoghq.com/dashboard/abc-def-ghi/checkout-overview?from_ts=1"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Vars: {6}\$env=prod/);
  assert.match(r.out, /▸ group: Errors\n {2}• \[timeseries\] Error rate\n {6}sum:errors\{\$env\}/);
  assert.match(r.out, /• \[note\] \(untitled\)/);

  assert.equal((await run(["monitor", "abc"])).code, 2);
});

test("spans: nanosecond duration, error flag, unresolved-field diagnosis", async () => {
  const r = await run(["spans", "service:checkout"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log[0].body.data.type, "search_request");
  assert.equal(log[0].body.data.attributes.filter.query, "service:checkout");
  assert.match(r.out, /checkout {13}\| {5}12\.5ms \| ERROR POST \/pay/);
  assert.match(r.out, /NOTE: some spans had no resolvable timestamp\/duration/);
});

test("--json prints the raw API response", async () => {
  const r = await run(["monitor", "123", "--json"]);
  assert.equal(JSON.parse(r.out).query, MONITOR.query);
});

/* ------------------------------------------------------------- writes */

test("monitor mute --dry-run sends nothing and prints the exact, redacted request", async () => {
  const r = await run(["monitor", "mute", "123", "--end", "2h", "--scope", "host:web-01", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.length, 0);
  assert.match(r.out, /DRY RUN: nothing was sent/);
  assert.match(r.out, new RegExp(`POST ${base}/api/v1/monitor/123/mute`));
  assert.match(r.out, /DD-API-KEY: <redacted>/);
  assert.doesNotMatch(r.out, /APIKEY123|APPKEY456/);
  const body = JSON.parse(/Body: (.*)/.exec(r.out)[1]);
  assert.equal(body.scope, "host:web-01");
  assert.ok(Math.abs(body.end - (Date.now() / 1000 + 7200)) < 5);

  const j = await run(["mute_monitor", "123", "--dry-run", "--json"]);
  const plan = JSON.parse(j.out);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.requests[0].body, {});
});

test("monitor mute sends the body; past end is refused", async () => {
  const r = await run(["monitor", "mute", "123", "--end", "30m"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(writes().length, 1);
  assert.match(r.out, /Muted monitor \[123\] Checkout error rate until /);
  const past = await run(["monitor", "mute", "123", "--end", "2020-01-01T00:00:00Z"]);
  assert.equal(past.code, 2);
  assert.match(past.err, /resolves to the past/);
  assert.equal(log.length, 0);
});

test("monitor unmute and event post", async () => {
  let r = await run(["monitor", "unmute", "123", "--scope", "host:a"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes()[0].body, { scope: "host:a" });

  r = await run(["event", "post", "Deploy", "v42", "--tags", "env:prod,team:core", "--alert-type", "success", "--text", "Shipped **v42**"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(writes()[0].body, { title: "Deploy v42", text: "Shipped **v42**", tags: ["env:prod", "team:core"], alert_type: "success" });
  assert.match(r.out, /Posted event id=777: Deploy v42\nURL: https:\/\/app\.datadoghq\.com\/event\/event\?id=777/);

  r = await run(["post_event", "Hello", "--dry-run"]);
  assert.equal(log.length, 0);
  assert.match(r.out, /"text":"Hello","tags":\[\],"alert_type":"info"/);

  assert.equal((await run(["event", "post"])).code, 2);
  assert.equal((await run(["event", "post", "x", "--alert-type", "panic"])).code, 2);
});

/* ------------------------------------------------------------- errors & usage */

test("403 explains both causes; --json errors are structured", async () => {
  let o = "";
  let e = "";
  log = [];
  forceStatus = 403;
  const code = await main(["monitors", "--json"], { env: ENV(), stdout: { write: (s) => (o += s) }, stderr: { write: (s) => (e += s) } });
  forceStatus = null;
  assert.equal(code, 1);
  const j = JSON.parse(e);
  assert.equal(j.status, 403);
  assert.match(j.error, /lacks the scope .* or it was revoked/);
});

test("404 mentions DD_SITE; validate reports a dead app key", async () => {
  const r = await run(["dashboard", "nope-nop-nop"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /HTTP 404 \| Not found \| Not found: check the id, and that DD_SITE=datadoghq.com/);

  // Monitor read 403s while current_user works: the application key is the problem.
  const stub = async (u) =>
    String(u).includes("/api/v1/monitor")
      ? new Response('{"errors":["Forbidden"]}', { status: 403 })
      : new Response(JSON.stringify({ data: { attributes: { name: "A", email: "a@x" } } }));
  const v = await run(["validate"], ENV(), stub);
  assert.equal(v.code, 1);
  assert.match(v.err, /Credentials NOT working for read queries/);
  assert.match(v.err, /the problem is the APPLICATION key/);
});

test("429 is retried", async () => {
  rateLimitOnce = true;
  const r = await run(["hosts"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(log.length, 2);
});

test("usage errors: unknown flag, wrong flag for command, unknown command, bad limit", async () => {
  assert.equal((await run(["monitors", "--bogus"])).code, 2);
  const wrong = await run(["monitor", "mute", "123", "--from", "1h"]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /not valid for "monitor mute"/);
  const unk = await run(["mon"]);
  assert.equal(unk.code, 2);
  assert.match(unk.err, /Did you mean: monitors, monitor/);
  assert.equal((await run(["logs", "--limit", "0"])).code, 2);
  assert.equal((await run(["logs", "x", "--query", "y"])).code, 2);
  assert.equal(log.length, 0);
});

test("help: top level and per command, no credentials needed", async () => {
  const top = await run(["--help"], {});
  assert.equal(top.code, 0);
  assert.match(top.out, /monitor mute <id\|url>/);
  const one = await run(["logs", "--help"], {});
  assert.match(one.out, /Usage: datadog logs \[query\]/);
  const viaHelp = await run(["help", "event", "post"], {});
  assert.match(viaHelp.out, /Usage: datadog event post/);
});

/* ------------------------------------------------------------- pure helpers */

test("parseTime", () => {
  const near = (d, ms) => Math.abs(d.getTime() - ms) < 2000;
  assert.ok(near(parseTime("now"), Date.now()));
  assert.ok(near(parseTime("now-15m"), Date.now() - 9e5));
  assert.ok(near(parseTime("-2h"), Date.now() - 72e5));
  assert.ok(near(parseTime("3d"), Date.now() - 3 * 864e5));
  assert.ok(near(parseTime("3d ago"), Date.now() - 3 * 864e5));
  assert.equal(parseTime("1790000000").getTime(), 1790000000000);
  assert.equal(parseTime("1790000000123").getTime(), 1790000000123);
  assert.equal(parseTime("1790000000123456").getTime(), 1790000000123);
  assert.equal(parseTime("1790000000123456789").getTime(), 1790000000123);
  assert.equal(parseTime("2026-10-01T00:00:00Z").toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(parseTime("garbage"), null);
  assert.equal(parseTime(""), null);
});

test("parseEnd treats durations as forward from now", () => {
  for (const s of ["2h", "+2h", "-2h", "now+2h", "now-2h"]) assert.ok(Math.abs(parseEnd(s).getTime() - (Date.now() + 72e5)) < 2000, s);
  assert.equal(parseEnd("2030-01-01T00:00:00Z").toISOString(), "2030-01-01T00:00:00.000Z");
});

test("link parsing", () => {
  assert.equal(monitorIdFrom("https://app.datadoghq.eu/monitors/987654"), "987654");
  assert.equal(monitorIdFrom("https://evil.com/monitors/1"), null);
  assert.equal(dashboardIdFrom("https://us5.datadoghq.com/dashboard/a1b-c2d-e3f/x"), "a1b-c2d-e3f");
  assert.deepEqual(explorerFromUrl("https://app.datadoghq.com/apm/trace/abc123"), { query: "trace_id:abc123", from: undefined, to: undefined });
  assert.equal(explorerFromUrl("service:web"), null);
});
