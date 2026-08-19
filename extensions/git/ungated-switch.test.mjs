/**
 * Regression test for the ungated branch-switch path: checkout/switch to a branch or
 * commit must execute on the first call, while every destructive form stays behind the
 * preview + confirm gate.
 *
 *   node --experimental-strip-types ungated-switch.test.mjs   (needs jiti resolvable,
 *   e.g. run it from a dir that has pi's packages installed; see README)
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(new URL("./index.ts", import.meta.url).pathname, { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

const session = (n) => ({ getEntries: () => Array.from({ length: n }, () => ({ type: "message", message: { role: "user" } })) });
const call = (params, cwd, turns = 1) =>
  tool.execute("t", params, undefined, undefined, { cwd, hasUI: false, mode: "json", sessionManager: session(turns) })
    .then((r) => ({ text: r.content[0].text, d: r.details }));

const R = mkdtempSync(join(tmpdir(), "gitungate-"));
const git = (...a) => execFileSync("git", ["-C", R, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(R, "a.txt"), "one\n");
git("add", "-A"); git("-c","user.email=t@t","-c","user.name=t","commit","-qm","init");
git("branch", "feature");

let pass = 0, fail = 0;
const ck = (n, c, extra = "") => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.log("  FAIL", n, extra); } };

// 1. plain switch — must run with NO approval, first call
let r = await call({ action: "switch", branch: "feature" }, R);
ck("switch to a branch runs immediately", r.d.executed === true && r.d.approval === "ungated-switch", JSON.stringify(r.d));
ck("HEAD actually moved", git("branch", "--show-current") === "feature", git("branch","--show-current"));

// 2. checkout back
r = await call({ action: "checkout", branch: "main" }, R);
ck("checkout to a branch runs immediately", r.d.executed === true, JSON.stringify(r.d));
ck("HEAD back on main", git("branch", "--show-current") === "main");

// 3. create branch
r = await call({ action: "switch", branch: "newbr", flags: ["create-branch"] }, R);
ck("switch -c creates and runs immediately", r.d.executed === true && git("branch","--show-current") === "newbr", JSON.stringify(r.d));
git("checkout", "-q", "main");

// 4. STILL GATED: checkout -- <paths> (discards working-tree changes)
writeFileSync(join(R, "a.txt"), "LOCAL EDIT\n");
r = await call({ action: "checkout", paths: ["a.txt"] }, R);
ck("checkout with paths still previews", r.d.executed === undefined || r.d.executed === false, JSON.stringify(r.d).slice(0,120));
ck("the local edit survived", readFileSync(join(R, "a.txt"), "utf8") === "LOCAL EDIT\n");
ck("preview carries the DANGER note", /DISCARDS their uncommitted changes/.test(r.text), r.text.slice(0, 120));
r = await call({ action: "checkout", paths: ["a.txt"], confirm: r.d.token }, R, 1);
ck("same-turn confirm on the paths form is refused", r.d.error === "self-approval-blocked", JSON.stringify(r.d));
ck("edit STILL survived", readFileSync(join(R, "a.txt"), "utf8") === "LOCAL EDIT\n");
execFileSync("git", ["-C", R, "checkout", "--", "a.txt"]);

// 5. STILL GATED: branch_delete, reset, commit
r = await call({ action: "branch_delete", branch: "feature", flags: ["force"] }, R);
ck("branch_delete still previews", r.d.executed !== true && /PREVIEW ONLY/.test(r.text), JSON.stringify(r.d).slice(0,120));
ck("branch feature still exists", git("branch", "--list", "feature").includes("feature"));
r = await call({ action: "reset", ref: "HEAD~0", flags: ["hard"] }, R);
ck("reset --hard still previews", r.d.executed !== true, JSON.stringify(r.d).slice(0,120));
writeFileSync(join(R, "b.txt"), "b\n");
r = await call({ action: "add", paths: ["b.txt"] }, R);
ck("add still previews", r.d.executed !== true, JSON.stringify(r.d).slice(0,120));

// 6. detached checkout of a commit sha — reversible, should also be ungated
const sha = git("rev-parse", "HEAD");
r = await call({ action: "checkout", branch: sha }, R);
ck("checkout of a sha runs immediately (detached)", r.d.executed === true, JSON.stringify(r.d).slice(0,120));
ck("result reports the detached HEAD", /DETACHED HEAD/.test(r.text), r.text.slice(-150));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
