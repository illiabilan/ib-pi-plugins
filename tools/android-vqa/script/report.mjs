import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VqaError } from "./proc.mjs";

/** README.md table of every <name>.result.json in outDir. */
export function buildReport(outDir) {
  const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".result.json")).sort() : [];
  if (files.length === 0) throw new VqaError(`report: no *.result.json in ${outDir}; run scenarios first`);
  const rows = [];
  let pass = 0;
  for (const f of files) {
    const r = JSON.parse(readFileSync(join(outDir, f), "utf8"));
    if (r.passed) pass++;
    const bad = r.assertions.filter((a) => !a.ok);
    const kb = r.gifInfo?.bytes ? `${Math.round(Number(r.gifInfo.bytes) / 1024)} KB` : "-";
    const obs = r.assertions.map((a) => `${a.ok ? "✔" : "✘"} ${a.label.replace(/^[^:]*: /, "")}`).join("<br>");
    rows.push(`| ${r.gif ? `![](${basename(r.gif)})` : "-"} | ${r.title ?? r.name} | ${r.desc ?? ""} | ${r.expect ?? ""} | ${r.passed ? "PASS" : "FAIL"}${bad.length ? ` (${bad.length} failed)` : ""}${r.aborted ? ` aborted: ${r.aborted}` : ""} | ${obs} | ${kb} |`);
  }
  const md = [
    `# Validation GIFs`,
    ``,
    `Generated ${new Date().toISOString()}. ${pass}/${files.length} PASS.`,
    ``,
    `Verdicts come from uiautomator assertions taken during the same recording window, not from watching the GIFs. Per-scenario timelines and dumps: \`<name>.timeline.txt\`, \`ui/\`.`,
    ``,
    `| GIF | Scenario | Setup | Expected | Verdict | Checked by dump | Size |`,
    `|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
  ].join("\n");
  const out = join(outDir, "README.md");
  writeFileSync(out, md);
  return { out, pass, total: files.length };
}
