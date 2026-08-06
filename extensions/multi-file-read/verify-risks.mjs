/**
 * verify-risks.mjs - closes out the "Known Unverified Risks" list.
 * Each case asserts real behavior of execute()/renderCall/renderResult.
 * Usage: node verify-risks.mjs
 */
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const here = new URL(".", import.meta.url).pathname;
const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

const dir = mkdtempSync(join(tmpdir(), "mfr-verify-"));
let pass = 0;
const fails = [];
function check(name, cond, info = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name} ${info}`); }
}
async function run(args, opts = {}) {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  const res = await tool.execute("id", prepared, opts.signal, opts.onUpdate, { cwd: opts.cwd ?? dir });
  return { text: res.content[0].text, details: res.details, res };
}

// ---------- fixtures ----------
writeFileSync(join(dir, "target.txt"), "alpha\nbeta\ngamma\n");
symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
// UTF-16LE with BOM, all-CJK payload (no NUL in first bytes beyond BOM pattern)
const cjk = "日本語のテキストです。".repeat(400);
writeFileSync(join(dir, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cjk, "utf16le")]));
// UTF-16BE BOM
writeFileSync(join(dir, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("hello world", "utf16le").swap16()]));
// Latin-1 (invalid UTF-8) text, no NULs
writeFileSync(join(dir, "latin1.txt"), Buffer.from("café über straße señor ".repeat(200), "latin1"));
// legit UTF-8 multibyte control file (must NOT be flagged)
writeFileSync(join(dir, "utf8.txt"), cjk + "\n");
// many long-path files to stress the header-overhead reserve
const longNames = [];
for (let i = 0; i < 40; i++) {
  const n = `${"deep-directory-name-segment-".repeat(4)}file-number-${i}.txt`;
  writeFileSync(join(dir, n), "x".repeat(4000) + "\n" + "y".repeat(4000) + "\n");
  longNames.push(n);
}

// ---------- RISK 1: symlink aliasing ----------
{
  const { text, details } = await run({ files: [{ path: "target.txt" }, { path: "link.txt" }] });
  const blocks = (text.match(/^===== /gm) || []).length;
  check("symlink dedupe: link.txt + target read once", blocks === 1 && /duplicate request\(s\) collapsed/.test(text), `blocks=${blocks}`);
  check("symlink dedupe: content still present", text.includes("alpha") && details.errorCount === 0);
}

// ---------- RISK 2: non-UTF-8 encodings ----------
{
  const { text } = await run({ files: [{ path: "utf16.txt" }, { path: "utf16be.txt" }, { path: "latin1.txt" }, { path: "utf8.txt" }] });
  check("UTF-16LE BOM flagged", /utf16\.txt - ERROR: UTF-16LE/.test(text));
  check("UTF-16BE BOM flagged", /utf16be\.txt - ERROR: UTF-16BE/.test(text));
  check("Latin-1 (invalid UTF-8) flagged", /latin1\.txt - ERROR: not valid UTF-8/.test(text));
  check("valid UTF-8 CJK NOT flagged", /===== utf8\.txt \(lines 1-1 of 1\)/.test(text) && text.includes("日本語"));
}

// ---------- RISK 3: budget overshoot ----------
{
  for (const budget of [1024, 4096, 20000, 50 * 1024, 200 * 1024]) {
    const { text } = await run({ files: longNames.map((p) => ({ path: p })), maxTotalBytes: budget });
    const size = Buffer.byteLength(text, "utf-8");
    check(`budget respected exactly (maxTotalBytes=${budget})`, size <= budget, `emitted=${size}`);
  }
  // and with lineNumbers off
  const { text } = await run({ files: longNames.map((p) => ({ path: p })), maxTotalBytes: 8000, lineNumbers: false });
  check("budget respected with lineNumbers:false", Buffer.byteLength(text) <= 8000, `emitted=${Buffer.byteLength(text)}`);
}

// ---------- RISK 4: abort / cancellation ----------
{
  // pre-aborted signal
  const ac = new AbortController();
  ac.abort();
  let threw = null;
  try { await run({ files: [{ path: "target.txt" }] }, { signal: ac.signal }); } catch (e) { threw = e; }
  check("pre-aborted signal throws, returns no content", threw !== null, String(threw));

  // abort mid-flight (right after the call starts)
  const ac2 = new AbortController();
  const p = run({ files: longNames.map((n) => ({ path: n })) }, { signal: ac2.signal });
  ac2.abort();
  let threw2 = null;
  try { await p; } catch (e) { threw2 = e; }
  check("mid-flight abort throws instead of returning partial result", threw2 !== null, String(threw2));

  // non-aborted signal still works
  const ok = await run({ files: [{ path: "target.txt" }] }, { signal: new AbortController().signal });
  check("live (non-aborted) signal works normally", ok.text.includes("alpha"));
}

// ---------- RISK 5: TUI renderCall / renderResult ----------
{
  // Use pi's REAL Theme instance (ANSI colors and all), not a stub.
  const themeMod = await import(
    "file://" + join(here, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")
  );
  themeMod.initTheme();
  const th = themeMod.theme;
  check("using real pi Theme instance", typeof th.fg === "function" && th.fg("accent", "x").includes("\u001b["));
  const call = tool.renderCall({ files: [{ path: "a.txt" }, { path: "b.txt" }] }, th);
  const callLines = call.render(80);
  check("renderCall renders non-empty lines", callLines.length > 0 && callLines.join("").includes("a.txt"), JSON.stringify(callLines));
  const callEmpty = tool.renderCall({}, th).render(80);
  check("renderCall handles missing args", callEmpty.join("").includes("(no files)"));

  const { res } = await run({ files: [{ path: "target.txt" }, { path: "missing.txt" }, ...longNames.slice(0, 20).map((p) => ({ path: p }))] });
  for (const expanded of [false, true]) {
    const out = tool.renderResult(res, { expanded }, th).render(80);
    const joined = out.join("\n");
    check(`renderResult (expanded=${expanded}) renders`, out.length > 0 && joined.includes("multi_file_read:"));
    check(`renderResult (expanded=${expanded}) width-bounded`, out.every((l) => stripAnsi(l).length <= 80), JSON.stringify(out.find((l) => stripAnsi(l).length > 80)));
  }
  const collapsed = tool.renderResult(res, { expanded: false }, th).render(80).join("\n");
  check("renderResult collapses long lists with '... more'", /\.\.\. \d+ more/.test(stripAnsi(collapsed)));
  const bare = tool.renderResult({ content: [], details: undefined }, { expanded: true }, th).render(80);
  check("renderResult survives missing details", Array.isArray(bare));
}
function stripAnsi(s) { return s.replace(/\u001b\[[0-9;]*m/g, ""); }

// ---------- RISK 6: legacy / resumed-session argument shapes ----------
{
  const shapes = [
    ["legacy paths[] of strings", { paths: ["target.txt", "utf8.txt"] }],
    ["files[] of bare strings", { files: ["target.txt"] }],
    ["mixed strings + objects", { files: ["target.txt", { path: "utf8.txt", limit: 1 }] }],
    ["stringified numbers ignored gracefully", { files: [{ path: "target.txt", offset: 2 }] }],
    ["junk entries dropped", { files: [null, 42, { nopath: 1 }, "target.txt"] }],
    ["@-prefixed and ./ paths", { files: ["@target.txt", "./target.txt"] }],
  ];
  for (const [name, args] of shapes) {
    try {
      const { text } = await run(args);
      check(`arg shape: ${name}`, text.includes("multi_file_read:") && !/ERROR: file not found/.test(text), text.slice(0, 200));
    } catch (e) {
      check(`arg shape: ${name}`, false, String(e));
    }
  }
  let threwEmpty = null;
  try { await run({ files: [] }); } catch (e) { threwEmpty = e; }
  check("empty files[] gives a clear error", /at least one path/.test(String(threwEmpty)));
}

// ---------- RISK 7: huge files / blocking filesystem objects ----------
{
  const { execSync } = await import("node:child_process");
  // 20MB sparse-ish file, over the 16MB per-file cap
  execSync(`dd if=/dev/zero bs=1m count=20 2>/dev/null | tr '\\0' 'a' > ${join(dir, "huge.txt")}`, { shell: "/bin/bash" });
  const t0 = Date.now();
  const { text } = await run({ files: [{ path: "huge.txt" }, { path: "target.txt" }] });
  const ms = Date.now() - t0;
  check("oversized file refused with bash fallback, not loaded", /huge\.txt - ERROR: file is 20\.0MB, over the 16\.0MB per-file limit/.test(text), text.slice(0, 200));
  check("oversized refusal is fast (no full read)", ms < 500, `${ms}ms`);
  check("other files in the same call still returned", text.includes("alpha"));

  // a 5MB file (under cap) must still work, bounded output
  execSync(`node -e "require('fs').writeFileSync('${join(dir, "big.txt")}', 'line-of-text\\n'.repeat(360000))"`);
  const big = await run({ files: [{ path: "big.txt" }] });
  check("5MB file read and truncated within budget", Buffer.byteLength(big.text) <= 50 * 1024 && /TRUNCATED/.test(big.text));

  // FIFO would block forever on readFile -> must be refused
  execSync(`mkfifo ${join(dir, "pipe.fifo")}`);
  const fifo = await Promise.race([
    run({ files: [{ path: "pipe.fifo" }, { path: "target.txt" }] }),
    new Promise((r) => setTimeout(() => r({ text: "__HUNG__" }), 2000)),
  ]);
  check("FIFO refused instead of hanging", /pipe\.fifo - ERROR: a FIFO\/pipe/.test(fifo.text), fifo.text.slice(0, 120));
  check("device file refused", /ERROR: a device/.test((await run({ files: [{ path: "/dev/zero" }] })).text));
}

// ---------- extra: onUpdate contract ----------
{
  const seen = [];
  await run({ files: [{ path: "target.txt" }] }, { onUpdate: (u) => seen.push(u) });
  check("onUpdate emits a progress update with text content", seen.length === 1 && seen[0].content[0].type === "text");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("FAILED: " + fails.join(" | ")); process.exit(1); }
