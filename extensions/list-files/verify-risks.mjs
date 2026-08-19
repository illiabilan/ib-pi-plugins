/**
 * verify-risks.mjs — adversarial + differential checks for list_files.
 * Includes differential comparisons against real `find` output on a large repo.
 * Usage: node verify-risks.mjs
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const here = new URL(".", import.meta.url).pathname;
const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

const dir = mkdtempSync(join(tmpdir(), "lsf-verify-"));
let pass = 0;
const fails = [];
function check(name, cond, info = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name} ${info}`);
  }
}
async function run(args, cwd = dir, opts = {}) {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  const res = await tool.execute("id", prepared, opts.signal, opts.onUpdate, { cwd });
  return { text: res.content[0].text, details: res.details, res };
}
/** Emitted path lines only: drops the trailing "... N more"/clipped notices. */
const bodyLines = (text) => {
  const idx = text.indexOf("\n\n");
  return idx === -1
    ? []
    : text
        .slice(idx + 2)
        .split("\n")
        .filter((l) => l && !l.startsWith("... "));
};

// ------------------------- fixtures -------------------------
// unicode / spaces / quotes / newline in names
mkdirSync(join(dir, "weird"), { recursive: true });
writeFileSync(join(dir, "weird", "my file with spaces.kt"), "x");
writeFileSync(join(dir, "weird", "ünïcødé-Ünï.kt"), "x");
writeFileSync(join(dir, "weird", "日本語ファイル.kt"), "x");
writeFileSync(join(dir, "weird", "quote'and\"dquote.kt"), "x");
writeFileSync(join(dir, "weird", "new\nline.kt"), "x");
writeFileSync(join(dir, "weird", "semi;rm -rf $(echo hi).kt"), "x");
writeFileSync(join(dir, "weird", "MixedCase.kt"), "x");

// depth tree: d1/d2/d3/d4 each with a file
let deep = dir;
for (const level of ["d1", "d2", "d3", "d4"]) {
  deep = join(deep, level);
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, `${level}.kt`), level);
}

// noise dirs that must be pruned
for (const noise of ["build", "node_modules", ".git", ".gradle", "dist", ".idea", ".venv"]) {
  mkdirSync(join(dir, "noisy", noise, "inner"), { recursive: true });
  writeFileSync(join(dir, "noisy", noise, "inner", "NoiseAnalytics.kt"), "x");
}
writeFileSync(join(dir, "noisy", "RealAnalytics.kt"), "x");

// symlinks: self loop, mutual loop, broken, file link, dir link
mkdirSync(join(dir, "links"), { recursive: true });
symlinkSync(join(dir, "links", "selfloop"), join(dir, "links", "selfloop"));
symlinkSync(join(dir, "links", "b"), join(dir, "links", "a"));
symlinkSync(join(dir, "links", "a"), join(dir, "links", "b"));
symlinkSync(join(dir, "nope-missing"), join(dir, "links", "broken"));
writeFileSync(join(dir, "links", "target.kt"), "hello");
symlinkSync(join(dir, "links", "target.kt"), join(dir, "links", "linkToFile.kt"));
symlinkSync(join(dir, "weird"), join(dir, "links", "linkToDir"));
// a loop that would make a naive follower recurse forever: links/up -> dir
symlinkSync(dir, join(dir, "links", "up"));

// permission-denied subdir
mkdirSync(join(dir, "secret", "inside"), { recursive: true });
writeFileSync(join(dir, "secret", "inside", "Hidden.kt"), "x");
chmodSync(join(dir, "secret"), 0o000);

// 12k entries in one dir
const big = join(dir, "big");
mkdirSync(big, { recursive: true });
for (let i = 0; i < 12000; i++) writeFileSync(join(big, `f${String(i).padStart(5, "0")}.txt`), "y");
writeFileSync(join(big, "NeedleAnalytics.kt"), "needle");

// mtime + size fixtures
mkdirSync(join(dir, "times"), { recursive: true });
const old = new Date(Date.now() - 30 * 86400000);
writeFileSync(join(dir, "times", "old.txt"), "a");
utimesSync(join(dir, "times", "old.txt"), old, old);
writeFileSync(join(dir, "times", "new.txt"), "b".repeat(5000));
writeFileSync(join(dir, "times", "mid.txt"), "c".repeat(100));
const mid = new Date(Date.now() - 3 * 3600000);
utimesSync(join(dir, "times", "mid.txt"), mid, mid);

// ------------------------- unicode / quoting -------------------------
{
  const { details, text } = await run({ paths: ["weird"], globs: ["*.kt"], type: "file", limit: 50 });
  check("unicode/space/quote/newline/semicolon filenames all listed", details.total === 7, `got ${details.total}`);
  check("newline filename appears verbatim", text.includes("new\nline.kt"));
  check("no shell interpretation of $(...) name", text.includes("semi;rm -rf $(echo hi).kt"));
}

// ------------------------- default ignores -------------------------
{
  const a = await run({ paths: ["noisy"], globs: ["*Analytics*.kt"], type: "file" });
  check("noise dirs pruned by default", a.details.total === 1, `got ${a.details.total}`);
  check("prune count reported in text", a.text.includes("default-ignored dir(s)"));
  const b = await run({ paths: ["noisy"], globs: ["*Analytics*.kt"], type: "file", includeIgnored: true });
  check("includeIgnored:true reaches inside noise dirs", b.details.total === 8, `got ${b.details.total}`);
}

// ------------------------- maxDepth + limit -------------------------
{
  const d1 = await run({ paths: ["d1"], type: "file", maxDepth: 1 });
  check("maxDepth:1 = direct children only", bodyLines(d1.text).join() === "d1/d1.kt", bodyLines(d1.text).join());
  const d2 = await run({ paths: ["d1"], type: "file", maxDepth: 2 });
  check("maxDepth:2 descends one level", d2.details.total === 2, `got ${d2.details.total}`);
  const dAll = await run({ paths: ["d1"], type: "file" });
  check("unlimited depth finds all 4", dAll.details.total === 4, `got ${dAll.details.total}`);
  const dirsOnly = await run({ paths: ["d1"], type: "dir" });
  check("type:dir returns only dirs with trailing slash", bodyLines(dirsOnly.text).every((l) => l.endsWith("/")), bodyLines(dirsOnly.text).join());

  const limited = await run({ paths: ["d1"], type: "file", limit: 2 });
  check("limit truncates but reports total", limited.details.total === 4 && limited.details.shown === 2);
  check("truncation says how to narrow", limited.text.includes("more match(es) not shown (limit=2)"));
  // limit must not change WHICH matches win the sort (deterministic prefix)
  check(
    "limit keeps sorted prefix",
    bodyLines(limited.text).join() === bodyLines(dAll.text).slice(0, 2).join(),
    bodyLines(limited.text).join(),
  );
  // maxDepth + limit together
  const both = await run({ paths: ["d1"], type: "file", maxDepth: 3, limit: 1 });
  check("maxDepth+limit interact independently", both.details.total === 3 && both.details.shown === 1, JSON.stringify(both.details));
}

// ------------------------- symlinks -------------------------
{
  const started = Date.now();
  const all = await run({ paths: ["links"], limit: 100 });
  check("symlink loops do not hang (walk finished <5s)", Date.now() - started < 5000, `${Date.now() - started}ms`);
  check("symlink to dir is not traversed (no weird/ children under links)", !all.text.includes("links/linkToDir/"), all.text);
  const resolved = await run({ paths: ["links"], resolveSymlinks: true, limit: 100 });
  check("resolveSymlinks shows file target", resolved.text.includes("links/linkToFile.kt -> ") && resolved.text.includes("/target.kt"));
  check("symlink loop reported, not crashed", resolved.text.includes("(symlink loop)"), resolved.text);
  check("broken link reported", resolved.text.includes("(broken link)"), resolved.text);
  const filesOnly = await run({ paths: ["links"], type: "file", resolveSymlinks: true, limit: 100 });
  check("type:file excludes broken/looping links", !filesOnly.text.includes("selfloop") && !filesOnly.text.includes("broken"), filesOnly.text);
  check("type:file includes symlink-to-file", filesOnly.text.includes("linkToFile.kt"));
  const dirsOnly = await run({ paths: ["links"], type: "dir", limit: 100 });
  check("type:dir includes symlink-to-dir even without resolveSymlinks", dirsOnly.text.includes("linkToDir"), dirsOnly.text);
}

// ------------------------- permission denied -------------------------
{
  const r = await run({ paths: ["secret"], type: "file" });
  check("permission-denied dir is reported, not silently empty", r.text.includes("permission denied"), r.text);
  check("permission denied counted in details", r.details.unreadableDirs === 1, JSON.stringify(r.details));
  const whole = await run({ globs: ["*Analytics*.kt"], type: "file", limit: 500 });
  check("scan continues past unreadable dir", whole.details.total >= 2 && whole.details.unreadableDirs === 1, JSON.stringify(whole.details));
}

// ------------------------- scale: 12k entries -------------------------
{
  const t0 = Date.now();
  const r = await run({ paths: ["big"], globs: ["*Analytics*"], type: "file" });
  const ms = Date.now() - t0;
  check("12k-entry dir: finds the needle", r.details.total === 1 && r.text.includes("NeedleAnalytics.kt"), r.text.slice(0, 200));
  check("12k-entry dir: fast (<5s)", ms < 5000, `${ms}ms`);
  const wide = await run({ paths: ["big"], type: "file" });
  check("12k-entry dir: total reported, default limit 100", wide.details.total === 12001 && wide.details.shown === 100, JSON.stringify(wide.details));
  check("12k-entry dir: no explicit limit -> soft 8KB budget", wide.text.length <= 8_200, `${wide.text.length}`);
  check("12k-entry dir: unfiltered-listing hint present", wide.text.includes("more match(es) not shown"), wide.text.slice(-300));
  const huge = await run({ paths: ["big"], type: "file", limit: 5000 });
  check("explicit limit raises budget to 50KB and clips with a notice", huge.text.length > 8_200 && huge.text.length <= 50_200 && huge.text.includes("clipped"), `${huge.text.length}`);
  check("clipped output only drops whole lines", huge.text.split("\n").every((l) => !l.startsWith("big/f") || /^big\/f\d{5}\.txt$/.test(l)));
  const counted = await run({ paths: ["big"], type: "file", countOnly: true });
  check("countOnly on 12k files is tiny and exact", counted.details.total === 12001 && counted.text.length < 400, `${counted.text.length}`);
  // An accidental unfiltered recursive listing must self-describe how to narrow.
  const unfiltered = await run({});
  check("unfiltered listing warns how to narrow", unfiltered.text.includes("unfiltered recursive listing"), unfiltered.text.slice(0, 400));
  check("unfiltered listing respects the soft byte budget", unfiltered.text.length <= 8_200, `${unfiltered.text.length}`);
}

// ------------------------- empty result / fallback -------------------------
{
  const none = await run({ paths: ["weird"], globs: ["*.nomatch"], type: "file" });
  check("no matches: explicit message", none.text.includes("no matches"), none.text);
  check("no matches: hints mention basename + includeIgnored + grep", none.text.includes("BASENAME") && none.text.includes("includeIgnored") && none.text.includes("grep"));
  check("no matches: details.total 0", none.details.total === 0);

  const literal = await run({ paths: ["noisy"], globs: ["Analytics"], type: "file" });
  check("literal pattern falls back to substring", literal.details.total === 1 && literal.details.substringFallback === true, JSON.stringify(literal.details));
  check("substring fallback is tagged in output", literal.text.includes("[substring fallback]"), literal.text);

  const exact = await run({ paths: ["noisy"], globs: ["RealAnalytics.kt"], type: "file" });
  check("exact literal name matches without fallback tag", exact.details.total === 1 && exact.details.substringFallback === false);
}

// ------------------------- excludeGlobs -------------------------
{
  const kept = await run({ paths: ["d1"], type: "file", excludeGlobs: ["d3"] });
  check("excludeGlobs prunes a dir subtree", kept.details.total === 2, `got ${kept.details.total}`);
  const path1 = await run({ paths: ["d1"], type: "file", excludeGlobs: ["**/d3/**"] });
  check("path-scoped exclude prunes subtree too", path1.details.total === 2, `got ${path1.details.total}`);
  const path2 = await run({ paths: ["d1"], type: "file", excludeGlobs: ["*/d3/*"] });
  check("star-slash exclude prunes subtree too", path2.details.total === 2, `got ${path2.details.total}`);
  const fileEx = await run({ paths: ["d1"], type: "file", excludeGlobs: ["d4.kt"] });
  check("file-level exclude drops just the file", fileEx.details.total === 3, `got ${fileEx.details.total}`);
}

// ------------------------- mtime / size / meta -------------------------
{
  const recent = await run({ paths: ["times"], type: "file", modifiedAfter: "1d" });
  check('modifiedAfter "1d" excludes the 30-day-old file', recent.details.total === 2 && !recent.text.includes("old.txt"), recent.text);
  const recent2 = await run({ paths: ["times"], type: "file", modifiedAfter: "1h" });
  check('modifiedAfter "1h" excludes the 3h-old file', recent2.details.total === 1 && recent2.text.includes("new.txt"), recent2.text);
  const iso = await run({ paths: ["times"], type: "file", modifiedAfter: new Date(Date.now() - 86400000).toISOString() });
  check("modifiedAfter accepts ISO", iso.details.total === 2, `got ${iso.details.total}`);
  let threw = false;
  try {
    await run({ paths: ["times"], modifiedAfter: "yesterdayish" });
  } catch (e) {
    threw = /could not parse modifiedAfter/.test(e.message);
  }
  check("bad modifiedAfter throws a helpful error", threw);

  const bySize = await run({ paths: ["times"], type: "file", sortBy: "size", withMeta: true });
  const sizeLines = bodyLines(bySize.text);
  check("sortBy size = largest first", /new\.txt$/.test(sizeLines[0]) && /old\.txt$/.test(sizeLines[2]), sizeLines.join(" | "));
  check("withMeta emits size + timestamp columns", /^\s*\d+(\.\d+)?[A-Za-z]*\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+times\//.test(sizeLines[0]), sizeLines[0]);
  const byMtime = await run({ paths: ["times"], type: "file", sortBy: "mtime" });
  check("sortBy mtime = newest first", bodyLines(byMtime.text)[0].endsWith("new.txt"), bodyLines(byMtime.text).join(" | "));
}

// ------------------------- roots -------------------------
{
  const missing = await run({ paths: ["does-not-exist"], globs: ["*"] });
  check("missing root reported as error entry", missing.text.includes("path not found"), missing.text);
  const mixed = await run({ paths: ["does-not-exist", "times"], type: "file" });
  check("one bad root does not abort the others", mixed.details.total === 3 && mixed.details.rootErrors === 1, JSON.stringify(mixed.details));
  const overlap = await run({ paths: ["d1", "d1/d2"], type: "file" });
  check("overlapping roots de-duplicated", overlap.details.total === 4, `got ${overlap.details.total}`);
  const fileRoot = await run({ paths: ["times/new.txt"], withMeta: true });
  check("file root behaves like `ls -la <file>`", fileRoot.details.total === 1 && fileRoot.text.includes("times/new.txt"), fileRoot.text);
  const cwdDefault = await run({ globs: ["d4.kt"] }, join(dir, "d1"));
  check("default path = cwd", cwdDefault.details.total === 1, cwdDefault.text);
}

// ------------------------- arg coercion -------------------------
{
  const s = await run({ path: "times", pattern: "*.txt", type: "file" });
  check("prepareArguments accepts singular string path/pattern", s.details.total === 3, JSON.stringify(s.details));
  const at = await run({ paths: ["@times"], type: "file" });
  check("leading @ in path is stripped", at.details.total === 3, JSON.stringify(at.details));
  let badType = false;
  try {
    await run({ paths: ["times"], type: "files" });
  } catch (e) {
    badType = /type must be/.test(e.message);
  }
  check("invalid type throws", badType);
  let badSort = false;
  try {
    await run({ paths: ["times"], sortBy: "name" });
  } catch (e) {
    badSort = /sortBy must be/.test(e.message);
  }
  check("invalid sortBy throws", badSort);
}

// ------------------------- case sensitivity -------------------------
{
  const insensitive = await run({ paths: ["weird"], globs: ["*mixedcase*.kt"], type: "file" });
  check("globs are case-insensitive by default (ASCII)", insensitive.details.total === 1, insensitive.text);
  const sensitive = await run({ paths: ["weird"], globs: ["*mixedcase*.kt"], type: "file", caseSensitive: true });
  check("caseSensitive:true respects case", sensitive.details.total === 0, sensitive.text);
  // Accented case folding must behave like `find -iname` (verified: find matches
  // '*ünï*' but NOT '*UNI*' for "ünïcødé-Ünï.kt").
  const accentFold = await run({ paths: ["weird"], globs: ["*ÜNÏ*.kt"], type: "file" });
  check("accented glob folds case like find -iname", accentFold.details.total === 1, accentFold.text);
  const asciiVsAccent = await run({ paths: ["weird"], globs: ["*UNI*.kt"], type: "file" });
  check("ASCII glob does NOT match accented name (same as find -iname)", asciiVsAccent.details.total === 0, asciiVsAccent.text);
}

// ------------------------- abort -------------------------
{
  const ac = new AbortController();
  ac.abort();
  let aborted = false;
  try {
    await run({ paths: ["big"], type: "file" }, dir, { signal: ac.signal });
  } catch {
    aborted = true;
  }
  check("aborted signal throws instead of returning partial", aborted);
}

// ------------------------- TUI renderers -------------------------
{
  const theme = { fg: (_c, t) => t, bold: (t) => t };
  const call = tool.renderCall({ globs: ["*.kt"], paths: ["src"] }, theme);
  check("renderCall returns a component", typeof call?.render === "function" || typeof call === "object");
  const r = await run({ paths: ["times"], type: "file" });
  const res = tool.renderResult(r.res, { expanded: false, isPartial: false }, theme);
  check("renderResult returns a component", typeof res === "object" && res !== null);
  const resCall = tool.renderCall({}, theme);
  check("renderCall tolerates empty args", resCall !== undefined);
}

// ------------------------- scan/time cap branches -------------------------
// These only fire on trees far bigger than a test fixture, so they are exercised
// by loading a copy of index.ts with tiny caps (a per-directory-only cap check
// was a real bug: one huge directory walked straight past the limit).
{
  const src = readFileSync(join(here, "index.ts"), "utf8");
  const probePath = join(here, ".cap-probe.ts");
  // Separate file, not a query string: jiti caches by resolved path.
  const timeProbePath = join(here, ".time-probe.ts");
  const bulk = join(dir, "big");
  try {
    writeFileSync(
      probePath,
      src
        .replace("const MAX_SCAN_ENTRIES = 400_000;", "const MAX_SCAN_ENTRIES = 500;")
        .replace("const MAX_MATCHES = 50_000;", "const MAX_MATCHES = 20;"),
    );
    const probeFactory = await jiti.import(probePath, { default: true });
    let probe;
    probeFactory({ registerTool: (t) => (probe = t), on() {}, registerCommand() {} });
    const capped = await probe.execute("id", { paths: [bulk], type: "file" }, undefined, undefined, { cwd: dir });
    const text = capped.content[0].text;
    check("SCAN CAP fires inside one huge directory", capped.details.hitScanCap === true && capped.details.scanned <= 500, JSON.stringify(capped.details));
    check("SCAN CAP is reported in the output", text.includes("SCAN CAP"), text.slice(0, 200));
    check("MATCH CAP header switches to >=N", text.includes(">=20 match(es) (match cap hit") && capped.details.hitMatchCap === true, text.slice(0, 200));

    writeFileSync(timeProbePath, src.replace("const MAX_SCAN_MS = 20_000;", "const MAX_SCAN_MS = 0;"));
    const timeFactory = await jiti.import(timeProbePath, { default: true });
    let timeProbe;
    timeFactory({ registerTool: (t) => (timeProbe = t), on() {}, registerCommand() {} });
    const timed = await timeProbe.execute("id", { paths: [bulk], type: "file" }, undefined, undefined, { cwd: dir });
    check("TIME CAP fires and is reported", timed.details.hitTimeCap === true && timed.content[0].text.includes("TIME CAP"), JSON.stringify(timed.details));
  } finally {
    rmSync(probePath, { force: true });
    rmSync(timeProbePath, { force: true });
  }
}

// ------------------------- differential vs real `find` -------------------------
const REPO = join(process.env.HOME, "StudioProjects/diner/diner-android");
try {
  const cases = [
    {
      name: "diff: *Analytics*.kt under features/subscriptions, no build/test",
      args: { paths: ["features/subscriptions"], globs: ["*Analytics*.kt"], excludeGlobs: ["**/test/**"], type: "file", limit: 5000 },
      find: `find features/subscriptions -type f -iname '*Analytics*.kt' -not -path '*/build/*' -not -path '*/test/*'`,
    },
    {
      name: "diff: two globs at once in features/loyalty",
      args: { paths: ["features/loyalty"], globs: ["*ViewModel.kt", "*Fragment.kt"], type: "file", limit: 5000 },
      find: `find features/loyalty -type f \\( -iname '*ViewModel.kt' -o -iname '*Fragment.kt' \\) -not -path '*/build/*'`,
    },
    {
      name: "diff: maxdepth 1 dirs in features",
      args: { paths: ["features"], type: "dir", maxDepth: 1, limit: 5000 },
      find: `find features -mindepth 1 -maxdepth 1 -type d -not -name build`,
    },
    {
      name: "diff: all .gradle files repo-wide (depth 2)",
      args: { globs: ["*.gradle"], type: "file", maxDepth: 2, limit: 5000 },
      find: `find . -maxdepth 2 -type f -iname '*.gradle' -not -path '*/build/*' -not -path './.git/*' | sed 's|^\\./||'`,
    },
  ];
  for (const c of cases) {
    const mine = await run(c.args, REPO);
    const theirs = execFileSync("bash", ["-c", c.find], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/\/$/, ""))
      .sort();
    const ours = bodyLines(mine.text).map((l) => l.replace(/\/$/, "")).sort();
    const onlyMine = ours.filter((p) => !theirs.includes(p));
    const onlyTheirs = theirs.filter((p) => !ours.includes(p));
    check(c.name, onlyMine.length === 0 && onlyTheirs.length === 0, `+${JSON.stringify(onlyMine.slice(0, 3))} -${JSON.stringify(onlyTheirs.slice(0, 3))} (${ours.length} vs ${theirs.length})`);
  }
  // performance sanity on a 14GB repo
  const t0 = Date.now();
  const wide = await run({ globs: ["*ViewModel.kt"], type: "file", limit: 5000 }, REPO);
  const ms = Date.now() - t0;
  console.log(`INFO  repo-wide *ViewModel.kt: ${wide.details.total} matches, ${wide.details.scanned} scanned, ${ms}ms`);
  check("repo-wide walk completes in <20s", ms < 20000 && !wide.details.hitTimeCap, `${ms}ms`);
} catch (e) {
  console.log(`SKIP  differential-vs-find (${e.message})`);
}

// ------------------------- cleanup -------------------------
chmodSync(join(dir, "secret"), 0o700);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
