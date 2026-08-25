/**
 * The interactive write path must ask exactly once, on the FIRST call, and send
 * nothing when the user declines. Network-free: a declined dialog never invokes gh.
 */
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(new URL("./index.ts", import.meta.url).pathname, { default: true });
let tool; factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

let pass = 0, fail = 0;
const ck = (n, c, x = "") => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.log("  FAIL", n, x); } };

const prompts = [];
const ctx = {
  cwd: "/Users/illiabilan/StudioProjects/pi-plugins", hasUI: true, mode: "tui",
  sessionManager: { getEntries: () => [{ type: "message", message: { role: "user" } }] },
  ui: { confirm: async (title, body) => { prompts.push({ title, body }); return false; } },
};
const r = await tool.execute("t", { action: "pr_comment", number: 1, body: "should never be sent" }, undefined, undefined, ctx);
const txt = r.content[0].text;
ck("first call raises the dialog (no preview round-trip)", prompts.length === 1, `prompts=${prompts.length} :: ${txt.slice(0,120)}`);
ck("declining sends nothing", /declined/i.test(txt) || r.details?.gh_status === "declined", txt.slice(0, 140));
ck("the payload body is in the dialog, not only in chat", prompts[0] && /should never be sent/.test(prompts[0].body), JSON.stringify(prompts[0] ?? {}).slice(0, 140));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
