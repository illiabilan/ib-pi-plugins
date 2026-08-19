/**
 * Classifier behaviour tests. Self-contained: builds a small fixture tree in a
 * temp dir so path-existence checks behave the same on any machine.
 *
 *   node tests/classify.test.mjs [--verbose]
 *
 * Every "must NEVER block" case below is a real over-blocking risk from the
 * design review or from a bug actually observed while validating this extension.
 */
import { classify, breToEre } from "../classify.ts";
import { parseCommand } from "../parse.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CWD = mkdtempSync(join(tmpdir(), "guard-fixture-"));
for (const d of ["features", "features/subscriptions", "features/subscriptions/build", "dirA", "dirB", "logs"]) mkdirSync(join(CWD, d), { recursive: true });
for (const f of ["build.gradle", "big.kt", "a.txt", "v1.kt", "v2.kt", "features/subscriptions/build.gradle", "features/subscriptions/Foo.kt", "logs/build.log", "scratch.tmp"])
  writeFileSync(join(CWD, f), "line\n".repeat(200));

const statPath = (p) => { try { if (!existsSync(p)) return "missing"; return statSync(p).isDirectory() ? "dir" : "file"; } catch { return "unknown"; } };
const c = (cmd, cwd = CWD) => classify(cmd, { cwd, statPath });

let fails = 0;
const expect = (name, cmd, want) => {
  const d = c(cmd);
  const ok = d.kind === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${want.padEnd(5)} got=${d.kind.padEnd(5)} ${name}`);
  if (!ok || process.argv.includes("--verbose"))
    console.log(`      cmd: ${cmd.replace(/\n/g, " ⏎ ").slice(0, 160)}\n      -> ${d.call ? d.call.tool + " " + JSON.stringify(d.call.args) : d.note || d.why}`);
};

console.log("--- must NEVER block ---");
expect("heredoc whose BODY contains grep -rn and rm -rf", `cat > note.md <<'EOF'\ngrep -rn "TODO" .\nrm -rf /tmp/x\nEOF`, "nudge");
expect("python heredoc mentioning cat/ls", `python3 - <<'PY'\nprint("cat foo.kt")\nPY`, "allow");
expect("cat feeding a script", "cat build.gradle | python3 -c 'import sys; print(len(sys.stdin.read()))'", "allow");
expect("cat feeding awk", "cat build.gradle | awk -F= '{print $1}' | sort", "allow");
expect("find -exec doing real work", `find features -name "*.kt" -exec grep -l TODO {} \\;`, "allow");
expect("find -delete", `find logs -name "*.log" -delete`, "allow");
expect("redirect to a file", "grep -rn TODO features > todo.txt", "allow");
expect("append to a file", "ls -la >> listing.txt", "allow");
expect("variable reference", "ls -la $HOME/StudioProjects", "allow");
expect("command substitution", "cat $(ls features | head -1)/build.gradle", "allow");
expect("for loop", "for f in features/*/build.gradle; do echo $f; done", "allow");
expect("subshell + background + kill", "(pi -p hi > out.log 2>&1 & P=$!; sleep 5; kill -9 $P)", "allow");
expect("unknown binary", "./gradlew --stop", "allow");
expect("git subcommand with no tool action", "git remote -v", "allow");
expect("git branch rename", "git branch -M main", "allow");
expect("pi --help", "pi --help 2>&1 | head -80", "allow");
expect("in-place sed edit", `sed -i '' 's/a/b/' build.gradle`, "allow");
expect("ssh wrapper", "ssh box 'ls -la /var/log'", "allow");
expect("xargs pipeline", `find . -name "*.kt" | xargs grep -l TODO`, "allow");
expect("conditional fallback", "ls .docs 2>/dev/null || echo none", "allow");
expect("grep -P (PCRE has no tool equivalent)", `grep -rnP "(?<=x)y" features`, "nudge");
expect("grep over two directories", "grep -rn TODO features/subscriptions dirA", "nudge");
expect("grep over a shell-expanded glob", "grep -n TODO *.gradle", "nudge");
expect("BRE backreference", `grep -rn "\\(ab\\)\\1" features`, "nudge");
expect("find at filesystem root", `find / -iname "*.kt" 2>/dev/null`, "nudge");
expect("find in HOME", `find ~ -name "*.kt"`, "nudge");
expect("tail -f", "tail -f logs/build.log", "nudge");
expect("multiple statements, mixed intents", "ls -la && git status && wc -l build.gradle", "nudge");
// Deliberately NOT a block: an exact recursive count is where ripgrep's
// .gitignore skipping diverges most (measured 647 vs 0 on a real repo).
expect("recursive grep count via wc -l", `grep -rn "Foo" --include=*.kt features/ | wc -l`, "nudge");
expect("recursive grep -c", `grep -rc "Foo" features/`, "nudge");

console.log("\n--- must block (exact equivalent, concrete call) ---");
expect("sed range", `sed -n '120,160p' features/subscriptions/build.gradle`, "block");
expect("cat single file", "cat build.gradle", "block");
expect("cat two files", "cat a.txt build.gradle", "block");
expect("head -N", "head -50 build.gradle", "block");
expect("ls -la", "ls -la features/subscriptions", "block");
expect("find by name+type", `find features/subscriptions -name "*.kt" -type f`, "block");
expect("grep recursive with include", `grep -rn "Foo" --include=*.kt features/`, "block");
expect("grep single file with -c", `grep -c "line" build.gradle`, "block");
expect("grep | head -N folds into limit", `grep -rn "Foo" features/ | head -20`, "block");
expect("git status", "git status", "block");
expect("git commit -m", 'git commit -m "msg"', "block");
expect("rm -rf", "rm -rf scratch.tmp", "block");
expect("mkdir -p", "mkdir -p a/b", "block");
expect("wc -l", "wc -l build.gradle", "block");
expect("du -sh", "du -sh features/subscriptions", "block");
expect("diff -u", "diff -u v1.kt v2.kt", "block");
expect("diff -rq on dirs", "diff -rq dirA dirB", "block");
expect("which", "which gh", "block");
expect("env | grep (secret leak)", "env | grep TOKEN", "block");
expect("cd prefix + grep", `cd ${CWD} && grep -rn TODO .`, "block");
expect("quoted --include value still parses as a flag", `grep -rn "Foo" --include="*.kt" features/`, "block");

console.log("\n--- blocked, but the caveat note must be there ---");
for (const cmd of [`grep -rn "Foo" --include=*.kt features/`, `find features/subscriptions/build -name "*.html"`]) {
  const d = c(cmd);
  const has = d.kind === "block" && (d.notes ?? []).length > 0;
  if (!has) fails++;
  console.log(`${has ? "ok  " : "FAIL"} ${cmd}\n      note: ${(d.notes ?? []).join(" | ").slice(0, 200) || "(none)"}`);
}

console.log("\n--- BRE -> ERE translation (grep's default dialect) ---");
const eq = (a, b, name) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${JSON.stringify(a)}${ok ? "" : " expected " + JSON.stringify(b)}`); };
eq(breToEre("Werror\\|allWarnings"), "Werror|allWarnings", "BRE alternation becomes ERE alternation");
eq(breToEre("\\bFoo\\b"), "\\bFoo\\b", "word boundaries survive untouched");
eq(breToEre("a|b"), "a\\|b", "literal pipe in BRE gets escaped for ERE");
eq(breToEre("foo(bar)"), "foo\\(bar\\)", "literal parens get escaped");
eq(breToEre("\\(a\\|b\\)+"), "(a|b)\\+", "BRE group + literal plus");
eq(breToEre("[a-z|]x"), "[a-z|]x", "bracket expression copied verbatim");
eq(breToEre("\\1"), null, "backreference is untranslatable -> no block");
const bre = c(`grep -rn "Werror\\|allWarnings" --include=*.gradle features/`);
eq(bre.call?.args?.pattern, "Werror|allWarnings", "block call carries the translated pattern");
eq((bre.notes ?? []).some((n) => /BRE/.test(n)), true, "translation is stated in the refusal");

console.log("\n--- shell quoting (a stripped backslash silently rewrites a regex) ---");
eq(parseCommand('grep -rn "\\bFoo\\b" .').segments[0].words.map((w) => w.v), ["grep", "-rn", "\\bFoo\\b", "."], "backslash kept inside double quotes");
eq(parseCommand('echo "a\\"b"').segments[0].words.map((w) => w.v), ["echo", 'a"b'], "backslash removed before an escaped quote");
eq(parseCommand('grep --include="*.kt" -rn x .').segments[0].words.filter((w) => w.qs).length, 0, "a quoted flag VALUE does not make the flag a positional");

rmSync(CWD, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURES` : "\nall classifier expectations held");
process.exit(fails ? 1 : 0);
