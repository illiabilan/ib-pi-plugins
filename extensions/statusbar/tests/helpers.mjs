// Shared fixtures for the statusbar tests. Node imports ../index.ts directly
// (native TS type-stripping, Node >= 22.6), the same way the other extensions here test.
import { fileURLToPath } from "node:url";

export const EXT_DIR = fileURLToPath(new URL("..", import.meta.url));
export const EXT_FILE = fileURLToPath(new URL("../index.ts", import.meta.url));
export const NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
export const PI_DIST = `${NODE_MODULES}/@earendil-works/pi-coding-agent/dist`;
export const TUI_DIST = `${NODE_MODULES}/@earendil-works/pi-tui/dist`;

export const tui = await import(`${TUI_DIST}/index.js`);
export const { visibleWidth, stripTerminalSequences } = tui;

/** Mock theme with cheap, distinguishable SGR codes. */
const CODES = { accent: 35, dim: 90, muted: 37, warning: 33, error: 31, success: 32, text: 39 };
export const mockTheme = {
	fg: (c, t) => `\u001b[${CODES[c] ?? 39}m${t}\u001b[39m`,
	bold: (t) => `\u001b[1m${t}\u001b[22m`,
};

export const plainTheme = { fg: (_c, t) => t, bold: (t) => t };

export function makeSnapshot(emptySnapshot, over = {}) {
	return Object.assign(emptySnapshot("/Users/x/pi-plugins"), {
		modelId: "claude-sonnet-4-5-20250929",
		provider: "anthropic",
		showProvider: false,
		thinking: "high",
		projectDir: "pi-plugins",
		branch: "main",
		git: { staged: 1, modified: 2, untracked: 3, conflicted: 0 },
		ctxTokens: 24_800,
		ctxWindow: 200_000,
		ctxPercent: 12.4,
		cost: 0.42,
		...over,
	});
}

export function reporter(label) {
	let failures = 0;
	return {
		fail(msg) {
			failures++;
			console.log(`  ✗ ${msg}`);
		},
		ok(msg) {
			console.log(`  ✓ ${msg}`);
		},
		done() {
			console.log(failures === 0 ? `\n${label}: PASSED` : `\n${label}: ${failures} FAILURE(S)`);
			process.exit(failures === 0 ? 0 : 1);
		},
		get failures() {
			return failures;
		},
	};
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
