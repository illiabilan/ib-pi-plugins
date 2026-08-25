// Real git integration: runGitStatus() + parsePorcelainV2() against actual repositories.
//   node tests/git.test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { runGitStatus, parsePorcelainV2 } from "../index.ts";
import { reporter } from "./helpers.mjs";

const r = reporter("git");
export const ROOT = "/tmp/sbar-git";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const git = (cwd, ...args) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});

function repo(name) {
	const dir = `${ROOT}/${name}`;
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t.t");
	git(dir, "config", "user.name", "t");
	return dir;
}

const check = (name, actual, expected) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) r.fail(`${name}\n      expected ${e}\n      actual   ${a}`);
	else r.ok(`${name} ${a}`);
};

{
	const dir = repo("dirty");
	writeFileSync(`${dir}/tracked.txt`, "one\n");
	writeFileSync(`${dir}/other.txt`, "two\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	writeFileSync(`${dir}/tracked.txt`, "changed\n");
	writeFileSync(`${dir}/staged.txt`, "new\n");
	git(dir, "add", "staged.txt");
	writeFileSync(`${dir}/untracked1.txt`, "x\n");
	writeFileSync(`${dir}/untracked2.txt`, "x\n");
	const g = await runGitStatus(dir);
	check("dirty repo", g, { branch: "main", detached: false, oid: g?.oid, staged: 1, modified: 1, untracked: 2, conflicted: 0 });
	if (!/^[0-9a-f]{7}$/.test(g?.oid ?? "")) r.fail(`oid is not a 7-char sha: ${g?.oid}`);
}
{
	const dir = repo("clean");
	writeFileSync(`${dir}/a.txt`, "a\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	const g = await runGitStatus(dir);
	check("clean repo", g, { branch: "main", detached: false, oid: g?.oid, staged: 0, modified: 0, untracked: 0, conflicted: 0 });
}
{
	const dir = repo("detached");
	writeFileSync(`${dir}/a.txt`, "a\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "one");
	writeFileSync(`${dir}/a.txt`, "b\n");
	git(dir, "commit", "-qam", "two");
	git(dir, "checkout", "-q", "HEAD~1");
	const g = await runGitStatus(dir);
	check("detached HEAD", { branch: g?.branch, detached: g?.detached, oidLen: g?.oid?.length }, { branch: null, detached: true, oidLen: 7 });
}
{
	const dir = repo("exotic");
	writeFileSync(`${dir}/a.txt`, "a\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "one");
	const emoji = "feature/🚀-ünïcode-日本語";
	git(dir, "checkout", "-qb", emoji);
	check("emoji branch", (await runGitStatus(dir))?.branch, emoji);
	git(dir, "checkout", "-qb", `x${"y".repeat(199)}`);
	check("200-char branch", (await runGitStatus(dir))?.branch?.length, 200);
}
{
	const dir = repo("conflict");
	writeFileSync(`${dir}/a.txt`, "base\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "base");
	git(dir, "checkout", "-qb", "side");
	writeFileSync(`${dir}/a.txt`, "side\n");
	git(dir, "commit", "-qam", "side");
	git(dir, "checkout", "-q", "main");
	writeFileSync(`${dir}/a.txt`, "main\n");
	git(dir, "commit", "-qam", "main");
	try {
		git(dir, "merge", "side");
	} catch {
		/* expected */
	}
	const g = await runGitStatus(dir);
	check("merge conflict", { conflicted: g?.conflicted, branch: g?.branch }, { conflicted: 1, branch: "main" });
}
{
	const dir = repo("empty");
	const g = await runGitStatus(dir);
	check("repo with no commits", { branch: g?.branch, oid: g?.oid, untracked: g?.untracked }, { branch: "main", oid: null, untracked: 0 });
}
{
	const dir = repo("renamed");
	writeFileSync(`${dir}/a.txt`, "a\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	git(dir, "mv", "a.txt", "b.txt");
	const g = await runGitStatus(dir);
	check("renamed file (porcelain '2 ')", { staged: g?.staged, modified: g?.modified }, { staged: 1, modified: 0 });
}
{
	const dir = `${ROOT}/plain`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/f.txt`, "x\n");
	check("non-repo -> null", await runGitStatus(dir), null);
	check("missing cwd -> null", await runGitStatus(`${ROOT}/does-not-exist`), null);
}

check(
	"parser: mixed porcelain v2 output",
	parsePorcelainV2(
		[
			"# branch.oid deadbeefdeadbeefdeadbeef",
			"# branch.head weird/branch",
			"# branch.ab +1 -2",
			"1 .M N... 100644 100644 100644 aaa bbb file1",
			"1 M. N... 100644 100644 100644 aaa bbb file2",
			"1 MM N... 100644 100644 100644 aaa bbb file3",
			"2 R. N... 100644 100644 100644 aaa bbb R100 new\told",
			"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict",
			"? untracked1",
			"? untracked2",
			"! ignored",
			"",
		].join("\n"),
	),
	{ branch: "weird/branch", detached: false, oid: "deadbee", staged: 3, modified: 2, untracked: 2, conflicted: 1 },
);
const zero = { branch: null, detached: false, oid: null, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
check("parser: empty input", parsePorcelainV2(""), zero);
check("parser: garbage input", parsePorcelainV2("not\nporcelain\nat all\n"), zero);
check("parser: detached marker", parsePorcelainV2("# branch.head (detached)\n# branch.oid abcdef1234\n"), {
	...zero,
	detached: true,
	oid: "abcdef1",
});
check("parser: initial oid", parsePorcelainV2("# branch.oid (initial)\n# branch.head main\n"), { ...zero, branch: "main" });

r.done();
