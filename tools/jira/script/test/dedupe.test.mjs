/** Duplicate-detection, ADF and Details-field helpers. No network, no credentials. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateClusters, normalizeText, toDoc } from "../dedupe.mjs";
import { adfToText, detailSections } from "../format.mjs";

const mk = (key, summary, opts = {}) => ({
  key,
  fields: {
    summary,
    description: opts.description ?? null,
    status: { name: opts.status ?? "To Do", statusCategory: { name: opts.cat ?? "To Do" } },
    issuetype: { name: opts.type ?? "Story" },
    assignee: opts.assignee ? { displayName: opts.assignee } : null,
    reporter: { displayName: "R" },
    created: opts.created ?? "2024-01-01T00:00:00.000+0000",
    updated: "2024-06-01T00:00:00.000+0000",
    labels: opts.labels ?? [],
    issuelinks: opts.links ?? [],
  },
});
const keysOf = (c) => c.members.map((m) => m.key).sort().join(",");
const clusters = (issues, t) => findDuplicateClusters(issues.map(toDoc), t).clusters;

const BASE = [
  mk("PROJ-1", "Add promo banner to the cart screen", { created: "2024-01-01T00:00:00.000+0000" }),
  mk("PROJ-2", "Add promotional banner in cart screen", { created: "2024-03-05T00:00:00.000+0000" }),
  mk("PROJ-3", "Promo banners are not shown on the cart screen", { created: "2024-04-09T00:00:00.000+0000" }),
  mk("PROJ-4", "Migrate CreditRepositoryTest to Kotlin"),
  mk("PROJ-5", "Upgrade Gradle to 8.7"),
  mk("PROJ-6", "Crash when opening subscription settings offline"),
  mk("PROJ-7", "App crashes opening subscription settings while offline"),
];

test("obvious duplicates cluster, unrelated issues do not", () => {
  const all = clusters(BASE, 0.55).map(keysOf);
  assert.ok(all.some((s) => s.includes("PROJ-1") && s.includes("PROJ-2")), "promo-banner pair clusters");
  assert.ok(all.some((s) => s === "PROJ-6,PROJ-7"), "crash pair clusters");
  assert.ok(!all.some((s) => s.includes("PROJ-4") || s.includes("PROJ-5")), "unrelated issues excluded");
});

test("canonical: most progressed beats oldest; oldest wins on a status tie", () => {
  const c2 = clusters([
    mk("PROJ-10", "Fix login timeout on slow network", { created: "2024-05-01T00:00:00.000+0000" }),
    mk("PROJ-11", "Fix login timeout on a slow network", { created: "2024-02-01T00:00:00.000+0000", cat: "In Progress", status: "In Progress" }),
  ], 0.55);
  assert.equal(c2[0]?.canonical.key, "PROJ-11");
  const c3 = clusters([
    mk("PROJ-20", "Refactor payment sheet layout", { created: "2024-05-01T00:00:00.000+0000" }),
    mk("PROJ-21", "Refactor the payment sheet layout", { created: "2024-02-01T00:00:00.000+0000" }),
  ], 0.55);
  assert.equal(c3[0]?.canonical.key, "PROJ-21");
});

test("already-linked duplicates are flagged", () => {
  const linked = clusters([
    mk("PROJ-30", "Empty state missing on orders list"),
    mk("PROJ-31", "Orders list is missing an empty state", { links: [{ type: { name: "Duplicate", outward: "duplicates" }, outwardIssue: { key: "PROJ-30" } }] }),
  ], 0.55);
  assert.equal(linked[0]?.alreadyLinked, true);
});

test("threshold behaves monotonically", () => {
  assert.ok(clusters(BASE, 0.4).length >= clusters(BASE, 0.85).length);
});

test("issue keys / URLs / stopwords do not create false matches", () => {
  const noise = clusters([
    mk("PROJ-40", "PROJ-999 see https://x.example.com/a for the thing"),
    mk("PROJ-41", "PROJ-999 see https://x.example.com/b for the thing"),
    mk("PROJ-42", "Kafka consumer lag alert tuning"),
  ], 0.55);
  assert.ok(!noise.some((c) => keysOf(c).includes("PROJ-42")));
});

test("version numbers stay distinct", () => {
  const v = clusters([mk("PROJ-50", "Upgrade Gradle to 8.7"), mk("PROJ-51", "Upgrade Gradle to 8.9")], 0.01);
  assert.ok((v[0]?.maxScore ?? 1) < 0.8, `score ${v[0]?.maxScore}`);
});

test("ADF flattens to plain text; normalizeText strips keys/urls/punctuation", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Steps to reproduce:" }] },
      { type: "paragraph", content: [{ type: "text", text: "open cart, tap promo" }] },
    ],
  };
  const t = adfToText(adf);
  assert.ok(t.includes("Steps to reproduce") && t.includes("tap promo"), JSON.stringify(t));
  assert.equal(normalizeText("PROJ-12: Fix, the https://a.b thing!"), "fix the thing");
});

test("template series flagged; true and identical duplicates are not", () => {
  const series = clusters([
    mk("A-1", "Send New Relic event measuring time to load Perks results for the Redeem screen"),
    mk("A-2", "Send New Relic event measuring time to load Perks results for the Save screen"),
    mk("A-3", "Send New Relic event measuring time to load Perks results for the Earn screen"),
  ], 0.6)[0];
  assert.equal(series?.siblingSeries, true);
  assert.ok(series.distinct.every((d) => d.only.length === 1), JSON.stringify(series.distinct));
  const real = clusters([mk("B-1", "Crash when opening subscription settings offline"), mk("B-2", "App crashes opening subscription settings while offline")], 0.6)[0];
  assert.equal(real?.siblingSeries, false, JSON.stringify(real?.distinct));
  const exact = clusters([mk("C-1", "Update the payment sheet"), mk("C-2", "Update the payment sheet")], 0.6)[0];
  assert.equal(exact?.siblingSeries, false);
});

test("1000-issue scan stays fast and finds the planted group", () => {
  const big = Array.from({ length: 1000 }, (_, i) =>
    mk(`BIG-${i}`, i % 100 === 7 ? "Duplicated tracking event for checkout success" : `Unrelated backlog item number ${i} about ${["cache", "layout", "retry", "logging"][i % 4]}`),
  );
  const t0 = Date.now();
  const res = clusters(big, 0.6);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `${ms}ms`);
  assert.ok(res.some((c) => c.members.length === 10), `sizes: ${res.map((c) => c.members.length)}`);
});

test("degenerate input is safe", () => {
  assert.equal(findDuplicateClusters([], 0.55).clusters.length, 0);
  assert.equal(clusters([mk("A-1", "solo")], 0.55).length, 0);
  assert.equal(clusters([mk("A-1", ""), mk("A-2", "")], 0.55).length, 0);
});

test("bug Details tab fields render in order, empty and non-detail fields skipped", () => {
  const names = {
    customfield_10230: "Preconditions",
    customfield_10236: "Steps to Reproduce",
    customfield_10237: "Expected Result",
    customfield_10298: "Actual Result",
    customfield_10160: "Severity",
  };
  const fields = {
    customfield_10236: "1. Open menu\n2. Expand two sections",
    customfield_10237: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Both stay open" }] }] },
    customfield_10298: "First one collapses",
    customfield_10230: null,
    customfield_10160: { value: "3 - minor" },
  };
  const out = detailSections(fields, names).join("\n");
  assert.ok(out.includes("Steps to Reproduce:\n1. Open menu\n2. Expand two sections"), out);
  assert.ok(out.includes("Expected Result:\nBoth stay open"), out);
  assert.ok(out.includes("Actual Result:\nFirst one collapses"), out);
  assert.ok(!out.includes("Preconditions"), out);
  assert.ok(!out.includes("Severity"), out);
  assert.ok(out.indexOf("Steps") < out.indexOf("Expected") && out.indexOf("Expected") < out.indexOf("Actual"));
  assert.equal(detailSections({ summary: "x" }, { summary: "Summary" }).length, 0);
});
