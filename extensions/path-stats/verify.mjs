/**
 * Ground-truth verification for path_stats.
 *
 * Every number the tool reports is compared against the real shell command it replaces
 * (`wc -l` / `wc -c` / `wc -w`, `stat`, `shasum -a 256`, and a `find|stat` byte sum for `du`).
 *
 * Fixtures (regenerated on every run) cover: trailing newline, NO trailing newline, CRLF, mixed EOL,
 * empty, UTF-8 multibyte + combining marks + NBSP + emoji, binary, newline-only, and a 100MB file.
 *
 * Usage: node verify.mjs [fixtureDir]   (default /tmp/pstats-fixtures)
 */
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const FIX = process.argv[2] ?? "/tmp/pstats-fixtures";

// --- fixtures ---------------------------------------------------------------
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const w = (name, data) => writeFileSync(join(FIX, name), data);
w("normal.txt", "alpha beta\ngamma\ndelta epsilon zeta\n");
w("noeol.txt", "one two\nthree four");
w("crlf.txt", "a b\r\nc d\r\ne\r\n");
w("empty.txt", "");
w("utf8.txt", "h\u00e9llo w\u00f6rld \u00fcn\u00efcode\n\u65e5\u672c\u8a9e \u30c6\u30ad\u30b9\u30c8\ne\u0301 combining\n\u00a0nbsp-leading\n\ud83d\ude80 emoji \u2705\n");
w("newlines.txt", "\n\n\n");
w("oneword.txt", "x");
w("mixed.txt", "a\r\nb\nc\r\n");
w("weird \u00fcn\u00efcode name (1).txt", "in a file with spaces\nsecond line\n");
// binary: deterministic bytes including NUL
w("random.bin", Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7 + (i % 13)) % 256)));
// large text file: 1.9M lines / ~100MB, written in chunks
{
  const line = "the quick brown fox jumps over the lazy dog 0123456789\n";
  const chunk = line.repeat(10_000);
  const fd = require("node:fs").openSync(join(FIX, "big.txt"), "w");
  for (let i = 0; i < 190; i++) require("node:fs").writeSync(fd, chunk);
  require("node:fs").closeSync(fd);
}
const jiti = createJiti(import.meta.url, { interopDefault: true });
const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => { tool = t; }, on() {}, registerCommand() {} });

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  if (actual === expected) { pass++; return; }
  fails.push(`${name}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
}
function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
}
async function run(args, cwd = FIX) {
  return tool.execute("id", args, undefined, undefined, { cwd });
}

// ---------- per-file exactness vs wc / stat / shasum ----------
const files = readdirSync(FIX).filter((f) => statSync(join(FIX, f)).isFile());
const res = await run({ paths: files, metrics: ["lines", "bytes", "words", "mtime", "sha256"] });
const rowsByPath = new Map(res.details.rows.map((r) => [r.path, r]));

for (const f of files) {
  const abs = join(FIX, f);
  const row = rowsByPath.get(f);
  if (!row) { fails.push(`${f}: no row returned`); continue; }
  // `wc` prefixes counts with padding and the filename; take the first number.
  const wc = sh("wc", ["-lwc", abs]).trim().split(/\s+/);
  const [wcLines, wcWords, wcBytes] = [Number(wc[0]), Number(wc[1]), Number(wc[2])];
  check(`${f} bytes`, row.bytes, wcBytes);
  if (row.binary) {
    check(`${f} binary skips lines`, row.lines, undefined);
  } else {
    check(`${f} lines == wc -l`, row.lines, wcLines);
    // wc -w in the ambient locale can treat U+00A0 etc. as a separator; compare with LC_ALL=C,
    // which is the byte-oriented definition path_stats implements.
    const cWords = Number(sh("/bin/sh", ["-c", `LC_ALL=C wc -w < ${JSON.stringify(abs)}`]));
    check(`${f} words == LC_ALL=C wc -w`, row.words, cWords);
    if (row.words !== wcWords) {
      console.log(`  note: ${f} locale wc -w=${wcWords} vs LC_ALL=C wc -w=${cWords} (path_stats matches the latter)`);
    }
  }
  check(`${f} sha256`, row.sha256, sh("shasum", ["-a", "256", abs]).split(/\s+/)[0]);
  // stat -f %m truncates to whole seconds; mtimeMs keeps sub-second precision.
  check(`${f} mtime`, Math.floor(row.mtimeMs / 1000), Number(sh("stat", ["-f", "%m", abs])));
  check(`${f} type`, row.type, "file");
}

// ---------- semantic flags ----------
check("noeol flagged", rowsByPath.get("noeol.txt")?.noFinalNewline, true);
check("normal not flagged", rowsByPath.get("normal.txt")?.noFinalNewline, false);
check("crlf detected", rowsByPath.get("crlf.txt")?.crlf, true);
check("lf not crlf", rowsByPath.get("normal.txt")?.crlf, false);
check("mixed eol detected", rowsByPath.get("mixed.txt")?.crlf, true);
check("binary detected", rowsByPath.get("random.bin")?.binary, true);
check("empty bytes", rowsByPath.get("empty.txt")?.bytes, 0);
check("empty lines", rowsByPath.get("empty.txt")?.lines, 0);
check("unicode-name row present", rowsByPath.get("weird ünïcode name (1).txt")?.lines, 2);
check("noeol marked with * in text", res.content[0].text.includes("1*"), true);

// ---------- directory aggregate vs find|stat byte sum ----------
const agg = await run({ paths: ["."], recursive: true, metrics: ["bytes"] });
const aggRow = agg.details.rows[0];
const truthBytes = Number(
  sh("/bin/sh", ["-c", `find ${JSON.stringify(FIX)} -type f -exec stat -f %z {} + | awk '{s+=$1} END {print s+0}'`]),
);
const truthFiles = Number(sh("/bin/sh", ["-c", `find ${JSON.stringify(FIX)} -type f | wc -l`]));
check("dir totalBytes == sum of file sizes", aggRow.aggregate.totalBytes, truthBytes);
check("dir file count == find -type f", aggRow.aggregate.files, truthFiles);
check("dir type", aggRow.type, "dir");
check("dir not partial", aggRow.aggregate.partial, false);
check("largest file is big.txt", aggRow.aggregate.largest[0].path, "big.txt");
const duK = Number(sh("/bin/sh", ["-c", `du -sk ${JSON.stringify(FIX)} | cut -f1`]));
console.log(`  note: du -sk=${duK}KB (disk blocks) vs path_stats apparent=${Math.round(truthBytes / 1024)}KB`);

// ---------- non-recursive dir ----------
const nr = await run({ paths: ["."] });
check("non-recursive dir entries", nr.details.rows[0].entries, readdirSync(FIX).length);
check("non-recursive dir has no aggregate", nr.details.rows[0].aggregate, undefined);
check("non-recursive hints recursive", nr.content[0].text.includes("recursive:true"), true);

// ---------- error paths ----------
const err = await run({ paths: ["does-not-exist.txt"] });
check("missing path is ENOENT row", /ENOENT/.test(err.details.rows[0].error ?? ""), true);
check("missing path does not throw", err.details.rows.length, 1);

// ---------- aggregate line totals ----------
const aggLines = await run({ paths: ["."], recursive: true, metrics: ["lines", "bytes"] });
check(
  "aggregate line totals skipped for >64MB tree",
  (aggLines.details.rows[0].aggregate.contentSkipReason ?? "").length > 0,
  true,
);

console.log(`\n${pass} checks passed, ${fails.length} failed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
