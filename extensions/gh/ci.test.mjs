/**
 * CI (Actions) actions: run_list / run_view / run_log / run_rerun / run_cancel / workflow_run.
 *
 * Network-free: a fake `gh` and a fake `git` are put first on PATH and every invocation is
 * logged, so the test asserts BOTH the rendered output and the exact argv the tool would run —
 * including the things that silently 404 in real life (a `/jobs/<n>` URL number used as --job,
 * `run rerun --job` combined with a positional run id).
 */
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import(new URL("./index.ts", import.meta.url).pathname);
const factory = mod.default ?? mod;
const { findGhWrites } = mod;
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

/* ------------------------------------------------------------------ fakes */

const dir = mkdtempSync(join(tmpdir(), "gh-ci-test-"));
const LOG = join(dir, "calls.log");

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(a) + "\\n");
const has = (f) => a.includes(f);
const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const out = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };

const job = (id, name, concl, steps) => ({ databaseId: id, name, status: "completed", conclusion: concl, steps });
const RUNS = {
  "111": { databaseId: 111, number: 7, workflowName: "CI", displayTitle: "fix: parser", headBranch: "feature/ci",
    headSha: "abc1234567", event: "push", status: "completed", conclusion: "failure", attempt: 1,
    createdAt: "2024-05-01T10:00:00Z", updatedAt: "2024-05-01T10:12:00Z",
    url: "https://github.com/acme/app/actions/runs/111",
    jobs: [ job(9001, "build (ubuntu)", "failure", [{ number: 3, name: "Run tests", status: "completed", conclusion: "failure" }]),
            job(9002, "lint", "success", []) ] },
  "222": { databaseId: 222, number: 8, workflowName: "CI", displayTitle: "chore: deps", headBranch: "main",
    headSha: "def7654321", event: "push", status: "completed", conclusion: "success", attempt: 1,
    createdAt: "2024-05-02T10:00:00Z", updatedAt: "2024-05-02T10:05:00Z",
    url: "https://github.com/acme/app/actions/runs/222", jobs: [ job(9100, "build (ubuntu)", "success", []) ] },
  "333": { databaseId: 333, number: 9, workflowName: "Deploy", displayTitle: "deploy staging", headBranch: "feature/ci",
    headSha: "aaa1111111", event: "workflow_dispatch", status: "in_progress", conclusion: null, attempt: 1,
    createdAt: "2024-05-03T10:00:00Z", updatedAt: "2024-05-03T10:01:00Z",
    url: "https://github.com/acme/app/actions/runs/333",
    jobs: [ { databaseId: 9300, name: "deploy", status: "in_progress", conclusion: null, steps: [] } ] },
};
const strip = (r) => { const { jobs, ...rest } = r; return rest; };

if (a[0] === "repo" && a[1] === "view")
  out({ nameWithOwner: "acme/app", defaultBranchRef: { name: "main" }, url: "https://github.com/acme/app" });

if (a[0] === "run" && a[1] === "list") {
  let list = [RUNS["333"], RUNS["111"], RUNS["222"]].map(strip);
  const st = val("--status"); if (st) list = list.filter((r) => (r.conclusion || r.status) === st);
  const br = val("--branch"); if (br) list = list.filter((r) => r.headBranch === br);
  const wf = val("--workflow"); if (wf) list = list.filter((r) => r.workflowName === wf);
  const lim = Number(val("--limit") || 20);
  out(list.slice(0, lim));
}
if (a[0] === "run" && a[1] === "view") {
  if (has("--log")) out("build (ubuntu)\\tRun tests\\tFAIL src/parser.test.ts:12 expected 2 got 3\\n");
  if (has("--log-failed")) {
    const id = a[2];
    if (RUNS[id] && RUNS[id].status !== "completed") { process.stderr.write("run " + id + " is still in progress\\n"); process.exit(1); }
    out("build (ubuntu)\\tRun tests\\tFAILED: 1 test failed (log-failed)\\n");
  }
  const r = RUNS[a[2]];
  if (!r) { process.stderr.write("could not find any workflow run\\n"); process.exit(1); }
  out(r);
}
if (a[0] === "run" && a[1] === "rerun") out("\\u2713 Requested rerun of run " + (val("--job") ? "(job " + val("--job") + ")" : a[2]) + "\\n");
if (a[0] === "run" && a[1] === "cancel") out("\\u2713 Cancelled run " + a[2] + "\\n");
if (a[0] === "workflow" && a[1] === "list")
  out([{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
       { id: 2, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active" }]);
if (a[0] === "workflow" && a[1] === "run") out("\\u2713 Created workflow_dispatch event for " + a[2] + "\\n");
if (a[0] === "pr" && a[1] === "checks")
  out([{ name: "build", state: "FAILURE", bucket: "fail", workflow: "CI", link: "https://github.com/acme/app/actions/runs/111/job/9001" },
       { name: "lint", state: "SUCCESS", bucket: "pass", workflow: "CI", link: "https://github.com/acme/app/actions/runs/111/job/9002" }]);
process.stderr.write("fake gh: unhandled " + a.join(" ") + "\\n");
process.exit(1);
`;

const FAKE_GIT = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") { process.stdout.write("feature/ci\\n"); process.exit(0); }
if (a[0] === "rev-parse") { process.stdout.write("abc1234\\n"); process.exit(0); }
if (a[0] === "remote") { process.stdout.write("origin git@github.com:acme/app.git (fetch)\\n"); process.exit(0); }
process.exit(0);
`;

writeFileSync(join(dir, "gh"), FAKE_GH);
writeFileSync(join(dir, "git"), FAKE_GIT);
chmodSync(join(dir, "gh"), 0o755);
chmodSync(join(dir, "git"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.GH_FAKE_LOG = LOG;

const calls = () =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const reset = () => existsSync(LOG) && rmSync(LOG);
const called = (pred) => calls().some(pred);

/* ------------------------------------------------------------------ harness */

let pass = 0,
  fail = 0;
const ck = (n, c, x = "") => {
  if (c) {
    pass++;
    console.log("  ok  ", n);
  } else {
    fail++;
    console.log("  FAIL", n, x ? `:: ${String(x).slice(0, 400)}` : "");
  }
};

const headless = { cwd: dir, hasUI: false, mode: "print", ui: {} };
const interactive = (answer = true, sink = []) => ({
  cwd: dir,
  hasUI: true,
  mode: "tui",
  prompts: sink,
  ui: { confirm: async (title, body) => (sink.push({ title, body }), answer) },
});
const call = async (params, ctx = headless) => {
  reset();
  const r = await tool.execute("t", params, undefined, undefined, ctx);
  return r.content[0].text;
};

/* -------------------------------------------------------------------- reads */

console.log("\nrun_list");
{
  const t = await call({ action: "run_list", limit: 5 });
  ck("lists runs with state icons + ids", /run 111/.test(t) && /run 222/.test(t) && /\[failure\]/.test(t), t);
  ck("points at run_view for the first failure", /"action":"run_view","number":111/.test(t), t);
  const t2 = await call({ action: "run_list", status: "failure", branch: "feature/ci" });
  ck("passes --status/--branch through", called((c) => c.includes("--status") && c.includes("failure") && c.includes("--branch")), JSON.stringify(calls()));
  ck("filters to the failing run", /run 111/.test(t2) && !/run 222/.test(t2), t2);
  const t3 = await call({ action: "run_list", status: "bogus" });
  ck("rejects an invalid status locally (no gh call)", /status must be one of/.test(t3) && calls().length === 0, t3);
}

console.log("\nrun_view");
{
  const t = await call({ action: "run_view", number: 111 });
  ck("shows the failing job and its failed step", /build \(ubuntu\)/.test(t) && /failed step #3: Run tests/.test(t), t);
  ck("exposes the job databaseId", /job id 9001/.test(t), t);
  ck("suggests rerunning only failed jobs", /"action":"run_rerun","number":111,"failed_only":true/.test(t), t);
  const t2 = await call({ action: "run_view" });
  ck("without number resolves the latest run of the current branch", /Run:\s+333/.test(t2) && /resolved as the latest run/.test(t2), t2);
  ck("says an unfinished run has no logs yet", /not finished yet/.test(t2), t2);
}

console.log("\nrun_log");
{
  const t = await call({ action: "run_log", number: 111 });
  ck("uses --log-failed for the whole run", called((c) => c.includes("--log-failed") && c.includes("111")), JSON.stringify(calls()));
  ck("returns the failing log", /FAILED: 1 test failed/.test(t), t);
  const t2 = await call({ action: "run_log", number: 111, job: "build" });
  ck("resolves a job NAME to its databaseId", called((c) => c.includes("--job") && c.includes("9001") && c.includes("--log")), JSON.stringify(calls()));
  ck("does not pass a positional run id together with --job", !called((c) => c.includes("--job") && c.includes("111")), JSON.stringify(calls()));
  ck("labels the job log", /full log of job "build \(ubuntu\)"/.test(t2), t2);
  const t3 = await call({ action: "run_log", number: 111, job: 424242 });
  ck("rejects a job id that is not in the run (the /jobs/<n> URL trap)", /not a job of this run/.test(t3) && /9001/.test(t3), t3);
  ck("never fetched a log for the bogus job", !called((c) => c.includes("--log")), JSON.stringify(calls()));
  const t4 = await call({ action: "run_log", number: 333 });
  ck("in-progress run: explains instead of erroring", /has not completed/.test(t4) && /gh_status: ok/.test(t4), t4);
}

console.log("\nworkflow_list + pr_checks chaining");
{
  const t = await call({ action: "workflow_list" });
  ck("lists workflows with path and state", /CI/.test(t) && /\.github\/workflows\/ci\.yml/.test(t), t);
  const t2 = await call({ action: "pr_checks", number: 5 });
  ck("pr_checks surfaces the failing Actions run id", /Failing Actions run id\(s\): 111/.test(t2), t2);
  ck("pr_checks offers the rerun call", /"action":"run_rerun","number":111,"failed_only":true/.test(t2), t2);
}

/* ------------------------------------------------------------------- writes */

console.log("\nrun_rerun (preview gate)");
{
  const t = await call({ action: "run_rerun", number: 111, failed_only: true });
  ck("previews instead of running", /gh_status: preview_pending_approval/.test(t), t);
  ck("preview names the scope and the failing job", /ONLY the failed jobs \(build \(ubuntu\)\)/.test(t), t);
  ck("preview warns about CI minutes / deploys", /RE-RUNS GitHub Actions/.test(t), t);
  ck("nothing was rerun", !called((c) => c[0] === "run" && c[1] === "rerun"), JSON.stringify(calls()));

  const t2 = await call({ action: "run_rerun", number: 222, failed_only: true });
  ck("failed_only on a green run is refused up front", /has no failed jobs/.test(t2) && /gh_status: error/.test(t2), t2);
  ck("...and never calls gh rerun", !called((c) => c[1] === "rerun"), JSON.stringify(calls()));

  const t3 = await call({ action: "run_rerun", number: 111, job: "nope" });
  ck("unknown job name is refused with an inventory", /No job named "nope"/.test(t3) && /9002  lint/.test(t3), t3);
}

console.log("\nrun_rerun (interactive approval)");
{
  const sink = [];
  const t = await call({ action: "run_rerun", number: 111, failed_only: true }, interactive(true, sink));
  ck("one dialog, on the first call", sink.length === 1, `prompts=${sink.length}`);
  ck("dialog shows run + scope", /run 111|Run:\s+111/i.test(sink[0]?.body ?? "") && /ONLY the failed jobs/.test(sink[0]?.body ?? ""), sink[0]?.body);
  ck("approved -> gh run rerun 111 --failed", called((c) => c[0] === "run" && c[1] === "rerun" && c.includes("111") && c.includes("--failed")), JSON.stringify(calls()));
  ck("reports success", /Rerun requested/.test(t), t);

  const sink2 = [];
  const t2 = await call({ action: "run_rerun", number: 111, job: "lint" }, interactive(false, sink2));
  ck("declining sends nothing", /declined/i.test(t2) && !called((c) => c[1] === "rerun"), t2);
}

console.log("\nrun_cancel");
{
  const t = await call({ action: "run_cancel", number: 111 });
  ck("refuses to cancel a finished run", /already finished/.test(t) && !called((c) => c[1] === "cancel"), t);
  const t2 = await call({ action: "run_cancel", number: 333 });
  ck("previews cancelling an in-progress run", /gh_status: preview_pending_approval/.test(t2) && /CANCEL this in-progress run/.test(t2), t2);
  const t3 = await call({ action: "run_cancel", number: 333 }, interactive(true));
  ck("approved -> gh run cancel 333", called((c) => c[0] === "run" && c[1] === "cancel" && c.includes("333")) && /Cancel requested/.test(t3), t3);
}

console.log("\nworkflow_run");
{
  const t = await call({ action: "workflow_run", workflow: "deploy.yml", ref: "main", inputs: { environment: "staging", verbose: "true" } });
  ck("previews the dispatch", /gh_status: preview_pending_approval/.test(t) && /DISPATCHES a real workflow run/.test(t), t);
  ck("preview lists ref and inputs", /Ref:\s+main/.test(t) && /environment = staging/.test(t) && /verbose = true/.test(t), t);
  ck("nothing dispatched", !called((c) => c[0] === "workflow" && c[1] === "run"), JSON.stringify(calls()));

  const t2 = await call({ action: "workflow_run", workflow: "deploy.yml", inputs: { environment: "staging" } }, interactive(true));
  ck("approved -> gh workflow run with -f pairs", called((c) => c[0] === "workflow" && c[1] === "run" && c.includes("-f") && c.includes("environment=staging")), JSON.stringify(calls()));
  ck("defaults the ref to the current branch", called((c) => c.includes("--ref") && c.includes("feature/ci")), JSON.stringify(calls()));
  ck("reports dispatch", /Workflow dispatched/.test(t2), t2);

  const t3 = await call({ action: "workflow_run" });
  ck("workflow is required", /workflow is required/.test(t3), t3);
}

/* -------------------------------------------------------------- bash guard */

console.log("\nbash guard covers CI mutations");
{
  ck("blocks gh run rerun", findGhWrites("gh run rerun 111 --failed").length === 1);
  ck("blocks gh run cancel inside a wrapper", findGhWrites('bash -c "gh run cancel 333"').length === 1);
  ck("blocks gh workflow run", findGhWrites("gh workflow run deploy.yml --ref main").length === 1);
  ck("allows read-only gh run list/view", findGhWrites("gh run list -L 5 && gh run view 111 --log-failed").length === 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
