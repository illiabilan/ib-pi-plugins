/**
 * statusbar — a segmented status bar / infobar that replaces pi's built-in footer.
 *
 *   git guard active (120s timeout)                       <- dim status line (only when set)
 *   π 〉 ⊙ sonnet-4-5 〉 think:high 〉 ⌂ pi-plugins 〉 ⑂ main *2 +1 〉 ◔ 12.4%/200k 〉 $0.42
 *
 * Design invariants (see README):
 *   1. render() is pure: it only reads a cached snapshot + the live theme. No child
 *      processes, no fs, no network, no O(session) scans.
 *   2. The rendered visible width is never > the width handed to render(); segments are
 *      dropped by priority and the result is finally hard-truncated ANSI-aware.
 *   3. All colours come from the theme (accent/dim/muted/warning/error/success), so the
 *      bar follows dark/light themes and live theme switches (pi hands us a live proxy).
 *   4. One interval, one branch subscription, both released on dispose/teardown.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal theme surface used by the renderer (the real Theme is a superset). */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export type SegKey = "pi" | "model" | "think" | "project" | "git" | "context" | "extra";

/** Display order, left to right. */
export const SEGMENT_ORDER: readonly SegKey[] = ["pi", "model", "think", "project", "git", "context", "extra"];

/** Width-degradation order: first entry is dropped first. `pi` is the last survivor. */
export const DROP_ORDER: readonly SegKey[] = ["extra", "project", "think", "model", "context", "git", "pi"];

export interface GitCounts {
	branch: string | null;
	detached: boolean;
	oid: string | null;
	staged: number;
	modified: number;
	untracked: number;
	conflicted: number;
}

export interface Snapshot {
	modelId: string | null;
	provider: string | null;
	showProvider: boolean;
	thinking: string | null;
	projectDir: string;
	/** null => not a git repo (segment disappears) */
	branch: string | null;
	detached: boolean;
	headOid: string | null;
	/** null => counters unknown yet (branch still shown) */
	git: { staged: number; modified: number; untracked: number; conflicted: number } | null;
	ctxTokens: number | null;
	/** 0 => unknown context window */
	ctxWindow: number;
	ctxPercent: number | null;
	cost: number;
}

export interface StatusbarConfig {
	enabled: boolean;
	segments: Record<SegKey | "statuses", boolean>;
}

export interface RenderArgs {
	snap: Snapshot;
	cfg: StatusbarConfig;
	theme: ThemeLike;
	width: number;
	statuses?: ReadonlyMap<string, string> | Iterable<readonly [string, string]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GLYPH = {
	pi: "π",
	model: "⊙",
	dir: "⌂",
	git: "⑂",
	ctx: "◔",
	guard: "⚑",
	sep: "〉",
} as const;

/** Hard cap on how many extension statuses we ever touch per render (10k-status safety). */
const MAX_STATUS_SCAN = 24;

/**
 * Width degradation happens in two phases: first values are abbreviated (these tiers,
 * widest first), and only when the tightest tier still does not fit are whole segments
 * dropped in DROP_ORDER. After dropping, the widest tier that still fits is restored,
 * so a narrow bar uses the columns it has instead of leaving them empty.
 */
interface Tier {
	model: number;
	branch: number;
	dir: number;
	counters: "full" | "dirty" | "min";
	shorten: 0 | 1 | 2;
}

const TIERS: readonly Tier[] = [
	{ model: 28, branch: 24, dir: 20, counters: "full", shorten: 0 },
	{ model: 18, branch: 16, dir: 14, counters: "full", shorten: 1 },
	{ model: 12, branch: 12, dir: 10, counters: "dirty", shorten: 2 },
	{ model: 10, branch: 10, dir: 8, counters: "min", shorten: 2 },
];

const REFRESH_MS = 5000;
const GIT_TIMEOUT_MS = 3000;
const RENDER_COALESCE_MS = 60;
const EVENT_DEBOUNCE_MS = 300;

const DEFAULT_CONFIG: StatusbarConfig = {
	enabled: true,
	segments: { pi: true, model: true, think: true, project: true, git: true, context: true, extra: true, statuses: true },
};

export const SEGMENT_HELP: Record<SegKey | "statuses", string> = {
	pi: "π branding mark",
	model: "current model id",
	think: "thinking level",
	project: "project directory",
	git: "branch + dirty counters",
	context: "context usage %/window",
	extra: "session cost + guard counters",
	statuses: "extension status line above the bar",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for the test harness)
// ---------------------------------------------------------------------------

/** Strip control characters / escape sequences so untrusted text can never inject ANSI. */
export function sanitize(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Truncate keeping the END of the string (branch names carry their meaning at the tail).
 * Uses pi-tui's column slicer, which is grapheme- and wide-char-aware and streams instead
 * of materialising the whole string (this runs on every frame).
 */
export function truncTail(text: string, cols: number): string {
	if (cols <= 0) return "";
	const w = visibleWidth(text);
	if (w <= cols) return text;
	if (cols === 1) return "…";
	return `…${sliceByColumn(text, w - (cols - 1), cols - 1, true)}`;
}

/** Drop the redundant parts of a model id before truncating it. */
export function shortenModelId(id: string, level: 0 | 1 | 2): string {
	let out = id;
	if (level >= 1) {
		const slash = out.lastIndexOf("/");
		if (slash >= 0 && slash < out.length - 1) out = out.slice(slash + 1);
		out = out.replace(/[-@](\d{6,8}|latest|preview|beta)$/i, "");
	}
	if (level >= 2) out = out.replace(/^(claude|anthropic|models)[-.]/i, "");
	return out || id;
}

export function fmtTokens(count: number): string {
	if (!Number.isFinite(count) || count < 0) return "?";
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function fmtCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost < 0.01) return "$<0.01";
	return `$${cost.toFixed(2)}`;
}

/** `git status --porcelain=v2 --branch` -> counters. Never throws. */
export function parsePorcelainV2(out: string): GitCounts {
	const res: GitCounts = {
		branch: null,
		detached: false,
		oid: null,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicted: 0,
	};
	for (const line of out.split("\n")) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const v = line.slice("# branch.head ".length).trim();
			if (v === "(detached)") res.detached = true;
			else if (v) res.branch = v;
		} else if (line.startsWith("# branch.oid ")) {
			const v = line.slice("# branch.oid ".length).trim();
			if (v && v !== "(initial)") res.oid = v.slice(0, 7);
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const x = line[2];
			const y = line[3];
			if (x && x !== ".") res.staged++;
			if (y && y !== ".") res.modified++;
		} else if (line.startsWith("u ")) {
			res.conflicted++;
		} else if (line.startsWith("? ")) {
			res.untracked++;
		}
	}
	return res;
}

export function emptySnapshot(cwd = process.cwd()): Snapshot {
	return {
		modelId: null,
		provider: null,
		showProvider: false,
		thinking: null,
		projectDir: basename(resolve(cwd)) || cwd,
		branch: null,
		detached: false,
		headOid: null,
		git: null,
		ctxTokens: null,
		ctxWindow: 0,
		ctxPercent: null,
		cost: 0,
	};
}

/**
 * Bounded read of the extension-status map. Never iterates more than MAX_STATUS_SCAN
 * entries and stops sanitizing once enough text exists to fill the line (a misbehaving
 * extension with 10k statuses must not make every frame expensive).
 */
function collectStatuses(
	statuses: RenderArgs["statuses"],
	width: number,
): { texts: string[]; hidden: number; guard: { blocked: number; nudged: number } | null } {
	const texts: string[] = [];
	let guard: { blocked: number; nudged: number } | null = null;
	let seen = 0;
	let total = 0;
	let acc = 0;
	if (statuses) {
		const size = statuses instanceof Map ? statuses.size : undefined;
		for (const entry of statuses as Iterable<readonly [string, string]>) {
			total++;
			if (seen >= MAX_STATUS_SCAN) {
				// Only keep counting when it is free (Map.size); otherwise stop walking.
				if (size === undefined) break;
				total = size;
				break;
			}
			seen++;
			const raw = String(entry?.[1] ?? "");
			if (!guard && (raw.includes("block") || raw.includes("nudg"))) {
				const b = /blocked[=: ]\s*(\d+)/i.exec(raw);
				const n = /nudged[=: ]\s*(\d+)/i.exec(raw);
				if (b || n) guard = { blocked: b ? Number(b[1]) : 0, nudged: n ? Number(n[1]) : 0 };
			}
			if (acc >= width) continue;
			const text = sanitize(raw);
			if (!text) continue;
			texts.push(text);
			acc += text.length + 3;
		}
		if (size !== undefined) total = size;
	}
	return { texts, hidden: Math.max(0, total - texts.length), guard };
}

/** A percentage we are willing to print. Anything else (null, undefined, NaN, ∞) is "unknown". */
function knownPercent(p: unknown): p is number {
	return typeof p === "number" && Number.isFinite(p);
}

function ctxColor(percent: number | null | undefined): "dim" | "warning" | "error" {
	if (!knownPercent(percent)) return "dim";
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "dim";
}

function buildSegments(
	snap: Snapshot,
	cfg: StatusbarConfig,
	theme: ThemeLike,
	guard: { blocked: number; nudged: number } | null,
	tier: Tier,
): Map<SegKey, string> {
	const seg = cfg.segments;
	const out = new Map<SegKey, string>();

	if (seg.pi) out.set("pi", theme.fg("accent", GLYPH.pi));

	if (seg.model) {
		const id = truncateToWidth(shortenModelId(sanitize(snap.modelId ?? "no-model"), tier.shorten), tier.model, "…");
		let text = `${theme.fg("dim", GLYPH.model)} ${theme.fg("muted", id)}`;
		if (snap.showProvider && snap.provider && tier.shorten === 0) {
			text += theme.fg("dim", ` ${truncateToWidth(sanitize(snap.provider), 12, "…")}`);
		}
		out.set("model", text);
	}

	if (seg.think && snap.thinking) {
		out.set("think", theme.fg("dim", "think:") + theme.fg("muted", sanitize(snap.thinking)));
	}

	if (seg.project && snap.projectDir) {
		const dir = truncTail(sanitize(snap.projectDir), tier.dir);
		out.set("project", `${theme.fg("dim", GLYPH.dir)} ${theme.fg("muted", dir)}`);
	}

	if (seg.git && snap.branch) {
		let label = sanitize(snap.branch);
		if (snap.detached || label === "detached") label = snap.headOid ? `detached@${snap.headOid}` : "detached";
		label = truncTail(label, tier.branch);
		let text = `${theme.fg("dim", GLYPH.git)} ${theme.fg("muted", label)}`;
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
		const pct = snap.ctxPercent;
		let value: string;
		if (snap.ctxWindow > 0) {
			// Anything non-finite prints as "?" — a footer must never throw (see renderStatusBar).
			value = `${knownPercent(pct) ? pct.toFixed(1) : "?"}%/${fmtTokens(snap.ctxWindow)}`;
		} else {
			value = snap.ctxTokens !== null ? `${fmtTokens(snap.ctxTokens)}/?` : "?/?";
		}
		out.set("context", `${theme.fg("dim", GLYPH.ctx)} ${theme.fg(ctxColor(pct), value)}`);
	}

	if (seg.extra) {
		const parts: string[] = [];
		if (snap.cost > 0) parts.push(theme.fg("dim", fmtCost(snap.cost)));
		if (guard && (guard.blocked > 0 || guard.nudged > 0)) {
			parts.push(theme.fg("dim", `${GLYPH.guard}${guard.blocked}b/${guard.nudged}n`));
		}
		if (parts.length) out.set("extra", parts.join(" "));
	}

	return out;
}

function closeAnsi(text: string): string {
	return text.includes("\u001b") ? `${text}\u001b[0m` : text;
}

/** Truncate ANSI-aware and guarantee visibleWidth(result) <= width. */
function fit(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = truncateToWidth(text, width, "");
	// Defensive: a wide grapheme at the boundary must never push us over. sliceByColumn's
	// strict mode drops a boundary-straddling wide grapheme instead of splitting it.
	if (visibleWidth(out) > width) out = sliceByColumn(out, 0, width, true);
	return closeAnsi(out);
}

/**
 * Render the bar (plus an optional dim status line above it).
 * Pure: no I/O, no session scans. Returns 0..2 lines, each of visible width <= `width`.
 */
export function renderStatusBar(args: RenderArgs): string[] {
	const { snap, cfg, theme } = args;
	const width = Math.floor(args.width);
	if (!Number.isFinite(width) || width <= 0) return [];

	const { texts, hidden, guard } = collectStatuses(args.statuses, width);
	const lines: string[] = [];

	if (cfg.segments.statuses && texts.length > 0) {
		const joined = texts.join(" · ") + (hidden > 0 ? ` +${hidden} more` : "");
		// Prose reads left to right: keep the head, ellipsise the tail.
		const dimmed = theme.fg("dim", truncateToWidth(joined, width, "…"));
		lines.push(visibleWidth(dimmed) <= width ? dimmed : fit(dimmed, width));
	}

	const sep = theme.fg("dim", ` ${GLYPH.sep} `);
	const built: (Map<SegKey, string> | undefined)[] = [];
	const segsAt = (i: number): Map<SegKey, string> => {
		const cached = built[i];
		if (cached) return cached;
		const fresh = buildSegments(snap, cfg, theme, guard, TIERS[i] as Tier);
		built[i] = fresh;
		return fresh;
	};
	const joinKept = (segs: Map<SegKey, string>, keep: ReadonlySet<SegKey>) =>
		SEGMENT_ORDER.filter((k) => keep.has(k) && segs.has(k))
			.map((k) => segs.get(k) as string)
			.join(sep);

	// Phase 1: widest abbreviation tier that fits with every segment present.
	for (let i = 0; i < TIERS.length; i++) {
		const segs = segsAt(i);
		if (segs.size === 0) return lines;
		const line = joinKept(segs, new Set(segs.keys()));
		if (visibleWidth(line) <= width) {
			lines.push(line);
			return lines;
		}
	}

	// Phase 2: drop segments by priority at the tightest tier.
	const segs = segsAt(TIERS.length - 1);
	const keep = new Set(segs.keys());
	let line = joinKept(segs, keep);
	for (const key of DROP_ORDER) {
		if (visibleWidth(line) <= width) break;
		if (keep.size <= 1) break;
		if (!keep.has(key)) continue;
		keep.delete(key);
		line = joinKept(segs, keep);
	}

	// Phase 3: with the surviving segments, restore the widest tier that still fits.
	for (let i = 0; i < TIERS.length; i++) {
		const relaxed = joinKept(segsAt(i), keep);
		if (visibleWidth(relaxed) <= width) {
			line = relaxed;
			break;
		}
	}

	lines.push(fit(line, width));
	return lines;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export function configPath(): string {
	return join(homedir(), CONFIG_DIR_NAME, "statusbar.json");
}

export function normalizeConfig(raw: unknown): StatusbarConfig {
	const cfg: StatusbarConfig = { enabled: DEFAULT_CONFIG.enabled, segments: { ...DEFAULT_CONFIG.segments } };
	if (!raw || typeof raw !== "object") return cfg;
	const o = raw as Record<string, unknown>;
	if (typeof o.enabled === "boolean") cfg.enabled = o.enabled;
	const segs = o.segments;
	if (segs && typeof segs === "object") {
		for (const key of Object.keys(cfg.segments) as (SegKey | "statuses")[]) {
			const v = (segs as Record<string, unknown>)[key];
			if (typeof v === "boolean") cfg.segments[key] = v;
		}
	}
	return cfg;
}

function loadConfig(): StatusbarConfig {
	try {
		return normalizeConfig(JSON.parse(readFileSync(configPath(), "utf8")));
	} catch {
		return normalizeConfig(undefined);
	}
}

function saveConfig(cfg: StatusbarConfig): void {
	try {
		const p = configPath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		// Persistence is best-effort; a read-only HOME must not break the bar.
	}
}

// ---------------------------------------------------------------------------
// git (never called from render)
// ---------------------------------------------------------------------------

export function runGitStatus(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitCounts | null> {
	return new Promise((res) => {
		try {
			execFile(
				"git",
				["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
				{ cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
				(err, stdout) => res(err ? null : parsePorcelainV2(stdout || "")),
			);
		} catch {
			res(null);
		}
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function statusbar(pi: ExtensionAPI) {
	// Loaded once, eagerly: render() must never touch the filesystem, so the config file is
	// read here (extension load, before any frame) rather than lazily on first render.
	const cfg = loadConfig();
	const snap = emptySnapshot();

	let ctxRef: ExtensionContext | undefined;
	let tuiRef: TUI | undefined;
	let footerDataRef: ReadonlyFooterDataProvider | undefined;

	/** Bumped on every mount/unmount so stale timers and disposals become no-ops. */
	let mountGen = 0;
	let mounted = false;

	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let gitInFlight = false;
	let gitPending = false;

	// -- render coalescing ---------------------------------------------------
	function requestRender(): void {
		if (!tuiRef || renderTimer) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			try {
				tuiRef?.requestRender();
			} catch {
				// TUI may be gone (session replaced / shutting down).
			}
		}, RENDER_COALESCE_MS);
		renderTimer.unref?.();
	}

	function digest(): string {
		return JSON.stringify(snap);
	}

	function readCtx(ctx: ExtensionContext): void {
		try {
			const model = ctx.model as { id?: string; provider?: string; contextWindow?: number; reasoning?: boolean } | undefined;
			snap.modelId = model?.id ?? null;
			snap.provider = model?.provider ?? null;
			snap.thinking = (ctx.thinkingLevel as string | undefined) ?? null;
			snap.projectDir = basename(resolve(ctx.cwd)) || ctx.cwd;
			try {
				snap.showProvider = (footerDataRef?.getAvailableProviderCount?.() ?? 0) > 1;
			} catch {
				snap.showProvider = false;
			}

			// Context usage: pi's own accounting (last assistant usage + trailing estimate).
			let tokens: number | null = null;
			let window = model?.contextWindow ?? 0;
			let percent: number | null = null;
			const usage = ctx.getContextUsage?.();
			if (usage) {
				tokens = usage.tokens;
				window = usage.contextWindow || window;
				// pi's ContextUsage always carries `percent`, but do not depend on that: derive it
				// whenever the field is missing or non-finite instead of poisoning the snapshot.
				percent = knownPercent(usage.percent)
					? usage.percent
					: tokens !== null && tokens !== undefined && window > 0
						? (tokens / window) * 100
						: null;
			} else {
				// Fallback: LAST assistant message only (summing would double-count cache reads).
				const branch = ctx.sessionManager.getBranch();
				for (let i = branch.length - 1; i >= 0; i--) {
					const e = branch[i] as { type?: string; message?: { role?: string; usage?: { totalTokens?: number } } };
					if (e?.type === "message" && e.message?.role === "assistant" && e.message.usage) {
						tokens = e.message.usage.totalTokens ?? null;
						break;
					}
				}
				percent = tokens !== null && window > 0 ? (tokens / window) * 100 : null;
			}
			snap.ctxTokens = tokens;
			snap.ctxWindow = window > 0 ? window : 0;
			snap.ctxPercent = percent;

			// Session cost (cheap enough here; never in render).
			let cost = 0;
			for (const e of ctx.sessionManager.getBranch()) {
				const entry = e as { type?: string; message?: { role?: string; usage?: { cost?: { total?: number } } }; usage?: { cost?: { total?: number } } };
				if (entry?.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) {
					cost += entry.message?.usage?.cost?.total ?? 0;
				} else if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) {
					cost += entry.usage.cost?.total ?? 0;
				}
			}
			snap.cost = cost;
		} catch {
			// Stale ctx: keep the previous snapshot rather than crashing the footer.
		}
	}

	async function refresh(): Promise<void> {
		const ctx = ctxRef;
		if (!ctx || !mounted) return;
		if (gitInFlight) {
			gitPending = true;
			return;
		}
		const before = digest();
		readCtx(ctx);

		try {
			snap.branch = footerDataRef?.getGitBranch?.() ?? snap.branch;
		} catch {
			/* keep previous */
		}

		if (cfg.segments.git && snap.branch) {
			gitInFlight = true;
			const gen = mountGen;
			const counts = await runGitStatus(ctx.cwd);
			gitInFlight = false;
			if (gen !== mountGen) return;
			if (counts) {
				snap.git = {
					staged: counts.staged,
					modified: counts.modified,
					untracked: counts.untracked,
					conflicted: counts.conflicted,
				};
				snap.detached = counts.detached || snap.branch === "detached";
				snap.headOid = counts.oid;
				if (counts.branch) snap.branch = counts.branch;
			} else {
				// git failed/timed out. Keep the provider's branch (it is authoritative for
				// repo-ness: a non-repo reports null and we never get here) and just drop the
				// counters, instead of making the whole segment blink out of existence.
				snap.git = null;
			}
		} else {
			snap.git = null;
		}

		if (digest() !== before) requestRender();
		if (gitPending) {
			gitPending = false;
			scheduleRefresh(EVENT_DEBOUNCE_MS);
		}
	}

	function scheduleRefresh(delay = EVENT_DEBOUNCE_MS): void {
		if (!mounted) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void refresh();
		}, delay);
		debounceTimer.unref?.();
	}

	function startTimer(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
		refreshTimer.unref?.();
	}

	function stopTimers(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		if (debounceTimer) clearTimeout(debounceTimer);
		if (renderTimer) clearTimeout(renderTimer);
		refreshTimer = undefined;
		debounceTimer = undefined;
		renderTimer = undefined;
	}

	function mount(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctxRef = ctx;
		mounted = true;
		const gen = ++mountGen;

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			footerDataRef = footerData;
			snap.branch = footerData.getGitBranch();
			readCtx(ctx);
			startTimer();
			scheduleRefresh(0);

			const unsub = footerData.onBranchChange(() => {
				try {
					snap.branch = footerData.getGitBranch();
				} catch {
					/* ignore */
				}
				scheduleRefresh(50);
				requestRender();
			});

			return {
				render(width: number): string[] {
					// FAIL OPEN. This runs on every frame; an exception here would take the whole
					// TUI down, so a bug in a segment must degrade to a minimal bar, never throw.
					try {
						return renderStatusBar({
							snap,
							cfg,
							theme,
							width,
							statuses: footerData.getExtensionStatuses(),
						});
					} catch {
						try {
							return [truncateToWidth(theme.fg("accent", GLYPH.pi), Math.max(0, width))];
						} catch {
							return [];
						}
					}
				},
				invalidate() {
					// Nothing cached per-theme; pi re-renders after a theme switch.
				},
				dispose() {
					unsub();
					if (gen === mountGen) {
						stopTimers();
						tuiRef = undefined;
						footerDataRef = undefined;
						mounted = false;
					}
				},
			};
		});
	}

	function unmount(ctx: ExtensionContext | undefined): void {
		mountGen++;
		mounted = false;
		stopTimers();
		try {
			if (ctx && ctx.mode === "tui" && ctx.hasUI) ctx.ui.setFooter(undefined);
		} catch {
			/* UI already gone */
		}
		tuiRef = undefined;
		footerDataRef = undefined;
	}

	// -- events --------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		if (ctx.mode !== "tui" || !ctx.hasUI) return; // print/json: register nothing, cost nothing
		if (cfg.enabled) mount(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		mountGen++;
		mounted = false;
		stopTimers();
		tuiRef = undefined;
		footerDataRef = undefined;
		ctxRef = undefined;
	});

	pi.on("model_select", async (event, ctx) => {
		ctxRef = ctx;
		const m = event.model as { id?: string; provider?: string } | undefined;
		snap.modelId = m?.id ?? snap.modelId;
		snap.provider = m?.provider ?? snap.provider;
		requestRender();
		scheduleRefresh(50);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		ctxRef = ctx;
		snap.thinking = (event.level as string | undefined) ?? snap.thinking;
		requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctxRef = ctx;
		scheduleRefresh();
	});
	pi.on("agent_end", async (_event, ctx) => {
		ctxRef = ctx;
		scheduleRefresh();
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		ctxRef = ctx;
		scheduleRefresh();
	});
	pi.on("message_end", async (_event, ctx) => {
		ctxRef = ctx;
		scheduleRefresh();
	});

	// -- command -------------------------------------------------------------

	const SEG_KEYS = Object.keys(DEFAULT_CONFIG.segments) as (SegKey | "statuses")[];

	function stateLine(): string {
		const on = SEG_KEYS.filter((k) => cfg.segments[k]);
		return `statusbar ${cfg.enabled ? "on" : "off"} — segments: ${on.join(", ") || "(none)"}`;
	}

	async function pickSegments(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		for (;;) {
			const items = SEG_KEYS.map((k) => `[${cfg.segments[k] ? "x" : " "}] ${k} — ${SEGMENT_HELP[k]}`);
			const choice = await ctx.ui.select("statusbar segments (Esc to finish)", [...items, "done"]);
			if (!choice || choice === "done") break;
			const key = SEG_KEYS.find((k) => choice.includes(`] ${k} —`));
			if (!key) break;
			cfg.segments[key] = !cfg.segments[key];
			saveConfig(cfg);
			if (key === "git") scheduleRefresh(0);
			requestRender();
		}
		ctx.ui.notify(stateLine(), "info");
	}

	pi.registerCommand("statusbar", {
		description: "Toggle the segmented status bar (on|off|segments|<segment>|status)",
		getArgumentCompletions: (prefix: string) => {
			const opts = ["on", "off", "segments", "status", ...SEG_KEYS];
			const items = opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const arg = (args || "").trim().toLowerCase();

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				// No footer to replace outside the TUI; persist intent only.
				if (arg === "on" || arg === "off") {
					cfg.enabled = arg === "on";
					saveConfig(cfg);
				}
				return;
			}

			if (arg === "status") {
				ctx.ui.notify(stateLine(), "info");
				return;
			}
			if (arg === "segments") {
				await pickSegments(ctx);
				return;
			}
			if (SEG_KEYS.includes(arg as SegKey | "statuses")) {
				const key = arg as SegKey | "statuses";
				cfg.segments[key] = !cfg.segments[key];
				saveConfig(cfg);
				if (key === "git") scheduleRefresh(0);
				requestRender();
				ctx.ui.notify(`statusbar segment ${key}: ${cfg.segments[key] ? "on" : "off"}`, "info");
				return;
			}

			const next = arg === "on" ? true : arg === "off" ? false : !cfg.enabled;
			if (next === cfg.enabled && arg !== "") {
				ctx.ui.notify(stateLine(), "info");
				return;
			}
			cfg.enabled = next;
			saveConfig(cfg);
			if (cfg.enabled) {
				mount(ctx);
				ctx.ui.notify("statusbar enabled", "info");
			} else {
				unmount(ctx);
				ctx.ui.notify("statusbar disabled (built-in footer restored)", "info");
			}
		},
	});
}
