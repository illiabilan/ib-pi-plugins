// Direct-invocation harness: loads index.ts through jiti with a stub ExtensionAPI
// and calls a tool's execute() with raw JSON args. Deterministic (no LLM involved).
//
// Usage: node harness.mjs <append_file|replace_in_file> '<json args>' [cwd]
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(join(here, "..", "index.ts"), { default: true });

const tools = new Map();
factory({
  registerTool: (t) => tools.set(t.name, t),
  on() {},
  registerCommand() {},
});

export async function callTool(name, args, cwd = process.cwd()) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no such tool: ${name} (have ${[...tools.keys()].join(", ")})`);
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return await tool.execute("test-id", prepared, undefined, undefined, { cwd, hasUI: false });
}

export function toolNames() {
  return [...tools.keys()];
}

/** The raw registered tool (for exercising renderCall/renderResult). */
export function renderers(name) {
  return tools.get(name);
}

if (process.argv[1] && process.argv[1].endsWith("harness.mjs")) {
  const [, , name, json, cwd] = process.argv;
  const res = await callTool(name, JSON.parse(json), cwd);
  console.log(res.content[0].text);
  console.log("---DETAILS---");
  console.log(JSON.stringify(res.details, null, 1));
}
