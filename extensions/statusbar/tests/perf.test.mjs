// Head-to-head render cost: pi's built-in FooterComponent vs the statusbar footer.
// The built-in footer re-scans every session entry per frame; statusbar renders from a
// cached snapshot, so replacing the footer must not make rendering more expensive.
//   FORCE_COLOR=3 node tests/perf.test.mjs
import { renderStatusBar, emptySnapshot, normalizeConfig } from "../index.ts";
import { PI_DIST, makeSnapshot, reporter, visibleWidth } from "./helpers.mjs";

const { FooterComponent } = await import(`${PI_DIST}/modes/interactive/components/footer.js`);
const { theme, setTheme } = await import(`${PI_DIST}/modes/interactive/theme/theme.js`);
setTheme("dark");

const r = reporter("perf");
const cfg = normalizeConfig(undefined);
const snap = makeSnapshot(emptySnapshot);
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map([["git-guard", "git guard active (120s timeout)"]]),
	getAvailableProviderCount: () => 2,
	onBranchChange: () => () => {},
};

function mockSession(n) {
	const usage = {
		input: 1200,
		output: 300,
		cacheRead: 8000,
		cacheWrite: 400,
		totalTokens: 9900,
		cost: { input: 0.01, output: 0.01, cacheRead: 0.001, cacheWrite: 0.001, total: 0.022 },
	};
	const entries = Array.from({ length: n }, () => ({ type: "message", message: { role: "assistant", usage } }));
	return {
		state: {
			model: { id: "claude-sonnet-4-5-20250929", provider: "anthropic", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "high",
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getCwd: () => "/Users/x/pi-plugins",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 24_800, contextWindow: 200_000, percent: 12.4 }),
		modelRuntime: { isUsingSubscription: () => false },
	};
}

const ITER = 4000;
const bench = (label, fn) => {
	fn();
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < ITER; i++) fn();
	const us = Number(process.hrtime.bigint() - t0) / 1000 / ITER;
	console.log(`    ${label.padEnd(46)} ${us.toFixed(1)} µs/render`);
	return us;
};

const res = {};
for (const n of [10, 500, 5000]) {
	const builtin = new FooterComponent(mockSession(n), footerData);
	res[`builtin-${n}`] = bench(`pi built-in footer, ${n} session entries`, () => builtin.render(100));
}
res.statusbar = bench("statusbar, cached snapshot", () =>
	renderStatusBar({ snap, cfg, theme, width: 100, statuses: footerData.getExtensionStatuses() }),
);
const many = new Map(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `status ${i}`]));
res.many = bench("statusbar, 10k extension statuses", () => renderStatusBar({ snap, cfg, theme, width: 100, statuses: many }));
res.narrow = bench("statusbar, width 20 (full degradation path)", () => renderStatusBar({ snap, cfg, theme, width: 20, statuses: many }));

if (res.statusbar > res["builtin-500"]) r.fail("statusbar render is slower than the built-in footer at 500 entries");
else r.ok(`statusbar (${res.statusbar.toFixed(1)}µs) <= built-in footer at 500 entries (${res["builtin-500"].toFixed(1)}µs)`);
if (res.many > 10 * res.statusbar) r.fail(`10k statuses are not bounded: ${res.many.toFixed(1)}µs`);
else r.ok(`10k statuses stay bounded (${res.many.toFixed(1)}µs, cap: 10x baseline)`);
if (res.narrow > 200) r.fail(`degradation path too slow: ${res.narrow.toFixed(1)}µs`);
else r.ok(`worst case (10k statuses at width 20) is ${res.narrow.toFixed(1)}µs, ~${((res.narrow / 16_000) * 100).toFixed(2)}% of a 16ms frame`);
for (const l of renderStatusBar({ snap, cfg, theme, width: 100, statuses: many })) {
	if (visibleWidth(l) > 100) r.fail("overflow in the 10k-status case");
}

r.done();
