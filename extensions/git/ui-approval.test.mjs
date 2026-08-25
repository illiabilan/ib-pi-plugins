/**
 * Approval UX: an interactive session must ask exactly ONCE, via the dialog, on the
 * first call — no prose preview + token round-trip. Headless sessions keep the token
 * flow, including the same-turn self-approval refusal.
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const jiti = createJiti(import.meta.url, { interopDefault: true });

let pass = 0, fail = 0;
const ck = (n, c, x = "") => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.log("  FAIL", n, x); } };

const load = async (file) => { let t; const f = await jiti.import(file, { default: true }); f({ registerTool: (x) => (t = x), on() {}, registerCommand() {} }); return t; };

// ---------- git ----------
const git = await load(new URL("./index.ts", import.meta.url).pathname);
const R = mkdtempSync(join(tmpdir(), "uiapprove-"));
const g = (...a) => execFileSync("git", ["-C", R, ...a], { encoding: "utf8" }).trim();
g("init", "-q", "-b", "main"); writeFileSync(join(R, "a.txt"), "one\n");
g("add","-A"); g("-c","user.email=t@t","-c","user.name=t","commit","-qm","init");

const uiCtx = (answer, prompts) => ({
  cwd: R, hasUI: true, mode: "tui",
  sessionManager: { getEntries: () => [{ type: "message", message: { role: "user" } }] },
  ui: { confirm: async (title, body) => { prompts.push({ title, body }); return answer; } },
});
const headlessCtx = (turns = 1) => ({
  cwd: R, hasUI: false, mode: "json",
  sessionManager: { getEntries: () => Array.from({ length: turns }, () => ({ type: "message", message: { role: "user" } })) },
});

let prompts = [];
writeFileSync(join(R, "b.txt"), "b\n");
let r = await git.execute("t", { action: "add", paths: ["b.txt"] }, undefined, undefined, uiCtx(true, prompts));
ck("git: TUI shows exactly ONE dialog on the first call", prompts.length === 1, JSON.stringify(prompts.length));
ck("git: TUI first call EXECUTES after the dialog (no token round-trip)", r.details.executed === true && g("status","--porcelain").includes("A  b.txt"), JSON.stringify(r.details));
ck("git: no PREVIEW ONLY text in the TUI path", !/PREVIEW ONLY/.test(r.content[0].text), r.content[0].text.slice(0, 80));

prompts = [];
r = await git.execute("t", { action: "commit", message: "nope" }, undefined, undefined, uiCtx(false, prompts));
ck("git: declining the dialog blocks execution", r.details.declined === true && g("log","--oneline").split("\n").length === 1, JSON.stringify(r.details));

r = await git.execute("t", { action: "commit", message: "headless" }, undefined, undefined, headlessCtx(1));
ck("git: headless still previews with a token", /PREVIEW ONLY/.test(r.content[0].text) && !!r.details.token, JSON.stringify(r.details).slice(0, 100));
const tok = r.details.token;
r = await git.execute("t", { action: "commit", message: "headless", confirm: tok }, undefined, undefined, headlessCtx(1));
ck("git: headless same-turn replay still refused", r.details.error === "self-approval-blocked", JSON.stringify(r.details));
r = await git.execute("t", { action: "commit", message: "headless", confirm: tok }, undefined, undefined, headlessCtx(2));
ck("git: headless next-turn confirm executes", r.details.executed === true, JSON.stringify(r.details).slice(0, 120));


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
