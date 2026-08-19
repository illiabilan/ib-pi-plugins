/**
 * smoke-test.mjs — run env_info's execute() directly and print the raw text.
 * Usage: node smoke-test.mjs '{"action":"tools","tools":["gh","kubectl"]}' [cwd]
 */
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(new URL("index.ts", import.meta.url).pathname, { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });
const args = JSON.parse(process.argv[2] ?? '{"action":"runtime"}');
const res = await tool.execute("id", args, undefined, undefined, {
  cwd: process.argv[3] ?? process.cwd(),
  mode: "print",
  hasUI: false,
});
console.log(res.content[0].text);
console.log("---DETAILS (truncated)---");
console.log(JSON.stringify(res.details, null, 1).slice(0, 2000));
