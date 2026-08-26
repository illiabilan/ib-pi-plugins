// Lifecycle: mount/unmount, no leaked intervals, no double branch subscription, coalesced
// requestRender, out-of-band git refresh, cache invalidation on file edits, detached HEAD,
// git failure, print-mode degradation, and a runtime theme switch on a MOUNTED footer.
//   node tests/lifecycle.test.mjs
import { rmSync, writeFileSync } from "node:fs";
import { PI_DIST, mockTheme, reporter, sleep, strip } from "./helpers.mjs";

// Instrument timers before the extension runs so leaks are observable.
const realSI = globalThis.setInterval;
const realCI = globalThis.clearInterval;
const realST = globalThis.setTimeout;
const realCT = globalThis.clearTimeout;
const liveIntervals = new Set();
globalThis.setInterval = (...a) => {
	const t = realSI(...a);
	liveIntervals.add(t);
	return t;
};
globalThis.clearInterval = (t) => {
	liveIntervals.delete(t);
	return realCI(t);
};

const ext = await import("../index.ts");
const r = reporter("lifecycle");

const handlers = new Map();
const commands = new Map();
const pi = {
	on: (name, fn) => {
		if (!handlers.has(name)) handlers.set(name, []);
		handlers.get(name).push(fn);
	},
	registerCommand: (name, opts) => commands.set(name, opts),
};
const fire = async (name, event, ctx) => {
	for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
};

let renderCount = 0;
const tui = { requestRender: () => renderCount++ };

let subscriptions = 0;
let maxSubscriptions = 0;
const branchCbs = new Set();
const footerData = {
	_branch: "main",
	getGitBranch: () => footerData._branch,
	getExtensionStatuses: () => new Map([["git-guard", "git guard active (120s timeout)"]]),
	getAvailableProviderCount: () => 2,
	onBranchChange: (cb) => {
		subscriptions++;
		maxSubscriptions = Math.max(maxSubscriptions, subscriptions);
		branchCbs.add(cb);
		return () => {
			subscriptions--;
			branchCbs.delete(cb);
		};
	},
};

let footer;
let widget; // { key, component, options } - mirrors pi's aboveEditor widget slot
const notifications = [];
function makeCtx(cwd, theme = mockTheme) {
	return {
		mode: "tui",
		hasUI: true,
		cwd,
		model: { id: "claude-sonnet-4-5-20250929", provider: "anthropic", contextWindow: 200_000, reasoning: true },
		thinkingLevel: "high",
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "assistant", usage: { totalTokens: 24_800, cost: { total: 0.21 } } } },
				{ type: "message", message: { role: "assistant", usage: { totalTokens: 31_000, cost: { total: 0.21 } } } },
			],
			getEntries: () => [],
		},
		getContextUsage: () => ({ tokens: 31_000, contextWindow: 200_000, percent: 15.5 }),
		ui: {
			theme,
			notify: (m) => notifications.push(m),
			select: async () => undefined,
			// mirrors pi's setExtensionFooter: dispose the old component, then build the new one
			setFooter: (factory) => {
				if (footer?.dispose) footer.dispose();
				footer = factory ? factory(tui, theme, footerData) : undefined;
			},
			// mirrors pi's setWidget: a component factory or undefined to clear the slot
			setWidget: (key, content, options) => {
				if (content === undefined) {
					if (widget?.component?.dispose) widget.component.dispose();
					widget = undefined;
					return;
				}
				const component = typeof content === "function" ? content(tui, theme) : { render: () => content };
				widget = { key, component, options };
			},
		},
	};
}

/**
 * The bar is drawn by the widget when placement is "above" (the default) and by the footer
 * when it is "footer"; the other component renders empty on purpose. Tests assert on
 * whichever one is currently drawing.
 */
const active = () => (widget?.component ?? footer);
const activeRender = (w) => active()?.render(w) ?? [];

const REPO = "/tmp/sbar-git/dirty";
ext.default(pi);
const baseIntervals = liveIntervals.size;
const ctx = makeCtx(REPO);

await fire("session_start", { reason: "startup" }, ctx);
if (!active()) r.fail("session_start did not mount the bar");
else r.ok("bar mounted on session_start");
if (subscriptions !== 1) r.fail(`expected 1 branch subscription, got ${subscriptions}`);
else r.ok("exactly 1 branch subscription");

await sleep(1500);
const bar = activeRender(120).join("");
if (!/\*1/.test(bar) || !/\+1/.test(bar) || !/\?2/.test(bar)) r.fail(`git counters missing after refresh: ${strip(bar)}`);
else r.ok(`git counters refreshed out of band: ${strip(bar).split("\n").pop()}`);
if (renderCount === 0) r.fail("no requestRender after the snapshot changed");
else r.ok(`requestRender fired ${renderCount}x after the git snapshot changed`);

// mid-session state change (the agent writes a file)
writeFileSync(`${REPO}/mid-session.txt`, "x\n");
await fire("tool_execution_end", { toolName: "write", toolCallId: "t1" }, ctx);
await sleep(1500);
if (!/\?3/.test(activeRender(120).join(""))) r.fail("a mid-session file write was not picked up");
else r.ok("mid-session file write reflected in the git segment (?2 -> ?3)");
rmSync(`${REPO}/mid-session.txt`, { force: true });

// coalescing
renderCount = 0;
for (let i = 0; i < 200; i++) await fire("model_select", { model: { id: `m-${i}`, provider: "p" }, source: "set" }, ctx);
await sleep(200);
if (renderCount > 5) r.fail(`requestRender not coalesced: ${renderCount} renders for 200 events`);
else r.ok(`requestRender coalesced: ${renderCount} render(s) for 200 model_select events`);

// branch change callback: the provider value is shown immediately (no waiting for git),
// then the next refresh reconciles it with git's own authoritative answer.
footerData._branch = "feature/x";
for (const cb of branchCbs) cb();
const immediate = strip(activeRender(120).join(""));
if (!immediate.includes("feature/x")) r.fail(`branch change not shown immediately: ${immediate}`);
else r.ok("branch change from onBranchChange is shown on the very next frame");
await sleep(600);
const reconciled = strip(activeRender(120).join(""));
if (!reconciled.includes("⑂ main")) r.fail(`git did not reconcile the branch name: ${reconciled}`);
else r.ok("a following refresh reconciles the branch with git's own answer");
footerData._branch = "main";

// rapid toggling
const cmd = commands.get("statusbar");
if (!cmd) r.fail("no /statusbar command registered");
for (let i = 0; i < 20; i++) await cmd.handler("", ctx);
await sleep(100);
if (maxSubscriptions > 1) r.fail(`branch subscriptions peaked at ${maxSubscriptions}`);
else r.ok(`20 rapid toggles: subscriptions never exceeded 1 (peak ${maxSubscriptions})`);
if (liveIntervals.size - baseIntervals > 1) r.fail(`interval leak: ${liveIntervals.size - baseIntervals} live`);
else r.ok(`20 rapid toggles: at most 1 live interval (${liveIntervals.size - baseIntervals})`);

await cmd.handler("off", ctx);
if (active()) r.fail("/statusbar off left the bar mounted");
else if (subscriptions !== 0) r.fail(`subscription leak after off: ${subscriptions}`);
else if (liveIntervals.size - baseIntervals !== 0) r.fail(`interval leak after off: ${liveIntervals.size - baseIntervals}`);
else r.ok("/statusbar off restores the built-in footer and releases subscription + interval");

await cmd.handler("on", ctx);
if (!active()) r.fail("/statusbar on did not remount");
await fire("session_shutdown", {}, ctx);
await sleep(50);
if (liveIntervals.size - baseIntervals !== 0) r.fail("interval leak after session_shutdown");
else r.ok("interval cleared on session_shutdown");
for (const name of ["turn_end", "agent_end", "tool_execution_end", "message_end", "thinking_level_select"]) {
	await fire(name, { level: "low" }, ctx);
}
await sleep(400);
if (liveIntervals.size - baseIntervals !== 0) r.fail("post-shutdown events restarted a timer");
else r.ok("post-shutdown events are inert");

await cmd.handler("git", ctx);
await cmd.handler("git", ctx);
r.ok(`segment toggle notifications: ${JSON.stringify(notifications.slice(-2))}`);

// print mode
let threw = null;
try {
	const printCtx = { ...makeCtx(REPO), mode: "print", hasUI: false };
	await fire("session_start", { reason: "startup" }, printCtx);
	await cmd.handler("", printCtx);
} catch (e) {
	threw = e.message;
}
if (threw) r.fail(`print mode threw: ${threw}`);
else r.ok("print/json mode: nothing mounted, no crash");

// non-repo cwd
await cmd.handler("on", makeCtx(REPO));
footerData._branch = null;
await fire("session_start", { reason: "new" }, makeCtx("/tmp/sbar-git/plain"));
await sleep(1300);
if (/⑂/.test(activeRender(120).join(""))) r.fail("git segment shown in a non-repo");
else r.ok("git segment hidden in a non-repo directory");

// detached HEAD, end to end
footerData._branch = "detached";
await fire("session_start", { reason: "new" }, makeCtx("/tmp/sbar-git/detached"));
await sleep(1500);
const det = strip(activeRender(120).join(""));
if (!/detached@[0-9a-f]{7}/.test(det)) r.fail(`detached HEAD not shown as detached@<oid>: ${det}`);
else r.ok(`detached HEAD rendered as ${/⑂ [^ ]+/.exec(det)?.[0]}`);

// git failing while the provider still reports a branch: keep branch, drop counters
footerData._branch = "main";
await fire("session_start", { reason: "new" }, makeCtx(REPO));
await sleep(1300);
if (!/\*\d/.test(strip(activeRender(120).join("")))) r.fail("precondition: counters missing before the failure case");
await fire("session_start", { reason: "new" }, makeCtx("/tmp/sbar-git/plain"));
await sleep(1300);
const after = strip(activeRender(120).join(""));
if (!/⑂ main/.test(after)) r.fail(`git failure hid the branch: ${after}`);
else if (/\*\d/.test(after)) r.fail(`git failure kept stale counters: ${after}`);
else r.ok("git failure keeps the provider branch and drops the counters");

// runtime theme switch on the mounted component (pi hands the factory a live theme proxy)
const { theme: liveTheme, setTheme } = await import(`${PI_DIST}/modes/interactive/theme/theme.js`);
setTheme("dark");
footerData._branch = "main";
await fire("session_start", { reason: "new" }, makeCtx(REPO, liveTheme));
await sleep(400);
const darkFrame = activeRender(120).join("\u0001");
setTheme("light");
active().invalidate?.();
const lightFrame = activeRender(120).join("\u0001");
if (darkFrame === lightFrame) r.fail("mounted bar did not follow a runtime theme switch");
else if (strip(darkFrame) !== strip(lightFrame)) r.fail("theme switch changed the visible text, not only colours");
else r.ok("mounted footer follows a runtime theme switch (same text, new colours)");
setTheme("dark");

await fire("session_shutdown", {}, ctx);
r.done();
