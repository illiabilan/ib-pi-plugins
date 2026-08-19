/**
 * Direct harness: run list_files' execute() without an LLM.
 * Usage: node smoke-test.mjs '{"globs":["*.kt"],"type":"file"}' [cwd]
 */
import { createJiti } from "jiti";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const here = new URL(".", import.meta.url).pathname;
const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

const args = JSON.parse(process.argv[2] ?? "{}");
const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
const started = Date.now();
const res = await tool.execute("id", prepared, undefined, undefined, {
  cwd: process.argv[3] ?? process.cwd(),
});
console.log(res.content[0].text);
console.log("---DETAILS---");
console.log(JSON.stringify(res.details, (k, v) => (k === "paths" ? undefined : v), 1));
console.log(`wall=${Date.now() - started}ms`);
