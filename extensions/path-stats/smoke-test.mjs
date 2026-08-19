// Usage: node smoke-test.mjs '{"paths":["README.md"],"metrics":["lines","bytes"]}' [cwd]
import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => { tool = t; }, on() {}, registerCommand() {} });

const args = JSON.parse(process.argv[2]);
const t0 = Date.now();
const res = await tool.execute("id", args, undefined, undefined, { cwd: process.argv[3] ?? process.cwd() });
console.log(res.content[0].text);
console.log(`---(${Date.now() - t0}ms)---DETAILS---`);
console.log(JSON.stringify(res.details, null, 1).slice(0, 3000));
