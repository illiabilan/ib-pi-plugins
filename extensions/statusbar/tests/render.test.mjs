// render(): width matrix, segment drop order, ANSI/control-char safety, adversarial values.
//   node tests/render.test.mjs [--show]
import { renderStatusBar, emptySnapshot, normalizeConfig, DROP_ORDER } from "../index.ts";
import { makeSnapshot, mockTheme as theme, reporter, strip, stripTerminalSequences, visibleWidth } from "./helpers.mjs";

const SHOW = process.argv.includes("--show");
const r = reporter("render");
const cfg = normalizeConfig(undefined);
const base = (over) => makeSnapshot(emptySnapshot, over);

const MARKERS = [
	["pi", "π"],
	["model", "⊙"],
	["think", "think:"],
	["project", "⌂"],
	["git", "⑂"],
	["context", "◔"],
	["extra", "$"],
];
const segsOf = (bar) => {
	const s = new Set();
	for (const [key, glyph] of MARKERS) if (bar.includes(glyph)) s.add(key);
	if (bar.includes("⚑")) s.add("extra");
	return s;
};

const cases = [
	{ name: "typical", snap: base(), statuses: new Map([["git-guard", "git guard active (120s timeout)"]]) },
	{ name: "no-git", snap: base({ branch: null, git: null }), statuses: new Map() },
	{ name: "no-counters-yet", snap: base({ git: null }), statuses: new Map() },
	{ name: "detached", snap: base({ branch: "detached", detached: true, headOid: "a1b2c3d" }), statuses: new Map() },
	{
		name: "emoji+cjk",
		snap: base({
			branch: "feature/🚀-rocket-Ünïcodé-e\u0301clair",
			projectDir: "项目目录名称テストカタカナ",
			modelId: "モデル-とても-長い-名前-テスト-1234567890",
		}),
		statuses: new Map([["a", "状態テキスト 🚀 ok"]]),
	},
	{ name: "branch-200", snap: base({ branch: "b".repeat(200) }), statuses: new Map() },
	{ name: "dir-200", snap: base({ projectDir: "d".repeat(200) }), statuses: new Map() },
	{ name: "no-model", snap: base({ modelId: null, thinking: null }), statuses: new Map() },
	{ name: "model-500", snap: base({ modelId: "m".repeat(500) }), statuses: new Map() },
	{ name: "ctx-unknown-window", snap: base({ ctxWindow: 0, ctxPercent: null, ctxTokens: 12_345 }), statuses: new Map() },
	{ name: "ctx-unknown-both", snap: base({ ctxWindow: 0, ctxPercent: null, ctxTokens: null }), statuses: new Map() },
	{ name: "ctx-null-tokens", snap: base({ ctxTokens: null, ctxPercent: null }), statuses: new Map() },
	{ name: "ctx-full", snap: base({ ctxPercent: 97.3 }), statuses: new Map() },
	{ name: "huge-counters", snap: base({ git: { staged: 99999, modified: 88888, untracked: 77777, conflicted: 6 } }), statuses: new Map() },
	{
		name: "ansi-injection",
		snap: base({ branch: "ma\u001b[31min\nx\ty", projectDir: "dir\u001b[1;5;7mBLINK", modelId: "m\u0000o\u009fd" }),
		statuses: new Map([["evil", "st\u001b[41matus\nsecond line"]]),
	},
	{
		name: "statuses-10k",
		snap: base(),
		statuses: new Map(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `status ${i} blocked=${i} nudged=${i}`])),
	},
	{ name: "statuses-array", snap: base(), statuses: [["a", "from an array iterable"]] },
	{ name: "statuses-empty-text", snap: base(), statuses: new Map([["a", "   "], ["b", ""]]) },
	{ name: "showProvider", snap: base({ showProvider: true }), statuses: new Map() },
	{ name: "guard-status", snap: base(), statuses: new Map([["bash-guardrail", "guardrail blocked=3 nudged=7"]]) },
	{ name: "zero-cost", snap: base({ cost: 0 }), statuses: new Map() },
	{ name: "tiny-cost", snap: base({ cost: 0.0004 }), statuses: new Map() },
];

const WIDTHS = [0, 1, 2, 3, 5, 8, 10, 15, 20, 30, 40, 60, 80, 100, 120, 200, 400];

for (const c of cases) {
	const presence = [];
	for (const width of WIDTHS) {
		const lines = renderStatusBar({ snap: c.snap, cfg, theme, width, statuses: c.statuses });
		if (!Array.isArray(lines)) r.fail(`${c.name}@${width}: not an array`);
		if (lines.length > 2) r.fail(`${c.name}@${width}: ${lines.length} lines (max 2)`);
		if (width <= 0 && lines.length !== 0) r.fail(`${c.name}@${width}: expected 0 lines`);
		for (const line of lines) {
			const w = visibleWidth(line);
			if (w > width) r.fail(`${c.name}@${width}: visibleWidth=${w} :: ${JSON.stringify(line)}`);
			const bare = stripTerminalSequences(line);
			if (/[\u0000-\u001f\u007f]/.test(bare)) r.fail(`${c.name}@${width}: control char leaked :: ${JSON.stringify(bare)}`);
			if (line.includes("\u001b") && !/\u001b\[(0|39|22|49)m$/.test(line)) {
				r.fail(`${c.name}@${width}: unterminated ANSI :: ${JSON.stringify(line.slice(-12))}`);
			}
		}
		if (width > 0) presence.push([width, segsOf(stripTerminalSequences(lines[lines.length - 1] ?? ""))]);
	}

	// Segment presence must shrink monotonically and follow DROP_ORDER.
	const widest = presence[presence.length - 1][1];
	let prev = null;
	for (let i = presence.length - 1; i >= 0; i--) {
		const [width, set] = presence[i];
		for (const s of set) if (!widest.has(s)) r.fail(`${c.name}@${width}: segment ${s} only appears when narrow`);
		if (prev) {
			for (const s of set) if (!prev.has(s)) r.fail(`${c.name}@${width}: segment ${s} reappeared after being dropped`);
			const order = DROP_ORDER.filter((k) => prev.has(k));
			for (const d of [...prev].filter((s) => !set.has(s))) {
				const kept = order.slice(0, order.indexOf(d)).filter((k) => set.has(k));
				if (kept.length) r.fail(`${c.name}@${width}: dropped ${d} but kept lower-priority ${kept.join(",")}`);
			}
		}
		prev = set;
	}
}
r.ok(`${cases.length} cases x ${WIDTHS.length} widths: width bounded, no ANSI/control leakage, drop order respected`);

// Individual segment toggles.
for (const key of ["pi", "model", "think", "project", "git", "context", "extra", "statuses"]) {
	const cfg2 = normalizeConfig({ enabled: true, segments: { [key]: false } });
	const lines = renderStatusBar({ snap: base(), cfg: cfg2, theme, width: 200, statuses: new Map([["s", "a status"]]) });
	const bar = stripTerminalSequences(lines[lines.length - 1] ?? "");
	if (key === "statuses") {
		if (lines.length !== 1) r.fail(`statuses off still produced ${lines.length} lines`);
	} else if (segsOf(bar).has(key)) {
		r.fail(`segment ${key} disabled but still rendered: ${bar}`);
	}
	if (SHOW) console.log(`    ${key.padEnd(9)} off → ${lines.map(strip).join(" ⏎ ")}`);
}
r.ok("each segment can be disabled individually");

const allOff = normalizeConfig({
	enabled: true,
	segments: { pi: false, model: false, think: false, project: false, git: false, context: false, extra: false, statuses: false },
});
if (renderStatusBar({ snap: base(), cfg: allOff, theme, width: 80, statuses: new Map() }).length !== 0) {
	r.fail("all segments off should render nothing");
} else r.ok("all segments off renders nothing at all");

// Absurd widths must not throw or overflow.
for (const width of [10.7, 1e6, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
	const lines = renderStatusBar({ snap: base(), cfg, theme, width, statuses: new Map() });
	for (const l of lines) if (visibleWidth(l) > Math.floor(width)) r.fail(`width=${width}: overflow ${visibleWidth(l)}`);
}
r.ok("fractional / negative / NaN / Infinity widths handled");

if (SHOW) {
	console.log("\n  samples:");
	for (const c of cases) {
		for (const width of [120, 60, 40, 20, 10]) {
			const lines = renderStatusBar({ snap: c.snap, cfg, theme, width, statuses: c.statuses });
			console.log(`    ${c.name.padEnd(19)} ${String(width).padStart(3)} → ${lines.map((l) => `${strip(l)}|w=${visibleWidth(l)}`).join("  ⏎  ")}`);
		}
	}
}

r.done();
