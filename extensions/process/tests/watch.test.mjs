/**
 * Non-blocking wait / background watcher tests.
 *
 *   node tests/watch.test.mjs
 *
 * What must hold:
 *   - `wait` on a running job RETURNS IMMEDIATELY in tui/rpc mode (the chat is
 *     not frozen) and says so;
 *   - when the job exits, exactly one wake-up is injected via pi.sendMessage
 *     with deliverAs:"followUp" + triggerTurn:true, carrying status + log tail;
 *   - `block:true`, print/json mode, and an already-finished job still behave
 *     synchronously;
 *   - kill/unwatch/clean disarm the watcher (no wake-up after that);
 *   - watchers are bounded and cleared on session_shutdown.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import processExtension from "../index.ts";

process.env.PI_PROCESS_DIR = mkdtempSync(join(tmpdir(), "procwatch-reg-"));
const CWD = mkdtempSync(join(tmpdir(), "procwatch-cwd-"));

function harness({ mode = "tui" } = {}) {
  const sent = [];
  const handlers = {};
  const pi = {
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn), undefined),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerTool: (t) => (pi.tool = t),
    getActiveTools: () => ["process"],
    sendMessage: (msg, opts) => sent.push({ msg, opts }),
  };
  processExtension(pi);
  const ctx = {
    cwd: CWD,
    mode,
    sessionManager: { getBranch: () => [] },
    ui: { notify: () => {} },
  };
  let n = 0;
  const call = (params) => pi.tool.execute(`c${++n}`, params, undefined, undefined, ctx);
  return { pi, ctx, sent, handlers, call };
}

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) {
    fails++;
    console.log(`FAIL ${name}${extra ? `  ${extra}` : ""}`);
  } else console.log(`ok   ${name}`);
};
const textOf = (r) => r.content.map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};

// ------------------------------------------- 1. wait does not block the chat
{
  const h = harness();
  const s = await h.call({ action: "start", command: "sleep 1.2; echo FINISHED-A; exit 3" });
  const id = s.details.id;

  const t0 = Date.now();
  const w = await h.call({ action: "wait", id });
  const elapsed = Date.now() - t0;

  check("wait returns immediately (<400ms) instead of blocking", elapsed < 400, `${elapsed}ms`);
  check("wait reports it armed a watcher", w.details.watching === true && w.details.outcome === "watching", textOf(w).slice(0, 120));
  check("wait tells the agent the chat is free", /NOT frozen/.test(textOf(w)));
  check("wait tells the agent not to poll", /Do NOT poll in a loop/.test(textOf(w)));
  check("no wake-up before the job finishes", h.sent.length === 0);

  // meanwhile the session is usable: another tool call works while it runs
  const mid = await h.call({ action: "list" });
  check("other actions work while watching", /\[watched/.test(textOf(mid)), textOf(mid).slice(0, 200));

  const woke = await until(() => h.sent.length > 0);
  check("wake-up arrives after the job exits", woke);
  if (woke) {
    const { msg, opts } = h.sent[0];
    check("wake-up is a followUp that triggers a turn", opts?.deliverAs === "followUp" && opts?.triggerTurn === true, JSON.stringify(opts));
    check("wake-up uses its own customType", msg.customType === "process-watch");
    check("wake-up is displayed", msg.display === true);
    check("wake-up carries the exit code", msg.details?.exitCode === 3 && msg.details?.outcome === "exited", JSON.stringify(msg.details));
    check("wake-up carries the log tail", /FINISHED-A/.test(msg.content), msg.content.slice(0, 160));
    check("wake-up tells the agent to resume the job", /Continue whatever you were doing/.test(msg.content));
    check("wake-up names the id", msg.content.includes(id));
  }
  await sleep(300);
  check("exactly one wake-up per job", h.sent.length === 1, `${h.sent.length}`);

  const after = await h.call({ action: "list" });
  check("watcher is disarmed after firing", !/\[watched/.test(textOf(after)));
}

// ------------------------------------------------- 2. explicit block:true
{
  const h = harness();
  const s = await h.call({ action: "start", command: "sleep 0.6; echo DONE-B" });
  const t0 = Date.now();
  const w = await h.call({ action: "wait", id: s.details.id, block: true, timeoutSec: 10 });
  const elapsed = Date.now() - t0;
  check("block:true really blocks until exit", elapsed >= 500 && w.details.outcome === "exited", `${elapsed}ms ${w.details.outcome}`);
  check("blocking wait returns the tail itself", /DONE-B/.test(textOf(w)));
  check("blocking wait arms no watcher", h.sent.length === 0);
}

// ------------------------------------- 3. print/json mode falls back to block
{
  const h = harness({ mode: "print" });
  const s = await h.call({ action: "start", command: "sleep 0.5; echo DONE-C" });
  const t0 = Date.now();
  const w = await h.call({ action: "wait", id: s.details.id, timeoutSec: 10 });
  check("print mode blocks (a wake-up would be lost there)", Date.now() - t0 >= 400 && w.details.outcome === "exited");
  const running = await h.call({ action: "start", command: "sleep 3" });
  const watch = await h.call({ action: "watch", id: running.details.id });
  check("watch refuses in print mode with a pointer to block:true", watch.isError === true && /block:true/.test(textOf(watch)), textOf(watch).slice(0, 120));
  await h.call({ action: "kill", id: running.details.id });
}

// ------------------------------------------- 4. already-finished job
{
  const h = harness();
  const s = await h.call({ action: "start", command: "echo instant" });
  await sleep(500);
  const w = await h.call({ action: "wait", id: s.details.id });
  check("wait on a finished job answers synchronously", w.details.outcome === "exited" && h.sent.length === 0, JSON.stringify(w.details));
  const watch = await h.call({ action: "watch", id: s.details.id });
  check("watch on a finished job says so instead of arming", watch.details.watching === false, textOf(watch).slice(0, 100));
}

// ------------------------------------------- 5. unwatch / kill disarm it
{
  const h = harness();
  const a = await h.call({ action: "start", command: "sleep 1" });
  await h.call({ action: "wait", id: a.details.id });
  const u = await h.call({ action: "unwatch", id: a.details.id });
  check("unwatch disarms", u.details.disarmed === 1, textOf(u));
  await sleep(1500);
  check("no wake-up after unwatch", h.sent.length === 0, JSON.stringify(h.sent.map((s) => s.msg.details)));

  const b = await h.call({ action: "start", command: "sleep 5" });
  await h.call({ action: "wait", id: b.details.id });
  await h.call({ action: "kill", id: b.details.id });
  await sleep(1200);
  check("killing a watched job does not wake the agent (kill already answered)", h.sent.length === 0, `${h.sent.length}`);
}

// ------------------------------------------- 6. bounded + shutdown cleanup
{
  const h = harness();
  const ids = [];
  for (let i = 0; i < 17; i++) {
    const s = await h.call({ action: "start", command: "sleep 4" });
    ids.push(s.details.id);
  }
  let refused = 0;
  for (const id of ids) {
    const r = await h.call({ action: "watch", id });
    if (r.isError && /too many watchers/.test(textOf(r))) refused++;
  }
  check("watcher count is capped", refused === 1, `refused=${refused}`);
  const all = await h.call({ action: "unwatch" });
  check("unwatch with no id disarms all", all.details.disarmed === 16, JSON.stringify(all.details));

  const s = await h.call({ action: "start", command: "sleep 3" });
  await h.call({ action: "watch", id: s.details.id });
  for (const fn of h.handlers.session_shutdown ?? []) fn({}, h.ctx);
  await sleep(1200);
  check("session_shutdown clears watchers", h.sent.length === 0, `${h.sent.length}`);
  for (const id of [...ids, s.details.id]) await h.call({ action: "kill", id });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
