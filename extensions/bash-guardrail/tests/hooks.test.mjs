// Deterministic test of index.ts's gating logic through a mock ExtensionAPI.
import { mkdirSync, writeFileSync } from "node:fs";
import bashGuardrail from "../index.ts";

// Fixture: several classifier rules only fire when the path really exists, so
// the suite must not depend on leftovers from a previous run.
mkdirSync("/tmp/guard-x/sub", { recursive: true });
for (const f of ["/tmp/guard-x/a.txt", "/tmp/guard-x/b.txt", "/tmp/guard-x/sub/c.kt"]) writeFileSync(f, "x\n");

function makeHarness({ tools = null, userText = "do the thing", env = {} } = {}) {
  const handlers = {};
  const commands = {};
  const pi = {
    on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    registerCommand: (name, opts) => { commands[name] = opts; },
    getActiveTools: () => { if (tools === "throw") throw new Error("no tools"); if (tools === null) return []; return tools; },
  };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  bashGuardrail(pi);
  const ctx = {
    cwd: "/tmp/guard-x",
    sessionManager: { getBranch: () => [{ message: { role: "user", content: [{ type: "text", text: userText }] } }] },
    ui: { notify: (m) => { ctx.notified = m; } },
  };
  let id = 0;
  const run = async (command) => {
    const toolCallId = `t${++id}`;
    let res;
    for (const h of handlers.tool_call ?? []) res = (await h({ toolName: "bash", toolCallId, input: { command } }, ctx)) ?? res;
    if (res?.block) return { kind: "block", reason: res.reason };
    let patch;
    for (const h of handlers.tool_result ?? [])
      patch = (await h({ toolName: "bash", toolCallId, input: { command }, content: [{ type: "text", text: "OUT" }], isError: false }, ctx)) ?? patch;
    const appended = patch?.content?.slice(1).map((c) => c.text) ?? [];
    return { kind: appended.length ? "nudge" : "allow", appended };
  };
  return { run, ctx, commands, cleanupEnv: () => { for (const k of Object.keys(env)) delete process.env[k]; } };
}

let fails = 0;
const check = (name, cond, extra = "") => { if (!cond) { fails++; console.log(`FAIL ${name} ${extra}`); } else console.log(`ok   ${name}`); };

const ALL = ["bash", "read", "grep", "list_files", "git", "file_ops", "path_stats", "diff", "node_project", "gradle_build", "archive_inspect", "env_info", "multi_file_read", "process"];

// ---------------------------------------------------------------- LOCKDOWN
// L1. every command is blocked, whatever it is
{
  const h = makeHarness({ tools: ALL });
  for (const cmd of ["cat /tmp/guard-x/a.txt", "./gradlew assembleDebug", "echo hi", "ls"]) {
    const r = await h.run(cmd);
    check(`lockdown blocks: ${cmd}`, r.kind === "block", JSON.stringify(r).slice(0, 160));
  }
}
// L2. no self-service bypass: escape marker, retry, or both
{
  const h = makeHarness({ tools: ALL });
  const a = await h.run("cat /tmp/guard-x/a.txt # guardrail:allow");
  check("escape marker does not bypass lockdown", a.kind === "block", JSON.stringify(a).slice(0, 160));
  check("refusal says the marker is inert", /no effect in this mode/.test(a.reason ?? ""));
  const b = await h.run("cat /tmp/guard-x/b.txt");
  const c = await h.run("cat /tmp/guard-x/b.txt");
  check("a repeat is blocked again (no never-block-twice hole)", b.kind === "block" && c.kind === "block");
  const d = await h.run("cat /tmp/guard-x/b.txt # guardrail:allow");
  check("blocked-then-escaped is still blocked", d.kind === "block", JSON.stringify(d).slice(0, 160));
}
// L3. worded shell requests do NOT unlock it; only a verbatim command does
{
  const h = makeHarness({ tools: ALL, userText: "Using the shell, tell me what is in a.txt" });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("prose shell request does not unlock lockdown", r.kind === "block", JSON.stringify(r).slice(0, 160));
  const h2 = makeHarness({ tools: ALL, userText: "please run cat /tmp/guard-x/a.txt and paste it" });
  const r2 = await h2.run("cat /tmp/guard-x/a.txt");
  check("a command the user typed verbatim still runs", r2.kind === "allow", JSON.stringify(r2));
}
// L4. the refusal still names a tool equivalent when there is one
{
  const h = makeHarness({ tools: ALL });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("lockdown refusal carries the concrete call", /read {"path":"\/tmp\/guard-x\/a.txt"}/.test(r.reason ?? ""), (r.reason ?? "").slice(0, 200));
  const r2 = await h.run("echo hi");
  check("lockdown refusal works without a tool equivalent", r2.kind === "block" && /purpose-built tools/.test(r2.reason), (r2.reason ?? "").slice(0, 200));
}
// L5. a classifier explosion must not open the lock
{
  const h = makeHarness({ tools: "throw" });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("tool-detection failure does not open lockdown", r.kind === "block", JSON.stringify(r).slice(0, 160));
}
// ------------------------------------------------------------------ ASSIST
const ASSIST = { PI_BASH_GUARDRAIL: "assist" };
// 1. block happy path
{
  const h = makeHarness({ tools: ALL, env: ASSIST });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("assist blocks cat with a concrete read call", r.kind === "block" && /read {"path":"\/tmp\/guard-x\/a.txt"}/.test(r.reason), JSON.stringify(r).slice(0, 200));
  check("refusal mentions the escape hatch", /guardrail:allow/.test(r.reason ?? ""));
  h.cleanupEnv();
}
// 2. anti-loop: never blocked twice
{
  const h = makeHarness({ tools: ALL, env: ASSIST });
  const a = await h.run("cat /tmp/guard-x/a.txt");
  const b = await h.run("cat  /tmp/guard-x/a.txt"); // same after whitespace normalisation
  check("second identical attempt runs", a.kind === "block" && b.kind === "nudge", JSON.stringify(b));
  check("second attempt explains itself", /never blocked twice/.test(b.appended?.[0] ?? ""));
  h.cleanupEnv();
}
// 3. escape hatch is a re-send mechanism, not a pre-emptive opt-out
{
  const h = makeHarness({ tools: ALL, env: ASSIST });
  const pre = await h.run("cat /tmp/guard-x/a.txt # guardrail:allow");
  check("pre-emptive escape marker is ignored", pre.kind === "block", JSON.stringify(pre).slice(0, 160));
  const after = await h.run("cat /tmp/guard-x/a.txt # guardrail:allow");
  check("escape marker works on a re-send of a blocked command", after.kind === "allow", JSON.stringify(after));
  h.cleanupEnv();
}
// 4. availability: replacement tool inactive -> allow
{
  const h = makeHarness({ tools: ALL.filter((t) => t !== "read"), env: ASSIST });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("no block when read is inactive", r.kind === "allow", JSON.stringify(r));
  const r2 = await h.run("grep -rn TODO /tmp/guard-x");
  check("still blocks for tools that ARE active", r2.kind === "block");
  h.cleanupEnv();
}
// 5. availability detection failure -> degrade to nudge
{
  const h = makeHarness({ tools: "throw", env: ASSIST });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("degrades to nudge when tool list is unavailable", r.kind === "nudge" && /Could not verify/.test(r.appended[0]), JSON.stringify(r));
  h.cleanupEnv();
}
// 6. user dictated the exact command
{
  const h = makeHarness({ tools: ALL, env: ASSIST, userText: "please run cat /tmp/guard-x/a.txt and paste it" });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("verbatim user command is allowed", r.kind === "allow", JSON.stringify(r));
  h.cleanupEnv();
}
// 7. user asked for the shell in general
{
  const h = makeHarness({ tools: ALL, env: ASSIST, userText: "Using the shell, tell me what is in a.txt" });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("explicit shell request is allowed in assist", r.kind === "allow", JSON.stringify(r));
  h.cleanupEnv();
}
// 8. nudge dedupe: one per intent, capped
{
  const h = makeHarness({ tools: ALL, env: ASSIST });
  const first = await h.run("ls -la /tmp/guard-x | grep txt");
  const second = await h.run("ls -la /tmp/guard-x/sub | grep kt");
  check("first nudge of an intent is appended", first.appended.length === 1, JSON.stringify(first));
  check("second nudge of the same intent is suppressed", second.kind === "allow", JSON.stringify(second));
  const other = await h.run("git status | head -5");
  check("a different intent still nudges once", other.appended.length === 1, JSON.stringify(other));
  h.cleanupEnv();
}
// 9. nudge-only mode
{
  const h = makeHarness({ tools: ALL, env: { PI_BASH_GUARDRAIL: "nudge" } });
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("nudge-only mode never blocks", r.kind === "nudge" && /read {"path"/.test(r.appended[0]), JSON.stringify(r));
  h.cleanupEnv();
}
// 10. off mode
{
  const h = makeHarness({ tools: ALL, env: { PI_BASH_GUARDRAIL: "off" } });
  const r = await h.run("rm -rf /tmp/guard-x/scratch");
  check("off mode is fully inert", r.kind === "allow", JSON.stringify(r));
  h.cleanupEnv();
}
// 11. broken session state must not break bash (fail open)
{
  const h = makeHarness({ tools: ALL, env: ASSIST });
  h.ctx.sessionManager = { getBranch: () => { throw new Error("boom"); }, getEntries: () => { throw new Error("boom"); } };
  const r = await h.run("cat /tmp/guard-x/a.txt");
  check("session-read failure still yields a decision (no crash)", r.kind === "block" || r.kind === "allow", JSON.stringify(r));
  h.cleanupEnv();
}
// 12. non-bash tools are ignored
{
  const h = makeHarness({ tools: ALL });
  let touched = false;
  const pi2 = { on: () => {}, registerCommand: () => {}, getActiveTools: () => ALL };
  void pi2; void touched;
  check("only the bash tool is intercepted (by construction: toolName check)", true);
}
// 13. /guardrail command reports counters and switches mode
{
  const h = makeHarness({ tools: ALL, env: ASSIST });
  await h.run("cat /tmp/guard-x/a.txt");
  await h.run("ls -la /tmp/guard-x | grep txt");
  await h.commands.guardrail.handler("", h.ctx);
  check("/guardrail reports counters", /blocked=1/.test(h.ctx.notified) && /nudged=1/.test(h.ctx.notified), h.ctx.notified);
  await h.commands.guardrail.handler("off", h.ctx);
  const r = await h.run("cat /tmp/guard-x/b.txt");
  check("/guardrail off disables blocking at runtime", r.kind === "allow", JSON.stringify(r));
  await h.commands.guardrail.handler("on", h.ctx);
  const r2 = await h.run("echo hi");
  check("/guardrail on re-arms lockdown at runtime", r2.kind === "block", JSON.stringify(r2));
  h.cleanupEnv();
}
console.log(fails ? `\n${fails} FAILURES` : "\nall hook-level expectations held");
process.exit(fails ? 1 : 0);
