/**
 * Builds a replay corpus from YOUR OWN pi sessions and reports how
 * bash-guardrail would have classified every bash command in them.
 *
 *   node tests/extract-corpus.mjs                 # distribution only
 *   node tests/extract-corpus.mjs --show block    # print the block decisions
 *   node tests/extract-corpus.mjs --sessions /path/to/sessions
 *
 * Use it before enabling the extension on a new machine: read the `block` list
 * and check that every entry is a command you would be happy to have refused.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { classify } from "../classify.ts";

const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const sessionsDir = argOf("--sessions", join(homedir(), ".pi", "agent", "sessions"));
const show = argOf("--show", null);
const limit = Number(argOf("--limit", 40));

const statPath = (p) => { try { if (!existsSync(p)) return "missing"; return statSync(p).isDirectory() ? "dir" : "file"; } catch { return "unknown"; } };

function* jsonlFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const commands = [];
let sessions = 0;
for (const f of jsonlFiles(sessionsDir)) {
  sessions++;
  let cwd = process.cwd();
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session" && o.cwd) cwd = o.cwd;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "toolCall" && part.name === "bash" && typeof part.arguments?.command === "string") {
        commands.push({ cwd, cmd: part.arguments.command });
      }
    }
  }
}

const tally = {};
const byIntent = {};
const buckets = { block: [], nudge: [], allow: [], THREW: [] };
for (const c of commands) {
  let d;
  try { d = classify(c.cmd, { cwd: c.cwd, statPath }); } catch (e) { d = { kind: "THREW", why: String(e) }; }
  tally[d.kind] = (tally[d.kind] ?? 0) + 1;
  if (d.kind !== "allow") byIntent[`${d.kind}:${d.intent}`] = (byIntent[`${d.kind}:${d.intent}`] ?? 0) + 1;
  buckets[d.kind]?.push({ ...c, d });
}

const pct = (n) => `${((100 * n) / (commands.length || 1)).toFixed(1)}%`;
console.log(`${sessions} session file(s), ${commands.length} bash calls (${new Set(commands.map((c) => c.cmd)).size} unique)`);
console.log(`block ${tally.block ?? 0} (${pct(tally.block ?? 0)})   nudge ${tally.nudge ?? 0} (${pct(tally.nudge ?? 0)})   allow ${tally.allow ?? 0} (${pct(tally.allow ?? 0)})   exceptions ${tally.THREW ?? 0}`);
console.log(Object.entries(byIntent).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));

if (show && buckets[show]) {
  const seen = new Set();
  let shown = 0;
  for (const r of buckets[show]) {
    if (seen.has(r.cmd) || shown >= limit) continue;
    seen.add(r.cmd);
    shown++;
    console.log(`\n[${r.d.intent ?? "-"}] ${r.cmd.replace(/\n/g, " ⏎ ").slice(0, 200)}`);
    if (r.d.call) console.log(`    => ${r.d.call.tool} ${JSON.stringify(r.d.call.args)}`);
    if (r.d.note) console.log(`    => ${r.d.note.slice(0, 200)}`);
  }
}
