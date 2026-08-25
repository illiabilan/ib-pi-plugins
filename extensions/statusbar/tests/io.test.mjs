// Proves render() performs NO I/O.
//
// Why it is written this way: imports are bound at module-load time (both under Node's
// native TS loader and under jiti, which is how pi loads extensions), so replacing
// `require("node:fs").readFileSync` afterwards does NOT affect the loaded extension — an
// earlier version of this test did that and was silently vacuous. Instead index.ts is
// copied verbatim with ONLY its import specifiers redirected (the diff is printed and
// asserted to be import lines only), the copy is loaded, and every fs/child_process entry
// point throws and records the call.
//
//   node tests/io.test.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { runGitStatus as realRunGitStatus } from "../index.ts";
import { EXT_FILE, NODE_MODULES, makeSnapshot, plainTheme as theme, reporter, visibleWidth } from "./helpers.mjs";

const r = reporter("io");
const STUB_DIR = "/tmp/sbar-io";
const COPY = `${STUB_DIR}/ext-stubbed.ts`;

// ESM stubs with explicit named exports (native CJS interop cannot see computed keys).
const stub = (mod, keys) =>
	`globalThis.__ioCalls = globalThis.__ioCalls || [];
const boom = (name) => (..._args) => { globalThis.__ioCalls.push(name); throw new Error("I/O attempted: " + name); };
${keys.map((k) => `export const ${k} = boom("${mod}.${k}");`).join("\n")}
export default { ${keys.join(", ")} };
`;

import { mkdirSync } from "node:fs";
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(`${STUB_DIR}/stub-cp.mjs`, stub("child_process", ["execFile", "exec", "spawn", "spawnSync", "execSync", "execFileSync", "fork"]));
writeFileSync(
	`${STUB_DIR}/stub-fs.mjs`,
	stub("fs", ["readFileSync", "writeFileSync", "existsSync", "readdirSync", "statSync", "openSync", "mkdirSync", "readFile", "writeFile", "createReadStream", "appendFileSync", "realpathSync"]),
);

const REWRITES = [
	['"node:child_process"', `"${STUB_DIR}/stub-cp.mjs"`],
	['"node:fs"', `"${STUB_DIR}/stub-fs.mjs"`],
	['"@earendil-works/pi-coding-agent"', `"${NODE_MODULES}/@earendil-works/pi-coding-agent/dist/index.js"`],
	['"@earendil-works/pi-tui"', `"${NODE_MODULES}/@earendil-works/pi-tui/dist/index.js"`],
];
const src = readFileSync(EXT_FILE, "utf8");
let stubbed = src;
for (const [from, to] of REWRITES) stubbed = stubbed.split(from).join(to);
writeFileSync(COPY, stubbed, "utf8");

const changed = src.split("\n").map((l, i) => [l, stubbed.split("\n")[i]]).filter(([a, b]) => a !== b);
const onlyImports = changed.every(([a, b]) => {
	let normalized = a;
	for (const [from, to] of REWRITES) normalized = normalized.split(from).join(to);
	return normalized === b && /^(import |} from )/.test(a.trim());
});
if (!onlyImports || changed.length === 0) r.fail(`stubbed copy differs by more than import specifiers (${changed.length} lines)`);
else r.ok(`stubbed copy differs from index.ts only in ${changed.length} import-specifier line(s)`);

const ext = await import(`file://${COPY}`);
const { renderStatusBar, emptySnapshot, normalizeConfig, runGitStatus } = ext;

// Control A: the copy really is bound to the throwing child_process stub.
globalThis.__ioCalls = [];
const realResult = await realRunGitStatus("/tmp/sbar-git/dirty");
const stubResult = await runGitStatus("/tmp/sbar-git/dirty");
const cpCalls = [...globalThis.__ioCalls];
if (!realResult) r.fail("control broken: the untouched module could not read /tmp/sbar-git/dirty (run tests/git.test.mjs first)");
if (stubResult !== null || !cpCalls.some((c) => c.startsWith("child_process."))) {
	r.fail(`control broken: stubbed copy never hit the child_process stub (calls=${JSON.stringify(cpCalls)})`);
} else r.ok(`stubs live: untouched module read real git data, stubbed copy hit ${cpCalls.join(",")} and returned null`);

// Control B: the fs stub is reachable and the factory degrades instead of crashing.
globalThis.__ioCalls = [];
let factoryOk = false;
try {
	ext.default({ on: () => {}, registerCommand: () => {} });
	factoryOk = true;
} catch (e) {
	factoryOk = `threw: ${e.message}`;
}
const fsCalls = [...globalThis.__ioCalls];
if (!fsCalls.some((c) => c.startsWith("fs."))) r.fail(`control broken: fs stub never called (${JSON.stringify(fsCalls)})`);
else if (factoryOk !== true) r.fail(`factory crashed when fs threw: ${factoryOk}`);
else r.ok(`fs stub live (${fsCalls.join(",")}); extension factory degraded gracefully`);

// The claim.
const cfg = normalizeConfig(undefined);
const snap = makeSnapshot(emptySnapshot, { showProvider: true, git: { staged: 1, modified: 2, untracked: 3, conflicted: 1 } });
const many = new Map(Array.from({ length: 500 }, (_, i) => [`k${i}`, `status ${i} blocked=${i}`]));
globalThis.__ioCalls = [];
let renders = 0;
let err = null;
try {
	for (let i = 0; i < 300; i++) {
		for (const width of [10, 20, 40, 80, 120, 200, 300, 1000]) {
			for (const statuses of [new Map(), new Map([["a", "one status"]]), many]) {
				for (const l of renderStatusBar({ snap, cfg, theme, width, statuses })) {
					if (visibleWidth(l) > width) throw new Error(`overflow at width ${width}`);
				}
				renders++;
			}
		}
	}
} catch (e) {
	err = e;
}
if (err) r.fail(`render failed: ${err.message}`);
else if (globalThis.__ioCalls.length) r.fail(`render performed I/O: ${JSON.stringify([...new Set(globalThis.__ioCalls)])}`);
else r.ok(`${renders} renders with fs + child_process replaced by throwing stubs: zero I/O calls`);

r.done();
