/**
 * Scores the classifier against `labeled.json`: 200 real bash commands taken
 * from ~/.pi/agent/sessions and hand-labelled block/nudge/allow.
 *
 *   node tests/replay-labeled.mjs [--verbose]
 *
 * BLOCK precision is the acceptance criterion: a false block costs the agent a
 * turn, so the false-block list must stay empty.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../classify.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, "labeled.json"), "utf8"));
const verbose = process.argv.includes("--verbose");

const statPath = (p) => {
  try {
    if (!existsSync(p)) return "missing";
    return statSync(p).isDirectory() ? "dir" : "file";
  } catch {
    return "unknown";
  }
};

const scored = rows.map((r) => {
  let d;
  try {
    d = classify(r.cmd, { cwd: r.cwd, statPath });
  } catch (e) {
    d = { kind: "THREW", why: String(e) };
  }
  return { ...r, pred: d.kind, d };
});

const conf = {};
for (const r of scored) conf[`${r.label}->${r.pred}`] = (conf[`${r.label}->${r.pred}`] ?? 0) + 1;

const pr = (kind) => {
  const pred = scored.filter((r) => r.pred === kind);
  const truth = scored.filter((r) => r.label === kind);
  const tp = pred.filter((r) => r.label === kind).length;
  return { tp, pred: pred.length, truth: truth.length, p: pred.length ? (100 * tp) / pred.length : 100, r: truth.length ? (100 * tp) / truth.length : 100 };
};

const b = pr("block");
const n = pr("nudge");
console.log(`corpus: ${scored.length} hand-labelled real commands`);
console.log("confusion (label->prediction):", conf);
console.log(`BLOCK precision ${b.tp}/${b.pred} = ${b.p.toFixed(1)}%   recall ${b.tp}/${b.truth} = ${b.r.toFixed(1)}%`);
console.log(`NUDGE precision ${n.tp}/${n.pred} = ${n.p.toFixed(1)}%   recall ${n.tp}/${n.truth} = ${n.r.toFixed(1)}%`);

const falseBlocks = scored.filter((r) => r.pred === "block" && r.label !== "block");
const nudgeOverreach = scored.filter((r) => r.pred === "nudge" && r.label === "allow");
console.log(`\nfalse BLOCKS (must be 0): ${falseBlocks.length}`);
for (const r of falseBlocks) console.log(`  #${r.id} label=${r.label}  ${r.cmd.replace(/\n/g, " ⏎ ").slice(0, 150)}\n      -> ${r.d.call?.tool} ${JSON.stringify(r.d.call?.args)}`);
console.log(`nudges on ALLOW-labelled commands: ${nudgeOverreach.length}`);
for (const r of nudgeOverreach) console.log(`  #${r.id}  ${r.cmd.replace(/\n/g, " ⏎ ").slice(0, 150)}`);
const threw = scored.filter((r) => r.pred === "THREW");
console.log(`classifier exceptions: ${threw.length}`);

if (verbose) {
  for (const r of scored.filter((x) => x.pred !== x.label)) {
    console.log(`\n#${r.id} label=${r.label} pred=${r.pred}\n  ${r.cmd.replace(/\n/g, " ⏎ ").slice(0, 200)}`);
  }
}

const ok = falseBlocks.length === 0 && threw.length === 0 && nudgeOverreach.length === 0;
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
