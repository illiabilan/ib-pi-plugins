/**
 * Guardrail / behaviour test-suite for the file_ops tool.
 *
 * Runs the real tool.execute() through jiti (no LLM involved) against throwaway
 * sandboxes under /tmp/fileops-tests-*, asserting on refusals, approval flow,
 * symlink handling, dryRun side-effect freedom and state-bound tokens.
 *
 *   node guardrail-tests.mjs
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
	symlinkSync,
	existsSync,
	readdirSync,
	lstatSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(new URL("./index.ts", import.meta.url).pathname, { default: true });

let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

/**
 * Non-interactive path. `userTurns` models how many user messages the session has
 * seen: the tool refuses a confirm redeemed in the same user turn that produced the
 * preview, so a realistic caller must bump this between preview and confirm.
 */
const mockSession = (userTurns) => ({
	getEntries: () =>
		Array.from({ length: userTurns }, () => ({ type: "message", message: { role: "user" } })),
});

// Default: previews happen in user turn 1, confirms in turn 2 (a real user replied).
// Tests that want to prove same-turn self-approval is refused pass userTurns explicitly.
const call = async (params, cwd, userTurns = params?.confirm ? 2 : 1) => {
	const res = await tool.execute("t", params, undefined, undefined, {
		cwd,
		hasUI: false,
		mode: "json",
		sessionManager: mockSession(userTurns),
	});
	return { text: res.content[0].text, details: res.details };
};

/** Preview in turn N, then confirm in turn N+1 — the only legitimate sequence. */
const approveNextTurn = async (params, cwd, turn = 1) => {
	const preview = await call(params, cwd, turn);
	if (!preview.details?.token) return preview;
	return call({ ...params, confirm: preview.details.token }, cwd, turn + 1);
};

/** Interactive (TUI/RPC) path: ctx.hasUI true, ctx.ui.confirm answers `answer`. */
const callUI = async (params, cwd, answer) => {
	const prompts = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			confirm: async (title, body) => {
				prompts.push({ title, body });
				return answer;
			},
		},
	};
	const res = await tool.execute("t", params, undefined, undefined, ctx);
	return { text: res.content[0].text, details: res.details, prompts };
};

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		failures.push(name);
		console.log(`  FAIL ${name} ${extra}`);
	}
}

/** Deterministic snapshot of a tree: paths + type + sha256 of file contents. */
function snapshot(root) {
	const out = [];
	const walk = (dir) => {
		for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = join(dir, d.name);
			if (d.isSymbolicLink()) {
				out.push(`L ${p}`);
			} else if (d.isDirectory()) {
				out.push(`D ${p}`);
				walk(p);
			} else {
				const sum = execFileSync("shasum", ["-a", "256", p]).toString().split(" ")[0];
				const st = lstatSync(p);
				out.push(`F ${p} ${st.size} ${sum} mtime=${st.mtimeMs} mode=${(st.mode & 0o7777).toString(8)}`);
			}
		}
	};
	walk(root);
	return out.join("\n");
}

const SB = mkdtempSync(join(tmpdir(), "fileops-tests-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "fileops-outside-"));
writeFileSync(join(OUTSIDE, "precious.txt"), "must survive\n");
console.log(`sandbox: ${SB}\noutside : ${OUTSIDE}\n`);

/** Build a deep tree with unicode/space names, nested dirs and a symlink escaping the sandbox. */
function makeTree(root) {
	mkdirSync(join(root, "deep/a/b/c/d"), { recursive: true });
	mkdirSync(join(root, "deep/dir with space"), { recursive: true });
	for (const f of ["one.log", "two.log", "keep.txt"]) writeFileSync(join(root, "deep", f), "x".repeat(100));
	writeFileSync(join(root, "deep/a/b/c/d/файл ünïcode.txt"), "unicode payload\n");
	writeFileSync(join(root, "deep/dir with space/hello world.txt"), "spaces\n");
	for (let i = 0; i < 30; i++) writeFileSync(join(root, `deep/a/b/bulk${i}.bin`), "y".repeat(1000));
	symlinkSync(OUTSIDE, join(root, "deep/escape-link"));
	symlinkSync(join(OUTSIDE, "precious.txt"), join(root, "deep/file-link"));
}
makeTree(SB);

// ---------------------------------------------------------------- 1. refusals
console.log("== hard refusals (must never touch the filesystem) ==");
const refusals = [
	["empty string path", { action: "remove", paths: "", recursive: true }, "EMPTY_PATH"],
	["missing paths arg", { action: "remove", recursive: true }, "EMPTY_PATH"],
	["whitespace path", { action: "remove", paths: "   ", recursive: true }, "EMPTY_PATH"],
	["unexpanded $VAR (rm -rf $VAR/ bug)", { action: "remove", paths: "$TMP/build", recursive: true }, "UNEXPANDED_VAR"],
	["braced ${VAR}", { action: "remove", paths: "${HOME}/x", recursive: true }, "UNEXPANDED_VAR"],
	["filesystem root", { action: "remove", paths: "/", recursive: true }, "ROOT"],
	["$HOME itself", { action: "remove", paths: homedir(), recursive: true }, "PROTECTED"],
	["~/.pi", { action: "remove", paths: "~/.pi", recursive: true }, "PROTECTED"],
	["~/.pi/agent wholesale", { action: "remove", paths: "~/.pi/agent", recursive: true }, "PROTECTED"],
	["inside ~/.pi (real trace case)", { action: "remove", paths: "~/.pi/agent/extensions/code-search", recursive: true }, "PROTECTED"],
	["~/.ssh key", { action: "remove", paths: "~/.ssh/id_rsa" }, "PROTECTED"],
	["write into ~/.ssh", { action: "copy", from: join(SB, "deep/keep.txt"), to: "~/.ssh/authorized_keys" }, "PROTECTED"],
	["/usr/lib", { action: "remove", paths: "/usr/lib", recursive: true }, "PROTECTED"],
	["chmod -R inside ~/Library", { action: "chmod", paths: "~/Library/Preferences", mode: "777", recursive: true }, "PROTECTED"],
	["mv ~/Library away", { action: "move", from: "~/Library", to: join(SB, "lib") }, "PROTECTED"],
	["dir without recursive", { action: "remove", paths: join(SB, "deep") }, "NEEDS_RECURSIVE"],
	["missing path without force", { action: "remove", paths: join(SB, "nope.txt") }, "NO_SOURCE"],
	["copy dir without recursive", { action: "copy", from: join(SB, "deep"), to: join(SB, "copy1") }, "NEEDS_RECURSIVE"],
	["bad chmod mode", { action: "chmod", paths: join(SB, "deep/keep.txt"), mode: "u+rwXs" }, "BAD_MODE"],
	["paths passed to copy", { action: "copy", paths: [join(SB, "deep")], recursive: true }, "BAD_ARGS"],
];
const before = snapshot(SB);
for (const [name, params, code] of refusals) {
	const r = await call(params, SB);
	check(
		`refused: ${name} (${code})`,
		r.details.status === "refused" && r.details.code === code && r.text.startsWith("REFUSED"),
		`-> ${r.details.status}/${r.details.code}: ${r.text.slice(0, 120)}`,
	);
}
check("refusals changed nothing on disk (exact snapshot match)", snapshot(SB) === before, "snapshot diverged");

// .git protection needs a .git dir (created by the test itself, so re-baseline after it)
mkdirSync(join(SB, "repo/.git/objects"), { recursive: true });
writeFileSync(join(SB, "repo/.git/HEAD"), "ref: refs/heads/main\n");
{
	const r = await call({ action: "remove", paths: join(SB, "repo/.git"), recursive: true }, SB);
	check(`refused: .git directory (GIT_DIR)`, r.details.code === "GIT_DIR", JSON.stringify(r.details));
	const r2 = await call({ action: "remove", paths: join(SB, "repo/.git/objects"), recursive: true }, SB);
	check(`refused: inside .git`, r2.details.code === "GIT_DIR", JSON.stringify(r2.details));
}
// ancestor of cwd
{
	const sub = join(SB, "deep/a/b");
	const r = await call({ action: "remove", paths: SB, recursive: true }, sub);
	check("refused: ancestor of cwd (ANCESTOR_OF_CWD)", r.details.code === "ANCESTOR_OF_CWD", JSON.stringify(r.details));
}
const before2 = snapshot(SB);

// -------------------------------------------- 1b. protected-but-not-destructive
console.log("\n== non-destructive writes into protected locations: loud, not refused ==");
for (const [name, params] of [
	["mkdir inside ~/.pi", { action: "mkdir", paths: "~/.pi/agent/extensions/fileops-probe-do-not-create" }],
	["cp -r repo into ~/.pi/agent/extensions (real trace case)", { action: "copy", from: join(SB, "deep"), to: "~/.pi/agent/extensions/fileops-probe", recursive: true }],
]) {
	const r = await call(params, SB);
	check(`${name}: needs approval, HIGH risk, not refused`, r.details.status === "needs-approval" && r.details.risk === "high", JSON.stringify(r.details).slice(0, 200));
	check(`${name}: reason names the protected location`, (r.details.reasons ?? []).some((x) => x.includes(".pi")), JSON.stringify(r.details.reasons));
	check(`${name}: nothing created`, !existsSync(join(homedir(), ".pi/agent/extensions/fileops-probe")) && !existsSync(join(homedir(), ".pi/agent/extensions/fileops-probe-do-not-create")));
}
{
	const r = await call({ action: "remove", paths: "/tmp", recursive: true }, SB);
	check("refused: OS temp root itself", r.details.code === "PROTECTED", JSON.stringify(r.details));
	const r2 = await call({ action: "remove", paths: join(SB, "deep/../../"), recursive: true }, SB);
	check("path traversal out of cwd is caught (../..)", r2.details.status === "refused", JSON.stringify(r2.details));
}
check("protected-location previews changed nothing on disk (exact snapshot match)", snapshot(SB) === before2, "snapshot diverged");

// ------------------------------------------------- 2. approval flow (no UI)
console.log("\n== approval flow ==");
{
	const p = { action: "mkdir", paths: [join(SB, "build/tmp"), join(SB, "build/out")] };
	const r1 = await call(p, SB);
	check("mkdir first call needs approval", r1.details.status === "needs-approval" && !!r1.details.token, r1.text.slice(0, 100));
	check("mkdir first call created nothing", !existsSync(join(SB, "build")));
	const r2 = await call({ ...p, confirm: "fileops-deadbeef1234" }, SB);
	check("bogus token rejected", r2.details.status === "needs-approval" && r2.text.includes("never issued"), r2.text.slice(0, 200));
	check("bogus token created nothing", !existsSync(join(SB, "build")));
	const r3 = await call({ ...p, confirm: r1.details.token }, SB);
	check("valid token executes", r3.details.status === "done" && existsSync(join(SB, "build/tmp")) && existsSync(join(SB, "build/out")), r3.text);
	const r4 = await call({ ...p, confirm: r1.details.token }, SB);
	check("token is single-use / state-bound", r4.details.status === "needs-approval", r4.text.slice(0, 200));
}

// ------------------------------------------------- 3. recursive remove preview
console.log("\n== recursive remove of a deep tree ==");
let removeToken;
{
	const r = await call({ action: "remove", paths: join(SB, "deep"), recursive: true }, SB);
	removeToken = r.details.token;
	check("recursive remove is HIGH risk", r.details.risk === "high", JSON.stringify(r.details.reasons));
	check("reason mentions RECURSIVE DELETE", (r.details.reasons ?? []).some((x) => x.includes("RECURSIVE DELETE")));
	check("preview counts entries (>35)", r.details.totals.entries > 35, JSON.stringify(r.details.totals));
	check("preview reports bytes", r.details.totals.bytes > 30000, JSON.stringify(r.details.totals));
	check("preview mentions symlinks not followed", r.text.includes("symlink(s) inside the tree will be unlinked, never followed"), r.text);
	check("nothing removed yet", existsSync(join(SB, "deep/keep.txt")));
}

// -------------------------------- 4. state-bound token (mid-session change)
console.log("\n== token invalidated by a mid-session filesystem change ==");
{
	writeFileSync(join(SB, "deep/sneaky-new-file.txt"), "appeared after the preview\n");
	const r = await call({ action: "remove", paths: join(SB, "deep"), recursive: true, confirm: removeToken }, SB);
	check("stale token rejected after tree changed", r.details.status === "needs-approval", r.text.slice(0, 200));
	check("rejection says the filesystem CHANGED", r.text.includes("filesystem has CHANGED"), r.text.slice(0, 400));
	check("tree still intact", existsSync(join(SB, "deep/keep.txt")));
}

// -------------------------------------------- 5. dryRun is side-effect free
console.log("\n== dryRun side-effect freedom ==");
{
	const snapA = snapshot(SB);
	const cases = [
		{ action: "remove", paths: join(SB, "deep"), recursive: true, dryRun: true },
		{ action: "remove", paths: join(SB, "deep/*.log"), dryRun: true },
		{ action: "mkdir", paths: join(SB, "dry/new/dir"), dryRun: true },
		{ action: "copy", from: join(SB, "deep"), to: join(SB, "dry-copy"), recursive: true, dryRun: true },
		{ action: "move", from: join(SB, "deep/keep.txt"), to: join(SB, "moved.txt"), dryRun: true },
		{ action: "touch", paths: join(SB, "deep/keep.txt"), dryRun: true },
		{ action: "chmod", paths: join(SB, "deep"), mode: "777", recursive: true, dryRun: true },
		{ action: "symlink", from: OUTSIDE, to: join(SB, "dry-link"), dryRun: true },
	];
	for (const c of cases) {
		const r = await call(c, SB);
		check(`dryRun ${c.action} reports plan`, r.details.status === "dry-run" && r.text.includes("NOTHING was changed"), r.text.slice(0, 120));
	}
	const snapB = snapshot(SB);
	check("dryRun changed no file/dir/checksum/mtime-size", snapA === snapB, "snapshot diverged");
}

// ------------------------------------------------------------- 6. glob delete
console.log("\n== glob delete ==");
{
	const r = await call({ action: "remove", paths: join(SB, "deep/*.log") }, SB);
	check("glob delete is HIGH risk", r.details.risk === "high", JSON.stringify(r.details.reasons));
	check("glob reason present", (r.details.reasons ?? []).some((x) => x.includes("glob-expanded delete")));
	check("glob expansion listed in preview", r.text.includes("one.log") && r.text.includes("two.log"), r.text);
	const r2 = await call({ action: "remove", paths: join(SB, "deep/*.log"), confirm: r.details.token }, SB);
	check("glob delete executes", r2.details.status === "done" && !existsSync(join(SB, "deep/one.log")) && existsSync(join(SB, "deep/keep.txt")), r2.text);
	const r3 = await call({ action: "remove", paths: join(SB, "deep/*.log") }, SB);
	check("glob matching nothing is a noop, not an error", r3.details.status === "noop", r3.text.slice(0, 200));
}

// --------------------------------------------------- 7. copy / overwrite / move
console.log("\n== copy, overwrite, move ==");
{
	const dst = join(SB, "copyland");
	mkdirSync(dst, { recursive: true });
	writeFileSync(join(dst, "keep.txt"), "PRE-EXISTING\n");
	// copy file into an existing dir, overwrite never -> skip
	const c1 = await call({ action: "copy", from: join(SB, "deep/keep.txt"), to: dst }, SB);
	check("copy resolves into existing dir", c1.text.includes(join(dst, "keep.txt")), c1.text);
	const c1b = await call({ action: "copy", from: join(SB, "deep/keep.txt"), to: dst, confirm: c1.details.token }, SB);
	check("overwrite=never skips existing", c1b.details.skipped === 1 && execFileSync("cat", [join(dst, "keep.txt")]).toString() === "PRE-EXISTING\n", c1b.text);
	// overwrite always -> replaces + HIGH risk
	const c2 = await call({ action: "copy", from: join(SB, "deep/keep.txt"), to: dst, overwrite: "always" }, SB);
	check("overwrite=always is HIGH risk", c2.details.risk === "high", JSON.stringify(c2.details.reasons));
	const c2b = await call({ action: "copy", from: join(SB, "deep/keep.txt"), to: dst, overwrite: "always", confirm: c2.details.token }, SB);
	check("overwrite=always replaces", c2b.details.status === "done" && execFileSync("cat", [join(dst, "keep.txt")]).toString() !== "PRE-EXISTING\n", c2b.text);
	// overwrite=ask without UI -> refused
	const c3 = await call({ action: "copy", from: join(SB, "deep/keep.txt"), to: dst, overwrite: "ask" }, SB);
	check("overwrite=ask refused without a UI", c3.details.code === "AMBIGUOUS_OVERWRITE", JSON.stringify(c3.details));
	// recursive dir copy preserves symlinks (does not dereference)
	const c4 = await call({ action: "copy", from: join(SB, "deep"), to: join(SB, "treecopy"), recursive: true }, SB);
	const c4b = await call({ action: "copy", from: join(SB, "deep"), to: join(SB, "treecopy"), recursive: true, confirm: c4.details.token }, SB);
	check("recursive copy done", c4b.details.status === "done", c4b.text);
	check("copied symlink stays a symlink (not dereferenced)", lstatSync(join(SB, "treecopy/escape-link")).isSymbolicLink());
	check("unicode/space names copied", existsSync(join(SB, "treecopy/a/b/c/d/файл ünïcode.txt")) && existsSync(join(SB, "treecopy/dir with space/hello world.txt")));
	// move across directories, unicode name
	const src = join(SB, "treecopy/a/b/c/d/файл ünïcode.txt");
	const m1 = await call({ action: "move", from: src, to: join(SB, "copyland/moved ünïcode.txt") }, SB);
	const m1b = await call({ action: "move", from: src, to: join(SB, "copyland/moved ünïcode.txt"), confirm: m1.details.token }, SB);
	check("move across dirs with unicode+space name", m1b.details.status === "done" && !existsSync(src) && existsSync(join(SB, "copyland/moved ünïcode.txt")), m1b.text);
}

// -------------------------------------- 8. symlinks are never followed on rm
console.log("\n== symlink safety ==");
{
	const linkDir = join(SB, "linkzone");
	mkdirSync(linkDir, { recursive: true });
	symlinkSync(OUTSIDE, join(linkDir, "outside-dir-link"));
	symlinkSync(join(OUTSIDE, "precious.txt"), join(linkDir, "outside-file-link"));
	const s1 = await call({ action: "remove", paths: linkDir, recursive: true }, SB);
	check("preview flags symlinks", s1.text.includes("symlink"), s1.text);
	const s1b = await call({ action: "remove", paths: linkDir, recursive: true, confirm: s1.details.token }, SB);
	check("recursive remove executed", s1b.details.status === "done" && !existsSync(linkDir), s1b.text);
	check("symlink target OUTSIDE the sandbox survived", existsSync(join(OUTSIDE, "precious.txt")));
	check("report says symlinks unlinked-not-followed", s1b.text.includes("unlinked-not-followed"), s1b.text);
	// removing a symlink itself does not touch the target
	const l2 = join(SB, "single-link");
	symlinkSync(join(OUTSIDE, "precious.txt"), l2);
	const s2 = await call({ action: "remove", paths: l2 }, SB);
	const s2b = await call({ action: "remove", paths: l2, confirm: s2.details.token }, SB);
	check("removing a symlink keeps its target", s2b.details.status === "done" && !existsSync(l2) && existsSync(join(OUTSIDE, "precious.txt")), s2b.text);
	// a symlink-to-directory targeted with recursive:true must be unlinked, NOT descended
	const l3 = join(SB, "dirlink");
	symlinkSync(OUTSIDE, l3);
	const s4 = await call({ action: "remove", paths: l3, recursive: true }, SB);
	const s4b = await call({ action: "remove", paths: l3, recursive: true, confirm: s4.details.token }, SB);
	check("rm -r on a symlinked dir unlinks the link only", s4b.text.includes("symlink unlinked, target untouched") && existsSync(join(OUTSIDE, "precious.txt")) && !existsSync(l3), s4b.text);
	// symlink cycle: link back to an ancestor must not cause an infinite walk
	const cyc = join(SB, "cyclezone");
	mkdirSync(join(cyc, "inner"), { recursive: true });
	writeFileSync(join(cyc, "inner/f.txt"), "c\n");
	symlinkSync(SB, join(cyc, "inner/up"));
	symlinkSync(cyc, join(cyc, "inner/self"));
	const cy = await call({ action: "remove", paths: cyc, recursive: true }, SB);
	check("symlink cycle previewed without hanging", cy.details.status === "needs-approval" && cy.details.totals.entries < 20, JSON.stringify(cy.details.totals));
	const cy2 = await call({ action: "remove", paths: cyc, recursive: true, confirm: cy.details.token }, SB);
	check("symlink cycle removed, sandbox+outside intact", cy2.details.status === "done" && !existsSync(cyc) && existsSync(SB) && existsSync(join(OUTSIDE, "precious.txt")), cy2.text);
	// creating a symlink that escapes cwd is HIGH risk
	const s3 = await call({ action: "symlink", from: OUTSIDE, to: join(SB, "new-escape") }, SB);
	check("symlink escaping cwd is HIGH risk", s3.details.risk === "high" && (s3.details.reasons ?? []).some((x) => x.includes("escapes the session cwd")), JSON.stringify(s3.details.reasons));
	const s3b = await call({ action: "symlink", from: OUTSIDE, to: join(SB, "new-escape"), confirm: s3.details.token }, SB);
	check("symlink created", s3b.details.status === "done" && lstatSync(join(SB, "new-escape")).isSymbolicLink(), s3b.text);
	const s3c = await call({ action: "symlink", from: OUTSIDE, to: join(SB, "new-escape") }, SB);
	const s3d = await call({ action: "symlink", from: OUTSIDE, to: join(SB, "new-escape"), confirm: s3c.details.token }, SB);
	check("existing link not replaced without force", s3d.details.skipped === 1, s3d.text);
}

// ------------------------------------------------------------- 9. chmod, touch
console.log("\n== chmod / touch ==");
{
	const sh = join(SB, "copyland/run.sh");
	writeFileSync(sh, "#!/bin/sh\necho hi\n");
	const r = await call({ action: "chmod", paths: sh, mode: "+x" }, SB);
	const r2 = await call({ action: "chmod", paths: sh, mode: "+x", confirm: r.details.token }, SB);
	check("chmod +x applied", r2.details.status === "done" && (lstatSync(sh).mode & 0o111) === 0o111, r2.text);
	const t = await call({ action: "touch", paths: [join(SB, "copyland/new file.txt")] }, SB);
	const t2 = await call({ action: "touch", paths: [join(SB, "copyland/new file.txt")], confirm: t.details.token }, SB);
	check("touch creates file", t2.details.status === "done" && existsSync(join(SB, "copyland/new file.txt")), t2.text);
	const f = await call({ action: "remove", paths: [join(SB, "gone.txt")], force: true }, SB);
	const f2 = await call({ action: "remove", paths: [join(SB, "gone.txt")], force: true, confirm: f.details.token }, SB);
	check("remove force on missing path skips cleanly", f2.details.status === "done" && f2.details.skipped === 1, f2.text);
}

// ------------------------------------- 9b. interactive (ctx.ui.confirm) path
console.log("\n== interactive UI approval path ==");
{
	const dir = join(SB, "uizone");
	mkdirSync(join(dir, "sub"), { recursive: true });
	for (let i = 0; i < 30; i++) writeFileSync(join(dir, `sub/f${i}.txt`), "u".repeat(10));
	const d = await callUI({ action: "remove", paths: dir, recursive: true }, SB, false);
	check("UI: confirm dialog was shown", d.prompts.length === 1, JSON.stringify(d.prompts.map((p) => p.title)));
	check("UI: dialog title is loud for high risk", d.prompts[0]?.title.startsWith("!! HIGH RISK"), d.prompts[0]?.title);
	check("UI: dialog body contains the full plan", (d.prompts[0]?.body ?? "").includes("RECURSIVE DELETE"), d.prompts[0]?.body);
	check("UI: declining changes nothing", d.details.status === "declined" && existsSync(join(dir, "sub/f0.txt")), d.text.slice(0, 150));
	const a = await callUI({ action: "remove", paths: dir, recursive: true }, SB, true);
	check("UI: approving executes without any token", a.details.status === "done" && !existsSync(dir), a.text);
	const refused = await callUI({ action: "remove", paths: "~/.pi/agent", recursive: true }, SB, true);
	check("UI: hard refusals are not overridable by confirming", refused.details.status === "refused" && refused.prompts.length === 0, JSON.stringify(refused.details));
	const dry = await callUI({ action: "remove", paths: join(SB, "copyland"), recursive: true, dryRun: true }, SB, true);
	check("UI: dryRun asks nothing and changes nothing", dry.details.status === "dry-run" && dry.prompts.length === 0 && existsSync(join(SB, "copyland")), JSON.stringify(dry.details));
}

// ---------------------------------- 10. NON-TEMP location (regression guard)
// The /tmp sandboxes above are exempt from PROTECTED_PREFIXES, which once hid a bug
// where "/" was in that list and refused every destructive op anywhere. These cases
// run inside the extension's own directory (a normal, non-temp path under $HOME).
console.log("\n== normal non-temp project path (regression: everything was once refused) ==");
{
	const NT = new URL("./.scratch-nontemp", import.meta.url).pathname;
	rmSync(NT, { recursive: true, force: true });
	mkdirSync(join(NT, "build/static"), { recursive: true });
	for (let i = 0; i < 5; i++) writeFileSync(join(NT, `build/static/f${i}.js`), "z".repeat(50));
	writeFileSync(join(NT, "notes.md"), "# notes\n");
	const mk = await call({ action: "mkdir", paths: join(NT, "dist/assets") }, NT);
	const mk2 = await call({ action: "mkdir", paths: join(NT, "dist/assets"), confirm: mk.details.token }, NT);
	check("non-temp mkdir works", mk2.details.status === "done" && existsSync(join(NT, "dist/assets")), JSON.stringify(mk2.details));
	const mv = await call({ action: "move", from: join(NT, "notes.md"), to: join(NT, "dist/notes.md") }, NT);
	const mv2 = await call({ action: "move", from: join(NT, "notes.md"), to: join(NT, "dist/notes.md"), confirm: mv.details.token }, NT);
	check("non-temp move works", mv2.details.status === "done" && existsSync(join(NT, "dist/notes.md")), JSON.stringify(mv2.details));
	const rm = await call({ action: "remove", paths: join(NT, "build"), recursive: true }, NT);
	check("non-temp recursive remove is allowed (not PROTECTED)", rm.details.status === "needs-approval", JSON.stringify(rm.details));
	const rm2 = await call({ action: "remove", paths: join(NT, "build"), recursive: true, confirm: rm.details.token }, NT);
	check("non-temp recursive remove executes", rm2.details.status === "done" && !existsSync(join(NT, "build")), rm2.text);
	const anc = await call({ action: "remove", paths: NT, recursive: true }, join(NT, "dist"));
	check("non-temp ancestor-of-cwd still refused", anc.details.code === "ANCESTOR_OF_CWD", JSON.stringify(anc.details));
	const home = await call({ action: "remove", paths: "~/.pi/agent", recursive: true }, NT);
	check("non-temp ~/.pi/agent still refused", home.details.code === "PROTECTED", JSON.stringify(home.details));
	rmSync(NT, { recursive: true, force: true });
}

// -------------------------------- 11. degraded paths: permissions / partials
console.log("\n== permission errors and partial failures ==");
{
	const ok = join(SB, "perm/removable");
	const locked = join(SB, "perm/locked");
	mkdirSync(join(locked, "inner"), { recursive: true });
	mkdirSync(ok, { recursive: true });
	writeFileSync(join(ok, "a.txt"), "a\n");
	writeFileSync(join(locked, "inner/secret.txt"), "s\n");
	chmodSync(locked, 0o000);
	const p = await call({ action: "remove", paths: [ok, locked], recursive: true }, SB);
	check("unreadable dir still previewable (no crash)", p.details.status === "needs-approval", JSON.stringify(p.details).slice(0, 200));
	const p2 = await call({ action: "remove", paths: [ok, locked], recursive: true, confirm: p.details.token }, SB);
	check("partial failure reported as 'partial'", p2.details.status === "partial" && p2.details.errors === 1, JSON.stringify(p2.details));
	check("the removable path WAS removed", !existsSync(ok), p2.text);
	check("the locked path survived with an explicit error line", existsSync(locked) && p2.text.includes("errors (1)"), p2.text);
	chmodSync(locked, 0o755);
}

// -------------------------------------------------- same-turn self-approval
// Regression guard for a real incident: with the "never confirm in the same turn"
// guideline removed, the model read its own preview and replayed the token inside
// one turn, deleting 42 files with no human in the loop. The rule now lives in code.
{
	console.log("\n== same-turn self-approval ==");
	const victim = join(SB, "selfapprove");
	mkdirSync(victim, { recursive: true });
	for (let i = 0; i < 5; i++) writeFileSync(join(victim, `f${i}.txt`), "x\n");
	const p = { action: "remove", paths: victim, recursive: true };

	const prev = await call(p, SB, 3);
	check("preview issues a token", prev.details.status === "needs-approval" && !!prev.details.token, prev.text.slice(0, 120));

	const same = await call({ ...p, confirm: prev.details.token }, SB, 3);
	check("same-turn confirm is REFUSED", same.details.code === "SELF_APPROVAL_BLOCKED", JSON.stringify(same.details));
	check("same-turn confirm changed nothing", existsSync(victim) && readdirSync(victim).length === 5, "files were deleted");
	check("refusal names the missing approval", /same turn|not actually approved|NOT EXECUTED/i.test(same.text), same.text.slice(0, 160));
	check("'approve in advance' is called out as insufficient", /approve in advance|don't ask me/i.test(same.text), same.text.slice(-200));

	// Re-previewing inside the same turn must not advance the anchor and unlock it.
	const rePrev = await call(p, SB, 3);
	const replay = await call({ ...p, confirm: rePrev.details.token }, SB, 3);
	check("re-preview in the same turn does NOT unlock the token", replay.details.code === "SELF_APPROVAL_BLOCKED", JSON.stringify(replay.details));
	check("still nothing deleted after re-preview replay", existsSync(victim) && readdirSync(victim).length === 5, "files were deleted");

	// A token nobody ever previewed cannot be redeemed either.
	const noPrev = await call({ action: "remove", paths: join(SB, "selfapprove/f0.txt"), confirm: "fileops-000000000000" }, SB, 4);
	check("unknown token is refused, not executed", noPrev.details.status !== "done" && existsSync(join(victim, "f0.txt")), JSON.stringify(noPrev.details));

	// The legitimate sequence still works: preview in turn 3, user replies, confirm in turn 4.
	const ok = await call({ ...p, confirm: prev.details.token }, SB, 4);
	check("next-turn confirm EXECUTES", ok.details.status === "done", JSON.stringify(ok.details).slice(0, 200));
	check("next-turn confirm actually removed the tree", !existsSync(victim), "tree survived");

	// Explicit unattended opt-out stays available for automation.
	const auto = join(SB, "unattended");
	mkdirSync(auto, { recursive: true });
	writeFileSync(join(auto, "a.txt"), "x\n");
	const ap = { action: "remove", paths: auto, recursive: true };
	const apPrev = await call(ap, SB, 5);
	process.env.PI_FILE_OPS_UNATTENDED = "1";
	const apRun = await call({ ...ap, confirm: apPrev.details.token }, SB, 5);
	delete process.env.PI_FILE_OPS_UNATTENDED;
	check("PI_FILE_OPS_UNATTENDED=1 allows same-turn confirm", apRun.details.status === "done" && !existsSync(auto), JSON.stringify(apRun.details));
}

// ------------------------------------------------------------------ teardown
console.log(`\n${pass} passed, ${fail} failed${fail ? ": " + failures.join(" | ") : ""}`);
if (process.env.KEEP_SANDBOX !== "1") {
	rmSync(SB, { recursive: true, force: true });
	rmSync(OUTSIDE, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
