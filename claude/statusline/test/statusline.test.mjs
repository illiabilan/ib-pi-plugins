import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fmtLeft, toMs, usageFrom, normalizeConfig, makeTheme, parsePorcelainV2, renderStatusLine, sanitize, shortenModel, snapshotFrom, stripAnsi, visibleWidth,
} from "../statusline.mjs";

const SCRIPT = fileURLToPath(new URL("../statusline.mjs", import.meta.url));
const INPUT = {
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  workspace: { current_dir: "/Users/me/StudioProjects/pi-plugins" },
  effort: { level: "high" },
  context_window: { context_window_size: 1_000_000, used_percentage: 12.4, current_usage: { input_tokens: 100, cache_read_input_tokens: 123_900 } },
  cost: { total_cost_usd: 0.42 },
};
const GIT = { branch: "feature/very-long-branch-name-for-testing", detached: false, oid: "abc1234", staged: 1, modified: 2, untracked: 3, conflicted: 0 };
const cfg = normalizeConfig(undefined);
const NOW = new Date(2026, 9, 28, 9, 5);

test("full line on a wide terminal, same segments as the pi statusbar", () => {
  const line = stripAnsi(renderStatusLine(snapshotFrom(INPUT, GIT, NOW), cfg, makeTheme(), 200));
  assert.equal(line, "✻ › ⊙ Opus 5.5 › effort:high › ⌂ pi-plugins › ⑂ feature/very-long-branch-name-for-testing *2 +1 ?3 › ◔ 12.4%/1.0M › $0.42 › 09:05");
});

test("never exceeds the width, colored or not, from 1 to 200 columns", () => {
  for (const color of [true, false]) {
    for (let w = 1; w <= 200; w++) {
      const line = renderStatusLine(snapshotFrom(INPUT, GIT, NOW), cfg, makeTheme(color), w);
      assert.ok(visibleWidth(line) <= w, `width ${w}: ${visibleWidth(line)} > ${w}: ${stripAnsi(line)}`);
      assert.ok(!stripAnsi(line).includes("\n"));
    }
  }
});

test("degrades by abbreviating first, then dropping extra/project/effort before git and context", () => {
  const at = (w) => stripAnsi(renderStatusLine(snapshotFrom(INPUT, GIT, NOW), cfg, makeTheme(), w));
  assert.match(at(80), /…/); // abbreviated, still has every segment
  assert.match(at(80), /\$0\.42/);
  const narrow = at(40);
  assert.doesNotMatch(narrow, /\$0\.42|⌂|09:05/);
  assert.match(narrow, /⑂/);
  assert.equal(at(3), "✻");
});

test("segment toggles, custom mark, no git outside a repo, null context percentage", () => {
  const c = normalizeConfig({ mark: "π", segments: { extra: false, effort: false, time: false, bogus: true } });
  const snap = snapshotFrom({ ...INPUT, context_window: { context_window_size: 200000, used_percentage: null } }, null);
  assert.equal(stripAnsi(renderStatusLine(snap, c, makeTheme(), 200)), "π › ⊙ Opus 5.5 › ⌂ pi-plugins › ◔ ?%/200k");
});

test("thinking disabled shows effort:off; context color ramps at 70/90%", () => {
  const snap = snapshotFrom({ ...INPUT, effort: undefined, thinking: { enabled: false } }, null);
  assert.match(stripAnsi(renderStatusLine(snap, cfg, makeTheme(), 200)), /effort:off/);
  const hot = snapshotFrom({ ...INPUT, context_window: { context_window_size: 200000, used_percentage: 95 } }, null);
  assert.match(renderStatusLine(hot, cfg, makeTheme(), 200), /\u001b\[31m95\.0%/);
});

test("untrusted branch names cannot inject escape sequences", () => {
  const evil = { ...GIT, branch: "main\u001b[2J\u001b]0;pwned\u0007" };
  const line = renderStatusLine(snapshotFrom(INPUT, evil), cfg, makeTheme(false), 200);
  assert.ok(!line.includes("\u001b"));
  assert.equal(sanitize("a\u0007b\nc"), "a b c");
});

test("helpers: porcelain v2, model shortening, wide chars", () => {
  const g = parsePorcelainV2("# branch.oid 0123456789\n# branch.head (detached)\n1 M. N... a\n1 .M N... b\n2 RM N... c\nu UU N... d\n? e\n");
  assert.deepEqual(g, { branch: null, detached: true, oid: "0123456", staged: 2, modified: 2, untracked: 1, conflicted: 1 });
  assert.equal(shortenModel("claude-opus-5-5-20260101", 2), "opus-5-5");
  assert.equal(shortenModel("Opus 5.5 (1M context)", 1), "Opus 5.5");
  assert.equal(visibleWidth("日本\u001b[31mx\u001b[0m"), 5);
});

test("CLI: reads stdin + COLUMNS, real git repo, config file", () => {
  const repo = mkdtempSync(join(tmpdir(), "sl-"));
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: repo });
  writeFileSync(join(repo, "new.txt"), "x");
  const conf = mkdtempSync(join(tmpdir(), "slc-"));
  writeFileSync(join(conf, "statusbar.json"), JSON.stringify({ segments: { extra: false } }));
  const input = { ...INPUT, workspace: { current_dir: repo } };
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, COLUMNS: "200", NO_COLOR: "1", CLAUDE_CONFIG_DIR: conf },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /⑂ trunk \?1 › ◔ [^›]+ › \d\d:\d\d$/);
  assert.doesNotMatch(r.stdout, /\$0\.42/);
  const bad = spawnSync(process.execPath, [SCRIPT], { input: "garbage", encoding: "utf8", env: { ...process.env, COLUMNS: "80" } });
  assert.equal(bad.status, 0);
  assert.ok(visibleWidth(bad.stdout) <= 78);
});

const nowS = Math.floor(NOW.getTime() / 1000);
const RL = {
  five_hour: { used_percentage: 23, resets_at: nowS + 7800 },
  seven_day: { used_percentage: 76.4, resets_at: nowS + 280000 },
};

test("usage: right-aligned at the edge for subscription accounts, absent for API-key accounts", () => {
  const snap = snapshotFrom({ ...INPUT, rate_limits: RL }, GIT, NOW);
  const line = stripAnsi(renderStatusLine(snap, cfg, makeTheme(), 200));
  assert.equal(visibleWidth(line), 200);
  assert.match(line, /09:05 {2,}5h 23% ↻2h10m · 7d 76% ↻3d5h$/);
  assert.doesNotMatch(stripAnsi(renderStatusLine(snapshotFrom(INPUT, GIT, NOW), cfg, makeTheme(), 200)), /5h|7d/);
});

test("usage: width invariant holds, squeezed form keeps the window nearest its limit, color ramps", () => {
  const snap = snapshotFrom({ ...INPUT, rate_limits: RL }, GIT, NOW);
  for (let w = 1; w <= 200; w++) assert.ok(visibleWidth(renderStatusLine(snap, cfg, makeTheme(), w)) <= w, `width ${w}`);
  const squeezed = [100, 90, 80].map((w) => stripAnsi(renderStatusLine(snap, cfg, makeTheme(), w))).find((l) => /%$/.test(l) && !l.includes("·"));
  assert.match(squeezed, /7d 76%$/);
  assert.match(renderStatusLine(snap, cfg, makeTheme(), 200), /\u001b\[33m76%/);
});

test("usage: spend limit for enterprise/gateway accounts, reset formats, toggle", () => {
  const u = usageFrom({ spend_limit: { used_percentage: 24, used_usd: 12.3, limit_usd: 50, period: "monthly", resets_at: "2026-11-01T00:00:00Z" } }, Date.parse("2026-10-28T14:00:00Z"));
  assert.deepEqual(u, [{ label: "$12/$50 mo", pct: 24, left: "3d10h", spend: true }]);
  assert.equal(toMs(1700000000), 1700000000000);
  assert.equal(toMs(1700000000000), 1700000000000);
  assert.equal(fmtLeft(45 * 60000), "45m");
  assert.equal(fmtLeft(-1), null);
  assert.deepEqual(usageFrom({ five_hour: {} }), []);
  const off = normalizeConfig({ segments: { usage: false }, margin: 2 });
  assert.equal(off.margin, 2);
  const snap = snapshotFrom({ ...INPUT, rate_limits: RL }, GIT, NOW);
  assert.doesNotMatch(stripAnsi(renderStatusLine(snap, off, makeTheme(), 200)), /5h/);
});
