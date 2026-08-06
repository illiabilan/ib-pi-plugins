import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import("/Users/illiabilan/StudioProjects/pi-plugins/extensions/multi-file-read/index.ts", { default: true });
let tool;
factory({ registerTool: (t) => { tool = t; }, on(){}, registerCommand(){} });
// Usage: node smoke-test.mjs '{"files":[{"path":"a.txt"}]}' [cwd]
const args = JSON.parse(process.argv[2]);
const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
const res = await tool.execute("id", prepared, undefined, undefined, { cwd: process.argv[3] ?? process.cwd() });
console.log(res.content[0].text);
console.log("---DETAILS---");
console.log(JSON.stringify(res.details, null, 1).slice(0, 1500));
