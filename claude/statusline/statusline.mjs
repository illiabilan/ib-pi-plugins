#!/usr/bin/env node
/**
 * statusline — the pi `statusbar` extension ported to a Claude Code statusLine command.
 *
 *   ✻ › ⊙ Opus 5.5 › effort:high › ⌂ pi-plugins › ⑂ main *2 +1 ?3 › ◔ 12.4%/1.0M › $0.42 › 14:05
 *
 * Claude Code runs this after every assistant message (and on refreshInterval) with the
 * session JSON on stdin and the terminal size in COLUMNS. It prints one line that never
 * exceeds the width: values are abbreviated first (tiers), then whole segments are dropped
 * in priority order, then the widest tier that still fits is restored. Same algorithm and
 * same glyphs as extensions/statusbar.
 *
 * Segments: mark, model, effort (Claude's equivalent of pi's thinking level), project, git,
 * context, extra (session cost), time (HH:MM). Toggle them in ~/.claude/statusbar.json:
 *   { "mark": "✻", "segments": { "mark": true, "model": true, "effort": true, "project": true,
 *     "git": true, "context": true, "extra": true, "time": true } }
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const SEGMENT_ORDER = ["mark", "model", "effort", "project", "git", "context", "extra", "time"];
/** First entry is dropped first. `mark` is the last survivor. */
export const DROP_ORDER = ["time", "extra", "project", "effort", "model", "context", "git", "mark"];

const GLYPH = { model: "⊙", dir: "⌂", git: "⑂", ctx: "◔", sep: "›" };
const GIT_TIMEOUT_MS = 1500;

const TIERS = [
  { model: 64, branch: 64, dir: 40, counters: "full", shorten: 0 },
  { model: 28, branch: 24, dir: 20, counters: "full", shorten: 0 },
  { model: 18, branch: 16, dir: 14, counters: "full", shorten: 1 },
  { model: 12, branch: 12, dir: 10, counters: "dirty", shorten: 2 },
  { model: 10, branch: 10, dir: 8, counters: "min", shorten: 2 },
];

const DEFAULT_CONFIG = {
  mark: "✻",
  segments: { mark: true, model: true, effort: true, project: true, git: true, context: true, extra: true, time: true },
};

// ---------------------------------------------------------------- terminal width helpers

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function graphemeWidth(g) {
  const cp = g.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (/^\p{Mn}+$/u.test(g)) return 0;
  if (/\p{Extended_Pictographic}/u.test(g) && (g.includes("️") || cp >= 0x1f000)) return 2;
  return isWide(cp) ? 2 : 1;
}

/** Visible columns: ANSI costs 0, wide CJK/emoji cost 2, combining marks cost 0. */
export function visibleWidth(text) {
  let w = 0;
  for (const { segment } of segmenter.segment(stripAnsi(text))) w += graphemeWidth(segment);
  return w;
}

/** Truncate plain text (no ANSI) to `cols` columns, keeping the head. */
export function truncHead(text, cols, ellipsis = "…") {
  if (cols <= 0) return "";
  if (visibleWidth(text) <= cols) return text;
  const room = cols - visibleWidth(ellipsis);
  let out = "";
  let w = 0;
  for (const { segment } of segmenter.segment(text)) {
    const gw = graphemeWidth(segment);
    if (w + gw > room) break;
    out += segment;
    w += gw;
  }
  return out + ellipsis;
}

/** Truncate keeping the END (branch and directory names carry their meaning at the tail). */
export function truncTail(text, cols) {
  if (cols <= 0) return "";
  if (visibleWidth(text) <= cols) return text;
  if (cols === 1) return "…";
  const parts = [...segmenter.segment(text)].map((s) => s.segment);
  let out = "";
  let w = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const gw = graphemeWidth(parts[i]);
    if (w + gw > cols - 1) break;
    out = parts[i] + out;
    w += gw;
  }
  return `…${out}`;
}

/** ANSI-aware hard truncation: guarantees visibleWidth(result) <= width. */
function fit(text, width) {
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let w = 0;
  let i = 0;
  while (i < text.length) {
    ANSI_RE.lastIndex = 0;
    const rest = text.slice(i);
    const m = rest.match(/^(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_])/);
    if (m) { out += m[0]; i += m[0].length; continue; }
    const g = segmenter.segment(rest)[Symbol.iterator]().next().value.segment;
    const gw = graphemeWidth(g);
    if (w + gw > width) break;
    out += g;
    w += gw;
    i += g.length;
  }
  return out.includes("\u001b") ? `${out}\u001b[0m` : out;
}

// ---------------------------------------------------------------- pure helpers

/** Strip escape sequences and control chars so untrusted text (branch, dir) cannot inject ANSI. */
export function sanitize(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  return stripAnsi(String(text)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

export function shortenModel(name, level) {
  let out = name;
  if (level >= 1) {
    const slash = out.lastIndexOf("/");
    if (slash >= 0 && slash < out.length - 1) out = out.slice(slash + 1);
    out = out.replace(/[-@](\d{6,8}|latest|preview|beta)$/i, "").replace(/\s*\((?:[^)]*context[^)]*)\)$/i, "");
  }
  if (level >= 2) out = out.replace(/^(claude|anthropic|models)[-. ]/i, "");
  return out || name;
}

export function fmtTokens(count) {
  if (!Number.isFinite(count) || count < 0) return "?";
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function fmtCost(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost < 0.01) return "$<0.01";
  return `$${cost.toFixed(2)}`;
}

/** `git status --porcelain=v2 --branch` -> counters. Never throws. */
export function parsePorcelainV2(out) {
  const res = { branch: null, detached: false, oid: null, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const v = line.slice(14).trim();
      if (v === "(detached)") res.detached = true;
      else if (v) res.branch = v;
    } else if (line.startsWith("# branch.oid ")) {
      const v = line.slice(13).trim();
      if (v && v !== "(initial)") res.oid = v.slice(0, 7);
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      if (line[2] && line[2] !== ".") res.staged++;
      if (line[3] && line[3] !== ".") res.modified++;
    } else if (line.startsWith("u ")) res.conflicted++;
    else if (line.startsWith("? ")) res.untracked++;
  }
  return res;
}

export function normalizeConfig(raw) {
  const cfg = { mark: DEFAULT_CONFIG.mark, segments: { ...DEFAULT_CONFIG.segments } };
  if (!raw || typeof raw !== "object") return cfg;
  if (typeof raw.mark === "string" && raw.mark.trim()) cfg.mark = sanitize(raw.mark).slice(0, 4);
  if (raw.segments && typeof raw.segments === "object") {
    for (const key of Object.keys(cfg.segments)) {
      if (typeof raw.segments[key] === "boolean") cfg.segments[key] = raw.segments[key];
    }
  }
  return cfg;
}

// ---------------------------------------------------------------- snapshot

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Claude Code stdin JSON (+ git result) -> the renderer's snapshot. */
export function fmtTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function snapshotFrom(input, git, now = new Date()) {
  const cw = input?.context_window ?? {};
  const usage = cw.current_usage;
  const ctxTokens = usage
    ? (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0)
    : null;
  let effort = input?.effort?.level ?? null;
  if (!effort && input?.thinking?.enabled === false) effort = "off";
  const cwd = input?.workspace?.current_dir || input?.cwd || process.cwd();
  return {
    model: input?.model?.display_name || input?.model?.id || null,
    effort,
    projectDir: basename(resolve(cwd)) || cwd,
    branch: git ? (git.detached ? "detached" : git.branch) : null,
    detached: !!git?.detached,
    headOid: git?.oid ?? null,
    git: git ? { staged: git.staged, modified: git.modified, untracked: git.untracked, conflicted: git.conflicted } : null,
    ctxTokens,
    ctxWindow: num(cw.context_window_size) ?? 0,
    ctxPercent: num(cw.used_percentage),
    cost: num(input?.cost?.total_cost_usd) ?? 0,
    time: fmtTime(now),
  };
}

// ---------------------------------------------------------------- render

const COLORS = { accent: 35, dim: 90, muted: 37, warning: 33, error: 31, success: 32 };

export function makeTheme(color = true) {
  return { fg: (name, text) => (color ? `\u001b[${COLORS[name] ?? 39}m${text}\u001b[39m` : text) };
}

function ctxColor(p) {
  if (p === null) return "dim";
  if (p > 90) return "error";
  if (p > 70) return "warning";
  return "dim";
}

function buildSegments(snap, cfg, theme, tier) {
  const seg = cfg.segments;
  const out = new Map();
  if (seg.mark) out.set("mark", theme.fg("accent", cfg.mark));
  if (seg.model) {
    const name = truncHead(shortenModel(sanitize(snap.model ?? "no-model"), tier.shorten), tier.model);
    out.set("model", `${theme.fg("dim", GLYPH.model)} ${theme.fg("muted", name)}`);
  }
  if (seg.effort && snap.effort) out.set("effort", theme.fg("dim", "effort:") + theme.fg("muted", sanitize(snap.effort)));
  if (seg.project && snap.projectDir) {
    out.set("project", `${theme.fg("dim", GLYPH.dir)} ${theme.fg("muted", truncTail(sanitize(snap.projectDir), tier.dir))}`);
  }
  if (seg.git && snap.branch) {
    let label = sanitize(snap.branch);
    if (snap.detached || label === "detached") label = snap.headOid ? `detached@${snap.headOid}` : "detached";
    let text = `${theme.fg("dim", GLYPH.git)} ${theme.fg("muted", truncTail(label, tier.branch))}`;
    const g = snap.git;
    if (g) {
      if (tier.counters !== "min") {
        if (g.modified > 0) text += ` ${theme.fg("warning", `*${g.modified}`)}`;
        if (g.staged > 0) text += ` ${theme.fg("success", `+${g.staged}`)}`;
      }
      if (tier.counters === "full" && g.untracked > 0) text += ` ${theme.fg("dim", `?${g.untracked}`)}`;
      if (g.conflicted > 0) text += ` ${theme.fg("error", `!${g.conflicted}`)}`;
    }
    out.set("git", text);
  }
  if (seg.context && (snap.ctxTokens !== null || snap.ctxWindow > 0)) {
    const p = snap.ctxPercent;
    const value = snap.ctxWindow > 0
      ? `${p !== null ? p.toFixed(1) : "?"}%/${fmtTokens(snap.ctxWindow)}`
      : `${fmtTokens(snap.ctxTokens)}/?`;
    out.set("context", `${theme.fg("dim", GLYPH.ctx)} ${theme.fg(ctxColor(p), value)}`);
  }
  if (seg.extra && snap.cost > 0) out.set("extra", theme.fg("dim", fmtCost(snap.cost)));
  if (seg.time && snap.time) out.set("time", theme.fg("dim", snap.time));
  return out;
}

/** One line, visibleWidth <= width. Pure. */
export function renderStatusLine(snap, cfg, theme, rawWidth) {
  const width = Math.floor(rawWidth);
  if (!Number.isFinite(width) || width <= 0) return "";
  const sep = theme.fg("dim", ` ${GLYPH.sep} `);
  const built = [];
  const segsAt = (i) => (built[i] ??= buildSegments(snap, cfg, theme, TIERS[i]));
  const joinKept = (segs, keep) => SEGMENT_ORDER.filter((k) => keep.has(k) && segs.has(k)).map((k) => segs.get(k)).join(sep);

  // Phase 1: widest abbreviation tier that fits with every segment present.
  for (let i = 0; i < TIERS.length; i++) {
    const segs = segsAt(i);
    if (segs.size === 0) return "";
    const line = joinKept(segs, new Set(segs.keys()));
    if (visibleWidth(line) <= width) return line;
  }
  // Phase 2: drop segments by priority at the tightest tier.
  const segs = segsAt(TIERS.length - 1);
  const keep = new Set(segs.keys());
  let line = joinKept(segs, keep);
  for (const key of DROP_ORDER) {
    if (visibleWidth(line) <= width || keep.size <= 1) break;
    if (!keep.has(key)) continue;
    keep.delete(key);
    line = joinKept(segs, keep);
  }
  // Phase 3: restore the widest tier that still fits with the survivors.
  for (let i = 0; i < TIERS.length; i++) {
    const relaxed = joinKept(segsAt(i), keep);
    if (visibleWidth(relaxed) <= width) { line = relaxed; break; }
  }
  return fit(line, width);
}

// ---------------------------------------------------------------- main

function readGit(cwd) {
  try {
    const out = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], {
      cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024,
    });
    return parsePorcelainV2(out);
  } catch {
    return null; // not a repo, git missing or too slow: the segment disappears
  }
}

function loadConfig() {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    return normalizeConfig(JSON.parse(readFileSync(join(dir, "statusbar.json"), "utf8")));
  } catch {
    return normalizeConfig(undefined);
  }
}

if (process.argv[1]?.endsWith("statusline.mjs")) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    /* render what we can */
  }
  const cfg = loadConfig();
  const cwd = input?.workspace?.current_dir || input?.cwd || process.cwd();
  const git = cfg.segments.git ? readGit(cwd) : null;
  // Claude Code sets COLUMNS; keep a small margin for its own padding.
  const width = (Number(process.env.COLUMNS) || 120) - Number(process.env.STATUSBAR_MARGIN ?? 2);
  const color = !process.env.NO_COLOR;
  process.stdout.write(renderStatusLine(snapshotFrom(input, git), cfg, makeTheme(color), width));
}
