/**
 * Adversarial cases for path_stats — each one is designed to make it lie, hang, or crash.
 * Usage: node adversarial.mjs   (uses /tmp/pstats-adv2 as scratch)
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => { tool = t; }, on() {}, registerCommand() {} });

const ROOT = "/tmp/pstats-adv2";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`ok   ${name}`); return; }
  fails.push(`${name}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  console.log(`FAIL ${name}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
}
const run = (args, cwd = ROOT) => tool.execute("id", args, undefined, undefined, { cwd });
const sh = (c) => execFileSync("/bin/sh", ["-c", c], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();

// 1. mid-session state change: no cache may serve a stale count.
writeFileSync(join(ROOT, "mut.txt"), "a\nb\n");
const before = (await run({ paths: ["mut.txt"], metrics: ["lines", "bytes", "sha256"] })).details.rows[0];
appendFileSync(join(ROOT, "mut.txt"), "c\nd\ne\n");
const after = (await run({ paths: ["mut.txt"], metrics: ["lines", "bytes", "sha256"] })).details.rows[0];
check("mid-session append: lines updated", after.lines, 5);
check("mid-session append: bytes updated", after.bytes, 10);
check("mid-session append: sha changed", after.sha256 !== before.sha256, true);
check("mid-session append: matches wc -l", after.lines, Number(sh(`wc -l < ${ROOT}/mut.txt`)));

// 2. sparse 1GB file: apparent size must be reported without reading 1GB.
sh(`mkfile -n 1g ${ROOT}/sparse.img 2>/dev/null || dd if=/dev/zero of=${ROOT}/sparse.img bs=1 count=0 seek=1073741824 2>/dev/null`);
const t0 = Date.now();
const sparse = (await run({ paths: ["sparse.img"], metrics: ["bytes", "mtime"] })).details.rows[0];
check("sparse apparent bytes", sparse.bytes, 1073741824);
check("sparse stat-only is fast (<300ms)", Date.now() - t0 < 300, true);

// 3. one giant line, no newline at all (10MB) — lines must be 0 like wc -l, with the note.
writeFileSync(join(ROOT, "oneline.txt"), "x".repeat(10_000_000));
const oneline = await run({ paths: ["oneline.txt"], metrics: ["lines", "bytes"] });
check("no-newline file lines == wc -l (0)", oneline.details.rows[0].lines, Number(sh(`wc -l < ${ROOT}/oneline.txt`)));
check("no-newline file flagged", oneline.details.rows[0].noFinalNewline, true);
check("no-newline note present", oneline.content[0].text.includes("no-final-newline"), true);

// 4. path cap: 250 paths.
const many = Array.from({ length: 250 }, () => "mut.txt");
const capped = await run({ paths: many, metrics: ["bytes"] });
check("250 paths capped at 200", capped.details.rows.length, 200);
check("cap is reported", capped.content[0].text.includes("not measured"), true);

// 5. empty metrics array falls back to defaults.
const defMetrics = await run({ paths: ["mut.txt"], metrics: [] });
check("empty metrics -> default lines", defMetrics.details.rows[0].lines, 5);

// 6. deep nesting must not blow the stack (macOS PATH_MAX is 1024, so 400 single-char levels is the max).
let deep = join(ROOT, "deep");
mkdirSync(deep);
const DEPTH = 400;
for (let i = 0; i < DEPTH; i++) { deep = join(deep, "d"); mkdirSync(deep); }
writeFileSync(join(deep, "bottom.txt"), "leaf\n");
const deepAgg = (await run({ paths: ["deep"], recursive: true, metrics: ["bytes"] })).details.rows[0].aggregate;
check("deep tree file found", deepAgg.files, 1);
check("deep tree dirs", deepAgg.dirs, DEPTH);

// 7. symlink to a directory passed directly, with recursive.
mkdirSync(join(ROOT, "realdir"));
writeFileSync(join(ROOT, "realdir", "a.txt"), "1\n2\n3\n");
symlinkSync(join(ROOT, "realdir"), join(ROOT, "linkdir"));
const linkAgg = await run({ paths: ["linkdir"], recursive: true, metrics: ["bytes"] });
check("symlinked dir aggregates target", linkAgg.details.rows[0].aggregate.files, 1);
check("symlinked dir notes target", linkAgg.content[0].text.includes("symlink ->"), true);

// 8. trailing slash on a file: tolerated (POSIX would say ENOTDIR) so `src/`-style paths always work.
const slash = await run({ paths: ["mut.txt/"], metrics: ["bytes"] });
check("trailing slash on a file is tolerated", slash.details.rows[0].bytes, 10);

// 9. newline and quote characters in a filename (would break any shell-based implementation).
// (no "/" in the name — that would be a path separator, not a filename character)
const nasty = "we'ird\nname\"$(rm -rf X); `whoami`.txt";
writeFileSync(join(ROOT, nasty), "safe\n");
const nastyRes = await run({ paths: [nasty], metrics: ["lines", "bytes"] });
check("filename with newline/quotes/$() measured", nastyRes.details.rows[0].lines, 1);
check("no shell injection (file still there)", nastyRes.details.rows[0].bytes, 5);

// 9b. a filename crafted to forge an extra table row must be escaped, not rendered raw.
const forge = "innocent.txt  file  10  1\nfake.txt  file  0  0";
writeFileSync(join(ROOT, forge), "x\n");
const forged = await run({ paths: [forge], metrics: ["lines", "bytes"] });
const dataLines = forged.content[0].text.trim().split("\n").length;
check("forged row escaped (1 header + 1 row)", dataLines, 2);
check("forged newline shown as \\n", forged.content[0].text.includes("\\nfake.txt"), true);

// 10. leading @ and ~ normalization.
const at = await run({ paths: ["@mut.txt"], metrics: ["bytes"] });
check("leading @ stripped", at.details.rows[0].bytes, 10);
const tilde = await run({ paths: ["~"], metrics: ["bytes"] });
check("~ resolves to a dir", tilde.details.rows[0].type, "dir");

// 11. abort signal must throw, not return partial silence.
const ac = new AbortController();
ac.abort();
let aborted = false;
try {
  await tool.execute("id", { paths: ["oneline.txt"], metrics: ["lines"] }, ac.signal, undefined, { cwd: ROOT });
} catch {
  aborted = true;
}
check("aborted signal throws", aborted, true);

// 12. empty paths array must throw a clear error (not return an empty table).
let threw = false;
try { await run({ paths: [] }); } catch { threw = true; }
check("empty paths throws", threw, true);

// 13. mid-scan truncation: file shrinks between stat and read.
writeFileSync(join(ROOT, "shrink.txt"), "1\n2\n3\n4\n5\n");
const shrinkRes = await run({ paths: ["shrink.txt"], metrics: ["lines", "bytes"] });
check("baseline shrink lines", shrinkRes.details.rows[0].lines, 5);
writeFileSync(join(ROOT, "shrink.txt"), "1\n");
const shrunk = await run({ paths: ["shrink.txt"], metrics: ["lines", "bytes"] });
check("after shrink lines", shrunk.details.rows[0].lines, 1);
check("after shrink bytes", shrunk.details.rows[0].bytes, 2);

// 14. tiny binary (NUL in first bytes) still hashes, and never reports a bogus line count.
writeFileSync(join(ROOT, "tiny.bin"), Buffer.from([0x00, 0x0a, 0x0a, 0x41]));
const tiny = await run({ paths: ["tiny.bin"], metrics: ["lines", "sha256", "bytes"] });
check("tiny binary detected", tiny.details.rows[0].binary, true);
check("tiny binary no line count", tiny.details.rows[0].lines, undefined);
check("tiny binary hashed", tiny.details.rows[0].sha256, sh(`shasum -a 256 ${ROOT}/tiny.bin | cut -d' ' -f1`));

// 15. permission-denied directory: reported per-path, never fatal, totals flagged as excluding it.
const noperm = join(ROOT, "noperm");
mkdirSync(join(noperm, "inner"), { recursive: true });
writeFileSync(join(noperm, "inner", "secret.txt"), "hidden\n");
sh(`chmod 000 ${JSON.stringify(noperm)}`);
try {
  const denied = await run({ paths: ["noperm"], recursive: true, metrics: ["bytes"] });
  check("denied dir: walk does not throw", denied.details.rows[0].type, "dir");
  check("denied dir: unreadable counted", denied.details.rows[0].aggregate.unreadableDirs, 1);
  check("denied dir: exclusion is stated", denied.content[0].text.includes("unreadable dirs"), true);
  const deniedFlat = await run({ paths: ["noperm"], metrics: ["bytes"] });
  check("denied dir (non-recursive): EACCES reported", /EACCES/.test(deniedFlat.details.rows[0].error ?? ""), true);
} finally {
  sh(`chmod 755 ${JSON.stringify(noperm)}`);
}

// 16. scale: 20k files across 20 dirs must stay fast and exact.
const scale = join(ROOT, "scale");
let expectedBytes = 0;
for (let d = 0; d < 20; d++) {
  const dir = join(scale, `d${d}`);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 1000; i++) {
    const body = "y".repeat(i % 91) + "\n";
    expectedBytes += Buffer.byteLength(body);
    writeFileSync(join(dir, `f${i}.txt`), body);
  }
}
const tScale = Date.now();
const scaleAgg = (await run({ paths: ["scale"], recursive: true, metrics: ["bytes"] })).details.rows[0].aggregate;
const scaleMs = Date.now() - tScale;
check("20k files counted", scaleAgg.files, 20000);
check("20k files byte total exact", scaleAgg.totalBytes, expectedBytes);
check(`20k files walked fast (<3s, was ${scaleMs}ms)`, scaleMs < 3000, true);
check("20k files not partial", scaleAgg.partial, false);

if (!process.env.PSTATS_KEEP) rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} checks passed, ${fails.length} failed`);
process.exit(fails.length === 0 ? 0 : 1);
