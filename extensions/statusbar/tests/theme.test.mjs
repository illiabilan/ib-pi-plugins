// Renders with pi's REAL theme objects (dark + light) and checks the context colour ramp.
//   FORCE_COLOR=3 node tests/theme.test.mjs
import { renderStatusBar, emptySnapshot, normalizeConfig } from "../index.ts";
import { PI_DIST, makeSnapshot, reporter, strip, visibleWidth } from "./helpers.mjs";

const { theme, setTheme } = await import(`${PI_DIST}/modes/interactive/theme/theme.js`);
const r = reporter("theme");
const cfg = normalizeConfig(undefined);
const snap = makeSnapshot(emptySnapshot, { git: { staged: 1, modified: 2, untracked: 3, conflicted: 1 } });
const statuses = new Map([["git-guard", "git guard active (120s timeout)"]]);

const out = {};
for (const name of ["dark", "light"]) {
	setTheme(name);
	const lines = renderStatusBar({ snap, cfg, theme, width: 120, statuses });
	out[name] = lines;
	for (const l of lines) {
		if (visibleWidth(l) > 120) r.fail(`${name}: overflow ${visibleWidth(l)}`);
		if (!l.includes("\u001b")) r.fail(`${name}: no ANSI colour emitted — run with FORCE_COLOR=3`);
	}
	console.log(`    ${name}: ${strip(lines[lines.length - 1])}`);
}
if (out.dark.map(strip).join("|") !== out.light.map(strip).join("|")) r.fail("visible text differs between themes");
else if (out.dark.join("") === out.light.join("")) r.fail("dark and light produced identical escape codes");
else if (visibleWidth(out.dark[1] ?? "") !== visibleWidth(out.light[1] ?? "")) r.fail("width differs between themes");
else r.ok("dark and light render identical text with different, theme-supplied colours");

setTheme("dark");
const codes = [10, 80, 95].map((pct) => {
	const line = renderStatusBar({ snap: { ...snap, ctxPercent: pct }, cfg, theme, width: 200, statuses: new Map() })[0];
	const idx = line.indexOf(`${pct.toFixed(1)}%`);
	return line.slice(0, idx).match(/\u001b\[[0-9;]*m$/)?.[0] ?? "none";
});
if (new Set(codes).size !== 3) r.fail(`context ramp is not 3 distinct theme colours: ${JSON.stringify(codes)}`);
else r.ok(`context ramp uses 3 distinct theme colours (dim/warning/error): ${JSON.stringify(codes)}`);

r.done();
