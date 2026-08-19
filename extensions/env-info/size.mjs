import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const p = process.argv[2];
const factory = await jiti.import(p, { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });
const parts = {
  name: tool.name.length,
  description: tool.description.length,
  promptSnippet: (tool.promptSnippet ?? "").length,
  promptGuidelines: (tool.promptGuidelines ?? []).join("\n").length,
  schema: JSON.stringify(tool.parameters).length,
};
const total = Object.values(parts).reduce((a, b) => a + b, 0);
console.log(p.split("/").slice(-2).join("/"), JSON.stringify(parts), "TOTAL chars", total, "~tokens", Math.round(total / 4));
