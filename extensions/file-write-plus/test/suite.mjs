// Adversarial + correctness suite for file-write-plus. Deterministic, no LLM.
// Usage: node test/suite.mjs [filter]
import { callTool } from "./harness.mjs";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  chmodSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const filter = process.argv[2];
let pass = 0;
let fail = 0;
const failures = [];

function sha(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

async function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  const dir = mkdtempSync(join(tmpdir(), "fwp-suite-"));
  try {
    await fn(dir);
    pass++;
    console.log(`\x1b[32mPASS\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`\x1b[31mFAIL\x1b[0m ${name}\n      ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}
// Theme color names actually provided by pi's theme API (mirrors the built-in tools
// and the sibling grep extension). A typo here would only surface in interactive TUI.
const ALLOWED_COLORS = new Set([
  "toolTitle",
  "accent",
  "dim",
  "muted",
  "error",
  "warning",
  "success",
]);

function has(text, needle, msg) {
  if (!text.includes(needle)) throw new Error(`${msg}\n      missing ${JSON.stringify(needle)} in:\n${text}`);
}

// ---------------------------------------------------------------- append_file

await test("append: creates missing file + parent dirs", async (dir) => {
  const p = join(dir, "a/b/c/log.txt");
  const r = await callTool("append_file", { path: p, content: "first" }, dir);
  eq(readFileSync(p, "utf8"), "first\n", "content");
  has(r.content[0].text, "(created)", "reports creation");
  eq(r.details.totalLines, 1, "line count");
});

await test("append: refuses missing file with createIfMissing:false", async (dir) => {
  const p = join(dir, "nope.txt");
  const r = await callTool("append_file", { path: p, content: "x", createIfMissing: false }, dir);
  has(r.content[0].text, "Error: file does not exist", "error message");
  assert(!existsSync(p), "must not create the file");
});

await test("append: path that does not exist (deep, createIfMissing:false)", async (dir) => {
  const p = join(dir, "missing-dir/deep/x.txt");
  const r = await callTool("append_file", { path: p, content: "x", createIfMissing: false }, dir);
  has(r.content[0].text, "Error:", "error");
  assert(!existsSync(join(dir, "missing-dir")), "must not create dirs");
});

await test("append: file without trailing newline gets a separator", async (dir) => {
  const p = join(dir, "f.txt");
  writeFileSync(p, "no newline here");
  await callTool("append_file", { path: p, content: "entry" }, dir);
  eq(readFileSync(p, "utf8"), "no newline here\nentry\n", "separator inserted");
});

await test("append: reported appendedLines counts the caller's lines, not the separator", async (dir) => {
  const p = join(dir, "f.txt");
  writeFileSync(p, "no newline here");
  const r = await callTool("append_file", { path: p, content: "one entry" }, dir);
  eq(r.details.appendedLines, 1, "one appended line");
  has(r.content[0].text, "Appended 1 line(s)", "text agrees");
  eq(r.details.totalLines, 2, "file total");
});

await test("append: startOnNewLine:false continues the last line", async (dir) => {
  const p = join(dir, "f.txt");
  writeFileSync(p, "abc");
  await callTool("append_file", { path: p, content: "def", startOnNewLine: false }, dir);
  eq(readFileSync(p, "utf8"), "abcdef\n", "continued");
});

await test("append: ensureTrailingNewline:false leaves no final newline", async (dir) => {
  const p = join(dir, "f.txt");
  writeFileSync(p, "a\n");
  await callTool("append_file", { path: p, content: "b", ensureTrailingNewline: false }, dir);
  eq(readFileSync(p, "utf8"), "a\nb", "no trailing newline");
});

await test("append: CRLF file keeps CRLF for inserted newlines", async (dir) => {
  const p = join(dir, "crlf.txt");
  writeFileSync(p, "one\r\ntwo");
  await callTool("append_file", { path: p, content: "three" }, dir);
  eq(readFileSync(p, "utf8"), "one\r\ntwo\r\nthree\r\n", "CRLF preserved and used");
});

await test("append: unicode is byte-exact", async (dir) => {
  const p = join(dir, "u.txt");
  const head = "\uFEFFhéllo — ünïcode ✅ 日本語\n";
  writeFileSync(p, head);
  await callTool("append_file", { path: p, content: "🚀 emoji ✓ ← arrow" }, dir);
  eq(readFileSync(p, "utf8"), head + "🚀 emoji ✓ ← arrow\n", "unicode + BOM preserved");
});

await test("append: expectedTailPattern match allows append", async (dir) => {
  const p = join(dir, "log.txt");
  writeFileSync(p, "## Step 3\n");
  const r = await callTool("append_file", { path: p, content: "done", expectedTailPattern: "## Step 3\\s*" }, dir);
  has(r.content[0].text, "Appended", "appended");
  eq(readFileSync(p, "utf8"), "## Step 3\ndone\n", "content");
});

await test("append: expectedTailPattern mismatch refuses and shows tail", async (dir) => {
  const p = join(dir, "log.txt");
  writeFileSync(p, "## Step 2\n");
  const before = sha(p);
  const r = await callTool("append_file", { path: p, content: "done", expectedTailPattern: "## Step 3\\s*" }, dir);
  has(r.content[0].text, "does not match", "refusal");
  has(r.content[0].text, "## Step 2", "shows actual tail");
  eq(sha(p), before, "file untouched");
});

await test("append: expectedTailPattern on missing file is refused, not silently ignored", async (dir) => {
  const p = join(dir, "ghost.txt");
  const r = await callTool("append_file", { path: p, content: "x", expectedTailPattern: "foo" }, dir);
  has(r.content[0].text, "guard cannot hold", "explains");
  assert(!existsSync(p), "no file created");
});

await test("append: concurrent appends do not clobber each other", async (dir) => {
  const p = join(dir, "concurrent.txt");
  writeFileSync(p, "");
  const payloads = Array.from({ length: 12 }, (_, i) => `entry-${i}: ${"x".repeat(200)}`);
  await Promise.all(payloads.map((c) => callTool("append_file", { path: p, content: c }, dir)));
  const text = readFileSync(p, "utf8");
  for (const c of payloads) has(text, c + "\n", "every payload present intact");
  eq(text.split("\n").filter(Boolean).length, 12, "exactly 12 lines, none lost or merged");
});

await test("append: appending nothing is harmless", async (dir) => {
  const p = join(dir, "f.txt");
  writeFileSync(p, "a\n");
  await callTool("append_file", { path: p, content: "" }, dir);
  eq(readFileSync(p, "utf8"), "a\n", "unchanged");
});

await test("append: strips a leading @ in the path", async (dir) => {
  const p = join(dir, "at.txt");
  writeFileSync(p, "a\n");
  await callTool("append_file", { path: "@" + p, content: "b" }, dir);
  eq(readFileSync(p, "utf8"), "a\nb\n", "written to the un-@'d path");
});

// ------------------------------------------------------------ replace_in_file

const RENAME_FILES = {
  "Repo.kt": `class SubscriptionRepo {
  fun planName(subscription: Subscription): String {
    return subscription.planName
  }
  fun label() = "PLAN_NAME" to subscription.planName
  // subscription.planName is used for display
  val cached = subscription.planName
}
`,
  "Mapper.kt": `object Mapper {
  fun map(s: Subscription) = mapOf(
    "PLAN_NAME" to s.planName,
    "OTHER" to s.planName,
    "THIRD" to s.planName
  )
}
`,
  "Test.kt": `class Tests {
  @Test fun a() { assertEquals("x", s.planName) }
  @Test fun b() { assertEquals("y", s.planName) }
  @Test fun c() { assertEquals("z", s.planName) }
  @Test fun d() { assertEquals("w", s.planName) }
}
`,
};

function seedRename(dir) {
  const paths = [];
  for (const [name, body] of Object.entries(RENAME_FILES)) {
    const p = join(dir, name);
    writeFileSync(p, body);
    paths.push(p);
  }
  return paths;
}

await test("replace: dryRun is the default and has zero side effects", async (dir) => {
  const paths = seedRename(dir);
  const before = paths.map((p) => [sha(p), statSync(p).mtimeMs]);
  const r = await callTool("replace_in_file", { paths, find: "planName", replace: "planTitle" }, dir);
  has(r.content[0].text, "DRY RUN", "labelled dry run");
  has(r.content[0].text, "dryRun:false to apply", "tells how to apply");
  paths.forEach((p, i) => {
    eq(sha(p), before[i][0], `checksum unchanged for ${p}`);
    eq(statSync(p).mtimeMs, before[i][1], `mtime unchanged for ${p}`);
  });
  eq(r.details.totalReplacements, 12, "12 replacements previewed");
  eq(r.details.filesChanged.length, 3, "3 files");
});

await test("replace: applies 12 occurrences across 3 files correctly", async (dir) => {
  const paths = seedRename(dir);
  const r = await callTool(
    "replace_in_file",
    { paths, find: "planName", replace: "planTitle", dryRun: false },
    dir,
  );
  has(r.content[0].text, "APPLIED", "applied");
  eq(r.details.totalReplacements, 12, "12 replacements");
  for (const p of paths) {
    const t = readFileSync(p, "utf8");
    assert(!t.includes("planName"), `no leftover planName in ${p}`);
    assert(t.includes("planTitle"), `renamed in ${p}`);
  }
  // structural equality: only the identifier changed
  for (const [name, body] of Object.entries(RENAME_FILES)) {
    eq(readFileSync(join(dir, name), "utf8"), body.replaceAll("planName", "planTitle"), `exact rewrite of ${name}`);
  }
  has(r.content[0].text, "L5", "preview has line numbers");
});

await test("replace: preview shows before/after with line numbers", async (dir) => {
  const p = join(dir, "x.kt");
  writeFileSync(p, `a\n"PLAN_NAME" to subscription.planName,\nb\n`);
  const r = await callTool(
    "replace_in_file",
    { path: p, find: '"PLAN_NAME" to subscription.planName,', replace: '"PLAN_NAME" to subscription.planName.orEmpty(),' },
    dir,
  );
  const t = r.content[0].text;
  has(t, "L2", "line number");
  has(t, '    - "PLAN_NAME" to subscription.planName,', "before line");
  has(t, '    + "PLAN_NAME" to subscription.planName.orEmpty(),', "after line");
});

await test("replace: 0 matches refuses with guidance", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "hello\n");
  const before = sha(p);
  const r = await callTool("replace_in_file", { path: p, find: "goodbye", replace: "hi", dryRun: false }, dir);
  has(r.content[0].text, "NO CHANGES", "no changes header");
  has(r.content[0].text, "[0 matches]", "per-file note");
  eq(sha(p), before, "untouched");
});

await test("replace: 0 matches hints at case-insensitive alternative", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "Hello World\n");
  const r = await callTool("replace_in_file", { path: p, find: "hello", replace: "bye" }, dir);
  has(r.content[0].text, "case-insensitive match exists", "hint");
});

await test("replace: partial multi-file (one file lacks the text) warns but applies the rest", async (dir) => {
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  writeFileSync(a, "foo foo\n");
  writeFileSync(b, "nothing here\n");
  const r = await callTool("replace_in_file", { paths: [a, b], find: "foo", replace: "bar", dryRun: false }, dir);
  eq(readFileSync(a, "utf8"), "bar bar\n", "a rewritten");
  eq(readFileSync(b, "utf8"), "nothing here\n", "b untouched");
  has(r.content[0].text, "[0 matches]", "warns about b");
  has(r.content[0].text, b, "names b");
});

await test("replace: replaceAll:false with multiple matches is refused", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo\nfoo\n");
  const before = sha(p);
  const r = await callTool(
    "replace_in_file",
    { path: p, find: "foo", replace: "bar", replaceAll: false, dryRun: false },
    dir,
  );
  has(r.content[0].text, "refusing to change only the first", "refusal");
  eq(sha(p), before, "untouched");
});

await test("replace: replaceAll:false with exactly one match works", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo\nbaz\n");
  await callTool("replace_in_file", { path: p, find: "foo", replace: "bar", replaceAll: false, dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "bar\nbaz\n", "single replacement");
});

await test("replace: exceeding maxReplacements writes nothing", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a\n".repeat(50));
  const before = sha(p);
  const r = await callTool(
    "replace_in_file",
    { path: p, find: "a", replace: "b", maxReplacements: 10, dryRun: false },
    dir,
  );
  has(r.content[0].text, "exceeds maxReplacements=10", "refusal");
  eq(sha(p), before, "untouched");
});

await test("replace: default runaway cap of 200 fires", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a\n".repeat(500));
  const r = await callTool("replace_in_file", { path: p, find: "a", replace: "b", dryRun: false }, dir);
  has(r.content[0].text, "exceeds maxReplacements=200", "default cap");
  eq(readFileSync(p, "utf8"), "a\n".repeat(500), "untouched");
});

await test("replace: regex capture groups", async (dir) => {
  const p = join(dir, "x.kt");
  writeFileSync(p, `val a = foo(1)\nval b = foo(22)\n`);
  await callTool(
    "replace_in_file",
    { path: p, find: "foo\\((\\d+)\\)", replace: "bar($1, DEFAULT)", mode: "regex", dryRun: false },
    dir,
  );
  eq(readFileSync(p, "utf8"), "val a = bar(1, DEFAULT)\nval b = bar(22, DEFAULT)\n", "captures expanded");
});

await test("replace: regex $& $$ and two-digit groups", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "abc\n");
  await callTool(
    "replace_in_file",
    { path: p, find: "(a)(b)(c)", replace: "[$&|$1$3|$$|$2]", mode: "regex", dryRun: false },
    dir,
  );
  eq(readFileSync(p, "utf8"), "[abc|ac|$|b]\n", "JS replace semantics");
});

await test("replace: named groups", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "key=value\n");
  await callTool(
    "replace_in_file",
    { path: p, find: "(?<k>\\w+)=(?<v>\\w+)", replace: "$<v>=$<k>", mode: "regex", dryRun: false },
    dir,
  );
  eq(readFileSync(p, "utf8"), "value=key\n", "named groups expanded");
});

await test("replace: literal mode inserts $1 and backslashes verbatim", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "TOKEN\n");
  await callTool("replace_in_file", { path: p, find: "TOKEN", replace: 'a$1b\\n c\\\\d $& $$', dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "a$1b\\n c\\\\d $& $$\n", "verbatim, no $ or backslash interpretation");
});

await test("replace: literal mode does not treat find as a regex", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a.c and abc\n");
  await callTool("replace_in_file", { path: p, find: "a.c", replace: "Z", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "Z and abc\n", "only the literal a.c replaced");
});

await test("replace: regex with a nonexistent group leaves $9 literal (JS parity)", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "abc\n");
  await callTool("replace_in_file", { path: p, find: "(a)", replace: "$1$9", mode: "regex", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "a$9bc\n", "matches String.replace behaviour");
});

await test("replace: overlapping literal matches are non-overlapping like sed", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "aaaa\n");
  const r = await callTool("replace_in_file", { path: p, find: "aa", replace: "b", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "bb\n", "2 non-overlapping matches");
  eq(r.details.totalReplacements, 2, "count");
});

await test("replace: greedy regex overlap (a+ on aaa) is one match", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "aaa bb aa\n");
  const r = await callTool("replace_in_file", { path: p, find: "a+", replace: "X", mode: "regex", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "X bb X\n", "greedy");
  eq(r.details.totalReplacements, 2, "count");
});

await test("replace: overlapping lookahead pattern still terminates", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "abab abab\n");
  const r = await callTool(
    "replace_in_file",
    { path: p, find: "ab(?=ab)", replace: "X", mode: "regex", dryRun: false },
    dir,
  );
  eq(readFileSync(p, "utf8"), "Xab Xab\n", "lookahead does not consume");
  eq(r.details.totalReplacements, 2, "count");
});

await test("replace: empty-matching regex is refused", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "aaa\n");
  const before = sha(p);
  const r = await callTool("replace_in_file", { path: p, find: "x*", replace: "Y", mode: "regex", dryRun: false }, dir);
  has(r.content[0].text, "empty string", "refusal");
  eq(sha(p), before, "untouched");
});

await test("replace: invalid regex reports a clear error", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a\n");
  const r = await callTool("replace_in_file", { path: p, find: "([a-", replace: "b", mode: "regex", dryRun: false }, dir);
  has(r.content[0].text, "invalid regex", "clear error");
});

await test("replace: 'g' flag is rejected with guidance", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a\n");
  const r = await callTool("replace_in_file", { path: p, find: "a", replace: "b", mode: "regex", flags: "gm" }, dir);
  has(r.content[0].text, "do not pass 'g'", "rejected");
});

await test("replace: CRLF file keeps CRLF and no-final-newline state", async (dir) => {
  const p = join(dir, "crlf.txt");
  writeFileSync(p, "one foo\r\ntwo foo\r\nthree foo");
  await callTool("replace_in_file", { path: p, find: "foo", replace: "bar", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "one bar\r\ntwo bar\r\nthree bar", "CRLF + missing final newline preserved");
});

await test("replace: CRLF + multiline regex ^$ works and preview strips \\r", async (dir) => {
  const p = join(dir, "crlf.txt");
  writeFileSync(p, "alpha\r\nbeta\r\n");
  const r = await callTool(
    "replace_in_file",
    { path: p, find: "^beta$", replace: "gamma", mode: "regex", flags: "m", dryRun: false },
    dir,
  );
  // ^beta$ with 'm' should NOT match because of the \r before \n... verify actual behaviour is reported honestly
  const t = readFileSync(p, "utf8");
  if (r.details.totalReplacements === 0) {
    has(r.content[0].text, "[0 matches]", "reported as no match, not silently applied");
    eq(t, "alpha\r\nbeta\r\n", "untouched");
  } else {
    eq(t, "alpha\r\ngamma\r\n", "CRLF intact after multiline replace");
  }
});

await test("replace: bare \\n find on a CRLF file hints at line endings", async (dir) => {
  const p = join(dir, "crlf.txt");
  writeFileSync(p, "a\r\nb\r\n");
  const r = await callTool("replace_in_file", { path: p, find: "a\nb", replace: "z" }, dir);
  has(r.content[0].text, "CRLF line endings", "hint given");
});

await test("replace: unicode + BOM survive a replacement", async (dir) => {
  const p = join(dir, "u.txt");
  writeFileSync(p, "\uFEFFhéllo 日本語 🚀 TARGET ✅ ünïcode\n");
  await callTool("replace_in_file", { path: p, find: "TARGET", replace: "цель→ 🎯", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "\uFEFFhéllo 日本語 🚀 цель→ 🎯 ✅ ünïcode\n", "byte-exact elsewhere");
  eq(readFileSync(p)[0], 0xef, "BOM still first byte");
});

await test("replace: unicode find (emoji) matches", async (dir) => {
  const p = join(dir, "u.txt");
  writeFileSync(p, "status: 🚀 launch 🚀\n");
  const r = await callTool("replace_in_file", { path: p, find: "🚀", replace: "✅", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "status: ✅ launch ✅\n", "emoji replaced");
  eq(r.details.totalReplacements, 2, "count");
});

await test("replace: non-UTF-8 file is refused, not corrupted", async (dir) => {
  const p = join(dir, "latin1.txt");
  writeFileSync(p, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x54, 0x41, 0x52, 0x47, 0x45, 0x54, 0x0a])); // café TARGET
  const before = sha(p);
  const r = await callTool("replace_in_file", { path: p, find: "TARGET", replace: "X", dryRun: false }, dir);
  has(r.content[0].text, "not valid UTF-8", "refused");
  eq(sha(p), before, "byte-identical");
});

await test("replace: binary file with NUL bytes is refused", async (dir) => {
  const p = join(dir, "bin.dat");
  writeFileSync(p, Buffer.from([0x41, 0x00, 0x42, 0x54, 0x41, 0x52, 0x47, 0x45, 0x54]));
  const before = sha(p);
  const r = await callTool("replace_in_file", { path: p, find: "TARGET", replace: "X", dryRun: false }, dir);
  has(r.content[0].text, "binary file", "refused");
  eq(sha(p), before, "byte-identical");
});

await test("replace: nonexistent path reports an error and changes nothing", async (dir) => {
  const good = join(dir, "good.txt");
  writeFileSync(good, "foo\n");
  const r = await callTool(
    "replace_in_file",
    { paths: [join(dir, "ghost.txt"), good], find: "foo", replace: "bar", dryRun: false },
    dir,
  );
  has(r.content[0].text, "file does not exist", "error for the ghost");
  eq(readFileSync(good, "utf8"), "bar\n", "the real file still processed");
});

await test("replace: directory path is refused", async (dir) => {
  const r = await callTool("replace_in_file", { path: dir, find: "a", replace: "b", dryRun: false }, dir);
  has(r.content[0].text, "is a directory", "refused");
});

await test("replace: duplicate paths are de-duplicated (no double apply)", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "aa\n");
  const r = await callTool("replace_in_file", { paths: [p, p, "./x.txt"], find: "a", replace: "b", dryRun: false }, dir);
  eq(readFileSync(p, "utf8"), "bb\n", "applied exactly once");
  eq(r.details.filesChanged.length, 1, "one file");
});

await test("replace: identical find/replace refused as a no-op", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a\n");
  const r = await callTool("replace_in_file", { path: p, find: "a", replace: "a", dryRun: false }, dir);
  has(r.content[0].text, "no-op", "refused");
});

await test("replace: regex whose replacement equals the match is reported as no-op", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "aaa\n");
  const r = await callTool("replace_in_file", { path: p, find: "(a)", replace: "$1", mode: "regex", dryRun: false }, dir);
  has(r.content[0].text, "identical to the matched text", "reported");
  eq(readFileSync(p, "utf8"), "aaa\n", "untouched");
});

await test("replace: missing path/paths is rejected", async (dir) => {
  const r = await callTool("replace_in_file", { find: "a", replace: "b" }, dir);
  has(r.content[0].text, "give `path` or `paths`", "rejected");
});

await test("replace: multiline find spanning lines reports a line range", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "keep\nfoo\nbar\nkeep\n");
  const r = await callTool("replace_in_file", { path: p, find: "foo\nbar", replace: "baz", dryRun: false }, dir);
  has(r.content[0].text, "L2-3", "line range");
  eq(readFileSync(p, "utf8"), "keep\nbaz\nkeep\n", "applied");
});

await test("replace: multiple matches on one line collapse into one preview group", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo foo foo\n");
  const r = await callTool("replace_in_file", { path: p, find: "foo", replace: "bar" }, dir);
  has(r.content[0].text, "(3 matches on this line)", "grouped");
  has(r.content[0].text, "    + bar bar bar", "fully-applied after line");
});

await test("replace: preview is capped for many changed lines", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo\n".repeat(60));
  const r = await callTool("replace_in_file", { path: p, find: "foo", replace: "bar", maxReplacements: 100 }, dir);
  has(r.content[0].text, "more changed line group(s) not shown", "capped");
  assert(r.content[0].text.length < 40000, "output within cap");
});

await test("replace: catastrophic backtracking is aborted by the timeout guard", async (dir) => {
  const p = join(dir, "evil.txt");
  writeFileSync(p, "a".repeat(40) + "X\n");
  const t0 = Date.now();
  const r = await callTool(
    "replace_in_file",
    { path: p, find: "(a+)+$", replace: "Z", mode: "regex", dryRun: false },
    dir,
  );
  const elapsed = Date.now() - t0;
  has(r.content[0].text, "catastrophic backtracking", "explains the guard");
  assert(elapsed < 9000, `guard fired promptly (took ${elapsed} ms)`);
  eq(readFileSync(p, "utf8"), "a".repeat(40) + "X\n", "untouched");
  console.log(`      (guard fired after ${elapsed} ms)`);
});

await test("replace: 10 MB file literal replace stays correct and fast", async (dir) => {
  const p = join(dir, "big.txt");
  const chunk = "filler line with some text to pad it out a bit\n";
  const body = chunk.repeat(Math.ceil((10 * 1024 * 1024) / chunk.length));
  writeFileSync(p, "HEADER TARGET\n" + body + "FOOTER TARGET\n");
  const sizeMb = statSync(p).size / 1024 / 1024;
  const t0 = Date.now();
  const r = await callTool("replace_in_file", { path: p, find: "TARGET", replace: "DONE", dryRun: false }, dir);
  const elapsed = Date.now() - t0;
  eq(r.details.totalReplacements, 2, "2 replacements");
  const out = readFileSync(p, "utf8");
  assert(out.startsWith("HEADER DONE\n"), "head rewritten");
  assert(out.endsWith("FOOTER DONE\n"), "tail rewritten");
  assert(!out.includes("TARGET"), "no leftovers");
  console.log(`      (${sizeMb.toFixed(1)} MB literal replace in ${elapsed} ms)`);
});

await test("replace: 10 MB file regex replace stays within the guard budget", async (dir) => {
  const p = join(dir, "big.txt");
  const chunk = "filler line with some text to pad it out a bit\n";
  const body = chunk.repeat(Math.ceil((10 * 1024 * 1024) / chunk.length));
  writeFileSync(p, "HEADER TARGET_1\n" + body + "FOOTER TARGET_2\n");
  const t0 = Date.now();
  const r = await callTool(
    "replace_in_file",
    { path: p, find: "TARGET_(\\d)", replace: "DONE-$1", mode: "regex", dryRun: false },
    dir,
  );
  const elapsed = Date.now() - t0;
  eq(r.details.totalReplacements, 2, `2 replacements (got: ${r.content[0].text.slice(0, 300)})`);
  const out = readFileSync(p, "utf8");
  assert(out.startsWith("HEADER DONE-1\n"), "head rewritten with capture");
  assert(out.endsWith("FOOTER DONE-2\n"), "tail rewritten with capture");
  console.log(`      (10 MB regex scan in ${elapsed} ms)`);
});

await test("replace: 10 MB file dryRun leaves the file byte-identical", async (dir) => {
  const p = join(dir, "big.txt");
  const chunk = "filler line with some text to pad it out a bit\n";
  writeFileSync(p, "HEADER TARGET\n" + chunk.repeat(Math.ceil((10 * 1024 * 1024) / chunk.length)));
  const before = sha(p);
  await callTool("replace_in_file", { path: p, find: "TARGET", replace: "DONE" }, dir);
  eq(sha(p), before, "checksum identical after dry run");
});

await test("replace: inline-fallback scanner is tagged in the output", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo\n");
  process.env.FWP_FORCE_INLINE_SCAN = "1";
  try {
    const r = await callTool("replace_in_file", { path: p, find: "f(o)o", replace: "b$1b", mode: "regex", dryRun: false }, dir);
    has(r.content[0].text, "scanner=inline-fallback", "tagged per file");
    has(r.content[0].text, "without the backtracking timeout guard", "explained");
    eq(readFileSync(p, "utf8"), "bob\n", "still correct");
    eq(r.details.files[0].scanner, "inline-fallback", "machine-visible in details");
  } finally {
    delete process.env.FWP_FORCE_INLINE_SCAN;
  }
});

await test("replace: read-only file reports a per-file write error, others still applied", async (dir) => {
  const ok = join(dir, "ok.txt");
  const ro = join(dir, "ro.txt");
  writeFileSync(ok, "foo\n");
  writeFileSync(ro, "foo\n");
  chmodSync(ro, 0o444);
  try {
    const r = await callTool("replace_in_file", { paths: [ro, ok], find: "foo", replace: "bar", dryRun: false }, dir);
    has(r.content[0].text, "write failed", "per-file write error reported");
    eq(readFileSync(ro, "utf8"), "foo\n", "read-only file untouched");
    eq(readFileSync(ok, "utf8"), "bar\n", "the writable file was still applied");
  } finally {
    chmodSync(ro, 0o644);
  }
});

await test("replace: symlink target is rewritten, symlink is preserved", async (dir) => {
  const real = join(dir, "real.txt");
  const link = join(dir, "link.txt");
  writeFileSync(real, "foo foo\n");
  symlinkSync(real, link);
  await callTool("replace_in_file", { path: link, find: "foo", replace: "bar", dryRun: false }, dir);
  eq(readFileSync(real, "utf8"), "bar bar\n", "target rewritten");
  assert(lstatSync(link).isSymbolicLink(), "link is still a symlink");
});

await test("replace: mid-session file change between preview and apply is re-scanned", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo\n");
  const preview = await callTool("replace_in_file", { path: p, find: "foo", replace: "bar" }, dir);
  eq(preview.details.totalReplacements, 1, "preview saw 1");
  writeFileSync(p, "foo\nfoo\n"); // the agent edits the file after previewing
  const applied = await callTool("replace_in_file", { path: p, find: "foo", replace: "bar", dryRun: false }, dir);
  eq(applied.details.totalReplacements, 2, "apply re-scanned the CURRENT contents");
  eq(readFileSync(p, "utf8"), "bar\nbar\n", "both replaced");
});

await test("replace: match that disappears before apply is reported, not forced", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo\n");
  await callTool("replace_in_file", { path: p, find: "foo", replace: "bar" }, dir);
  writeFileSync(p, "unrelated\n");
  const r = await callTool("replace_in_file", { path: p, find: "foo", replace: "bar", dryRun: false }, dir);
  has(r.content[0].text, "NO CHANGES", "reported");
  eq(readFileSync(p, "utf8"), "unrelated\n", "untouched");
});

await test("replace: NO CHANGES result never claims 'written'", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "a\n");
  const r = await callTool("replace_in_file", { path: p, find: "zzz", replace: "b", dryRun: false }, dir);
  assert(!r.content[0].text.includes("written"), `must not say 'written':\n${r.content[0].text}`);
});

await test("append: read-only file surfaces a clear failure", async (dir) => {
  const p = join(dir, "ro.txt");
  writeFileSync(p, "a\n");
  chmodSync(p, 0o444);
  try {
    let threw = null;
    try {
      await callTool("append_file", { path: p, content: "b" }, dir);
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, "append to a read-only file must fail loudly");
    has(String(threw.message), "EACCES", "permission error surfaced");
    eq(readFileSync(p, "utf8"), "a\n", "untouched");
  } finally {
    chmodSync(p, 0o644);
  }
});

await test("replace: concurrent replace calls on one file do not lose changes", async (dir) => {
  const p = join(dir, "x.txt");
  writeFileSync(p, "alpha beta\n");
  await Promise.all([
    callTool("replace_in_file", { path: p, find: "alpha", replace: "ALPHA", dryRun: false }, dir),
    callTool("replace_in_file", { path: p, find: "beta", replace: "BETA", dryRun: false }, dir),
  ]);
  eq(readFileSync(p, "utf8"), "ALPHA BETA\n", "both applied (mutation queue serialized them)");
});

// ------------------------------------------------------------------ rendering

await test("render: renderCall/renderResult return components without throwing", async (dir) => {
  const { renderers } = await import("./harness.mjs");
  const theme = {
    fg: (color, text) => {
      if (!ALLOWED_COLORS.has(color)) throw new Error(`unknown theme color "${color}"`);
      return text;
    },
    bold: (t) => t,
  };
  const p = join(dir, "x.txt");
  writeFileSync(p, "foo foo\n");
  const cases = [
    ["append_file", { path: p, content: "hello" }],
    ["replace_in_file", { path: p, find: "foo", replace: "bar", dryRun: false }],
  ];
  for (const [name, args] of cases) {
    const r = renderers(name);
    const call = r.renderCall(args, theme, {});
    assert(call && typeof call === "object", `${name}.renderCall returned a component`);
    const result = await callTool(name, args, dir);
    for (const opts of [
      { expanded: false, isPartial: false },
      { expanded: true, isPartial: false },
      { expanded: false, isPartial: true },
    ]) {
      const comp = r.renderResult(result, opts, theme, {});
      assert(comp && typeof comp === "object", `${name}.renderResult returned a component`);
    }
    // error-shaped result must render too
    const errComp = r.renderResult({ content: [{ type: "text", text: "Error: boom" }], details: {} }, { expanded: false, isPartial: false }, theme, {});
    assert(errComp && typeof errComp === "object", `${name}.renderResult handles errors`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
