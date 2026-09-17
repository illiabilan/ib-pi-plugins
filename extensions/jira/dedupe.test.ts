/**
 * Regression tests for the local duplicate-detection helpers used by
 * `jira action=find_duplicates`. No network, no credentials.
 *
 * Run (from the repo root, one-time setup so `typebox` / `@earendil-works/pi-tui` resolve):
 *   ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules" node_modules
 *   node --experimental-strip-types extensions/jira/dedupe.test.ts
 */
import { toDoc, findDuplicateClusters, adfToText, normalizeText } from "./index.ts";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

const mk = (key: string, summary: string, opts: any = {}) => ({
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
const keysOf = (c: any) => c.members.map((m: any) => m.key).sort().join(",");

// ---- 1. obvious duplicates cluster, unrelated issues do not ------------------
const issues = [
  mk("ADA-1", "Add promo banner to the cart screen", { created: "2024-01-01T00:00:00.000+0000" }),
  mk("ADA-2", "Add promotional banner in cart screen", { created: "2024-03-05T00:00:00.000+0000" }),
  mk("ADA-3", "Promo banners are not shown on the cart screen", { created: "2024-04-09T00:00:00.000+0000" }),
  mk("ADA-4", "Migrate CreditRepositoryTest to Kotlin"),
  mk("ADA-5", "Upgrade Gradle to 8.7"),
  mk("ADA-6", "Crash when opening subscription settings offline"),
  mk("ADA-7", "App crashes opening subscription settings while offline"),
];
const docs = issues.map(toDoc);
const { clusters, compared } = findDuplicateClusters(docs, 0.55);
const all = clusters.map(keysOf);
console.log("clusters:", all, "| compared pairs:", compared);
check("promo-banner pair clusters", all.some((s) => s.includes("ADA-1") && s.includes("ADA-2")));
check("crash pair clusters", all.some((s) => s === "ADA-6,ADA-7"));
check("unrelated issues excluded", !all.some((s) => s.includes("ADA-4") || s.includes("ADA-5")));

// ---- 2. canonical selection: most progressed > most linked > oldest ----------
const c2 = findDuplicateClusters(
  [
    mk("ADA-10", "Fix login timeout on slow network", { created: "2024-05-01T00:00:00.000+0000" }),
    mk("ADA-11", "Fix login timeout on a slow network", {
      created: "2024-02-01T00:00:00.000+0000",
      cat: "In Progress",
      status: "In Progress",
    }),
  ].map(toDoc),
  0.55,
).clusters;
check("canonical = in-progress one, not merely oldest", c2[0]?.canonical.key === "ADA-11", `got ${c2[0]?.canonical.key}`);

const c3 = findDuplicateClusters(
  [
    mk("ADA-20", "Refactor payment sheet layout", { created: "2024-05-01T00:00:00.000+0000" }),
    mk("ADA-21", "Refactor the payment sheet layout", { created: "2024-02-01T00:00:00.000+0000" }),
  ].map(toDoc),
  0.55,
).clusters;
check("canonical = oldest when status ties", c3[0]?.canonical.key === "ADA-21", `got ${c3[0]?.canonical.key}`);

// ---- 3. already-linked duplicates are flagged --------------------------------
const linked = findDuplicateClusters(
  [
    mk("ADA-30", "Empty state missing on orders list"),
    mk("ADA-31", "Orders list is missing an empty state", {
      links: [{ type: { name: "Duplicate", outward: "duplicates" }, outwardIssue: { key: "ADA-30" } }],
    }),
  ].map(toDoc),
  0.55,
).clusters;
check("existing Duplicate link detected", linked[0]?.alreadyLinked === true);

// ---- 4. threshold behaves monotonically --------------------------------------
const loose = findDuplicateClusters(docs, 0.4).clusters.length;
const tight = findDuplicateClusters(docs, 0.85).clusters.length;
check("lower threshold >= higher threshold cluster count", loose >= tight, `${loose} vs ${tight}`);

// ---- 5. issue keys / URLs / stopwords do not create false matches ------------
const noise = findDuplicateClusters(
  [
    mk("ADA-40", "ADA-999 see https://x.example.com/a for the thing"),
    mk("ADA-41", "ADA-999 see https://x.example.com/b for the thing"),
    mk("ADA-42", "Kafka consumer lag alert tuning"),
  ].map(toDoc),
  0.55,
).clusters;
check("unrelated third issue not pulled in", !noise.some((c) => keysOf(c).includes("ADA-42")));

// ---- 6. version numbers stay distinct ----------------------------------------
const versions = findDuplicateClusters(
  [mk("ADA-50", "Upgrade Gradle to 8.7"), mk("ADA-51", "Upgrade Gradle to 8.9")].map(toDoc),
  0.01,
).clusters;
check("8.7 vs 8.9 scores below near-identical", (versions[0]?.maxScore ?? 1) < 0.8, `score ${versions[0]?.maxScore}`);

// ---- 7. ADF description flattening -------------------------------------------
const adf = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Steps to reproduce:" }] },
    { type: "paragraph", content: [{ type: "text", text: "open cart, tap promo" }] },
  ],
};
check(
  "ADF flattens to plain text",
  adfToText(adf).includes("Steps to reproduce") && adfToText(adf).includes("tap promo"),
  JSON.stringify(adfToText(adf)),
);
check(
  "normalizeText strips keys/urls/punctuation",
  normalizeText("ADA-12: Fix, the https://a.b thing!") === "fix the thing",
  `got "${normalizeText("ADA-12: Fix, the https://a.b thing!")}"`,
);

// ---- 8. template series (same wording, different target) are flagged ---------
const series = findDuplicateClusters(
  [
    mk("A-1", "Send New Relic event measuring time to load Perks results for the Redeem screen"),
    mk("A-2", "Send New Relic event measuring time to load Perks results for the Save screen"),
    mk("A-3", "Send New Relic event measuring time to load Perks results for the Earn screen"),
  ].map(toDoc),
  0.6,
).clusters[0];
check("template series flagged", series?.siblingSeries === true);
check("distinguishing terms extracted", series.distinct.every((d: any) => d.only.length === 1), JSON.stringify(series.distinct));
const real = findDuplicateClusters(
  [
    mk("B-1", "Crash when opening subscription settings offline"),
    mk("B-2", "App crashes opening subscription settings while offline"),
  ].map(toDoc),
  0.6,
).clusters[0];
check("true duplicate NOT flagged as series", real?.siblingSeries === false, JSON.stringify(real?.distinct));
const exact = findDuplicateClusters(
  [mk("C-1", "Update the payment sheet"), mk("C-2", "Update the payment sheet")].map(toDoc),
  0.6,
).clusters[0];
check("identical summaries: no distinguishing terms", exact?.siblingSeries === false);

// ---- 9. scale / prefilter sanity (1000 issues must stay fast) ----------------
const big = Array.from({ length: 1000 }, (_, i) =>
  mk(
    `BIG-${i}`,
    i % 100 === 7
      ? "Duplicated tracking event for checkout success"
      : `Unrelated backlog item number ${i} about ${["cache", "layout", "retry", "logging"][i % 4]}`,
  ),
).map(toDoc);
const t0 = Date.now();
const bigRes = findDuplicateClusters(big, 0.6);
const ms = Date.now() - t0;
console.log(`1000 issues: ${bigRes.clusters.length} clusters, ${bigRes.compared} pairs compared, ${ms}ms`);
check("1000-issue scan under 3s", ms < 3000, `${ms}ms`);
check("planted 10-issue duplicate group found", bigRes.clusters.some((c) => c.members.length === 10), `sizes: ${bigRes.clusters.map((c) => c.members.length)}`);

// ---- 10. degenerate input -----------------------------------------------------
check("empty input safe", findDuplicateClusters([], 0.55).clusters.length === 0);
check("single issue safe", findDuplicateClusters([toDoc(mk("A-1", "solo"))], 0.55).clusters.length === 0);
check("empty summaries do not cluster", findDuplicateClusters([mk("A-1", ""), mk("A-2", "")].map(toDoc), 0.55).clusters.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
