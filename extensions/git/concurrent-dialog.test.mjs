/**
 * Regression: a batch of UI-gated tool calls must not deadlock the harness.
 *
 * The bug (session 01a04364-7510-7397-97e7-277e02af0154): the model emitted four
 * `git branch_delete` calls in ONE assistant message. pi executes a batch in
 * parallel, and the TUI keeps exactly one dialog slot — showExtensionSelector()
 * overwrites this.extensionSelector and clears the editor container — so dialogs
 * 1..n-1 were evicted from the widget tree and their promises never resolved.
 * Four tool calls, zero tool results, frozen turn.
 *
 * Two independent guards are asserted here:
 *   1. every UI-gated tool declares executionMode:"sequential" (pi then runs the
 *      whole batch sequentially: agent-loop's hasSequentialToolCall);
 *   2. uiExclusive() serializes dialogs even when they are raised concurrently
 *      anyway (subagent, event handler, second extension).
 *
 * `oneSlotUi` below mimics the TUI faithfully: opening a dialog while another is
 * pending ORPHANS the older one forever. Without guard 2 this test hangs, which is
 * exactly the production symptom, so it runs under a watchdog.
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });

let pass = 0,
  fail = 0;
const ck = (n, c, x = "") => {
  if (c) {
    pass++;
    console.log("  ok  ", n);
  } else {
    fail++;
    console.log("  FAIL", n, x);
  }
};

const ROOT = new URL("../", import.meta.url).pathname;
const load = async (rel) => {
  let tool;
  const factory = await jiti.import(join(ROOT, rel, "index.ts"), { default: true });
  factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {}, registerCommands() {} });
  return tool;
};

// ---------------------------------------------------------------------------
// 1. every UI-gated tool opts out of parallel execution
// ---------------------------------------------------------------------------
const GATED = ["git", "gh", "file-ops", "jira", "slack", "gradle-build", "node-project", "subagent"];
for (const dir of GATED) {
  let tool;
  try {
    tool = await load(dir);
  } catch (e) {
    // A few extensions import runtime symbols that only resolve inside pi's virtual
    // module map (e.g. subagent -> getAgentDir), so they cannot be loaded standalone.
    // Fall back to a source-level assertion rather than silently skipping them.
    if (!/Cannot find module/.test(String(e))) {
      ck(`${dir}: loads`, false, String(e).slice(0, 160));
      continue;
    }
    const src = readFileSync(join(ROOT, dir, "index.ts"), "utf8");
    ck(
      `${dir}: executionMode is "sequential" [source check: not loadable outside pi]`,
      /^\s*executionMode:\s*"sequential",/m.test(src),
      "no executionMode in the registerTool block",
    );
    continue;
  }
  ck(
    `${dir}: executionMode is "sequential" (a UI-gated tool must never run in a parallel batch)`,
    tool?.executionMode === "sequential",
    `got ${JSON.stringify(tool?.executionMode)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. concurrent dialogs still resolve (uiExclusive)
// ---------------------------------------------------------------------------

/**
 * A ctx.ui.confirm that behaves like the real TUI: exactly one live dialog.
 * Opening a second one while the first is pending orphans the first FOREVER.
 */
function oneSlotUi(answer = true) {
  const seen = [];
  let live = null; // the only dialog the "UI" is showing
  const confirm = (title, body) => {
    const self = { title, body, orphaned: false, resolve: null };
    if (live) live.orphaned = true; // evicted from the widget tree: never resolves
    live = self;
    seen.push(self);
    return new Promise((resolve) => {
      self.resolve = resolve;
      // The user answers the visible dialog on the next macrotask.
      setTimeout(() => {
        if (self.orphaned) return; // orphaned dialogs are never answered
        live = null;
        resolve(answer);
      }, 5);
    });
  };
  return { ui: { confirm }, seen, orphans: () => seen.filter((d) => d.orphaned).length };
}

// Negative control: prove the fixture really reproduces the bug. Four RAW concurrent
// confirms (what the code did before uiExclusive) must leave 3 dialogs orphaned and
// 3 promises pending forever. If this ever "passes", oneSlotUi stopped modelling the
// TUI and the deadlock test below would be vacuous.
{
  const ctrl = oneSlotUi(true);
  let settled = 0;
  for (let i = 0; i < 4; i++) void ctrl.ui.confirm(`raw ${i}`, "").then(() => settled++);
  await new Promise((r) => setTimeout(r, 200));
  ck(
    "control: unserialized concurrent dialogs DO deadlock (fixture models the TUI)",
    settled === 1 && ctrl.orphans() === 3,
    `settled=${settled} orphaned=${ctrl.orphans()}`,
  );
}

const R = mkdtempSync(join(tmpdir(), "uiconc-"));
const g = (...a) => execFileSync("git", ["-C", R, ...a], { encoding: "utf8" }).trim();
g("init", "-q", "-b", "main");
writeFileSync(join(R, "a.txt"), "one\n");
g("add", "-A");
g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
const BRANCHES = ["b1", "b2", "b3", "b4"];
for (const b of BRANCHES) g("branch", b);

const git = await load("git");
const ui = oneSlotUi(true);
const ctx = {
  cwd: R,
  hasUI: true,
  mode: "tui",
  sessionManager: { getEntries: () => [{ type: "message", message: { role: "user" } }] },
  ui: ui.ui,
};

// Exactly the shape that froze the harness: one batch, four gated calls.
const batch = Promise.all(
  BRANCHES.map((b) => git.execute("t", { action: "branch_delete", branch: b }, undefined, undefined, ctx)),
);
const WATCHDOG = 5000;
const timedOut = Symbol("timeout");
const results = await Promise.race([
  batch,
  new Promise((r) => setTimeout(() => r(timedOut), WATCHDOG)),
]);

if (results === timedOut) {
  ck(
    `4 concurrent gated calls all return (no deadlock)`,
    false,
    `still pending after ${WATCHDOG}ms — this is the original harness freeze`,
  );
} else {
  ck("4 concurrent gated calls all return (no deadlock)", results.length === 4);
  ck("every dialog was actually shown, none orphaned", ui.orphans() === 0, `orphaned=${ui.orphans()}`);
  ck("one dialog per call", ui.seen.length === 4, `dialogs=${ui.seen.length}`);
  ck(
    "every branch really got deleted",
    results.every((r) => r.details?.executed === true) && !BRANCHES.some((b) => g("branch", "--list", b)),
    JSON.stringify(results.map((r) => r.details?.executed)),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
