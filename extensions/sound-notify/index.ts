/**
 * sound-notify — audible notification when Pi actually needs the human.
 *
 * Rings exactly three kinds of sound, never during ordinary agent work:
 *
 *   ask   -> an extension opened a blocking dialog (`ui_prompt_start`):
 *            confirm / select / input / editor / custom. The agent is frozen
 *            until you answer.
 *   done  -> the agent run fully settled (`agent_settled`): no retry, no
 *            auto-compaction, no queued follow-up left. Pi is waiting for you.
 *   error -> the run settled after the model/provider failed
 *            (last assistant message `stopReason === "error"`).
 *
 * Design invariants:
 *   1. Never blocks the agent: playback is a detached, unref'd child process
 *      with stdio ignored; handlers do no I/O beyond one optional log append
 *      and return synchronously.
 *   2. Never spams: one sound per settle (not per turn / per tool call), a
 *      per-kind cooldown, no sound for user-aborted (Esc) runs, no sound when
 *      follow-up messages are already queued, and by default only in modes
 *      where a human is actually attached (tui, rpc) — so `-p`/`--mode json`
 *      runs and subagent child processes stay silent.
 *   3. Never crashes the host: a missing/broken player emits a `spawn` error
 *      event (which would be an uncaught exception if unhandled), so that is
 *      caught, latched, and degraded to the terminal bell.
 *   4. Registers no tool: zero tokens of prompt footprint per turn.
 *
 * Everything above the "extension wiring" section is pure and unit-tested.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SoundKind = "ask" | "done" | "error";

export const SOUND_KINDS: readonly SoundKind[] = ["ask", "done", "error"];

export interface SoundConfig {
	/** Master switch (PI_SOUND_NOTIFY). */
	enabled: boolean;
	/** Per-kind switch (PI_SOUND_EVENTS). */
	kinds: Record<SoundKind, boolean>;
	/** Raw sound name or path per kind (PI_SOUND_ASK/DONE/ERROR). */
	names: Record<SoundKind, string>;
	/** afplay -v value, or null for the player default (PI_SOUND_VOLUME). */
	volume: number | null;
	/** Per-kind minimum gap between sounds (PI_SOUND_COOLDOWN_MS). */
	cooldownMs: number;
	/** "done" is skipped for runs shorter than this (PI_SOUND_MIN_TURN_MS). */
	minTurnMs: number;
	/** Modes a human is assumed to be watching (PI_SOUND_MODES). */
	modes: Set<string> | "all";
	/** Full player command override (PI_SOUND_PLAYER), argv-split. */
	playerOverride: string[] | null;
	/** Allow the terminal-bell fallback when no audio player exists. */
	bell: boolean;
	/** Decision log path, or null when disabled (PI_SOUND_DEBUG). */
	debugPath: string | null;
}

export interface DecideInput {
	kind: SoundKind;
	/** Date.now() */
	now: number;
	/** ctx.mode: "tui" | "rpc" | "json" | "print" */
	mode: string;
	/** runtime /sound off */
	muted: boolean;
	/** Duration of the finished run, for the min-turn filter. */
	runMs?: number | null;
	/** The run ended because the user hit Esc — the human is obviously present. */
	aborted?: boolean;
	/** Follow-up messages are queued: Pi is not really waiting for input. */
	busy?: boolean;
}

export interface Decision {
	play: boolean;
	/** Machine-readable reason, mirrored into the debug log. */
	reason: string;
}

/** Per-kind timestamps of the last actual playback. */
export type LastPlayedAt = Record<SoundKind, number>;

export type PlayPlan =
	| { kind: "spawn"; command: string; args: string[] }
	| { kind: "bell" }
	| { kind: "none"; reason: string };

export interface PlanProbes {
	exists(path: string): boolean;
	hasCommand(cmd: string): boolean;
}

// ---------------------------------------------------------------------------
// Config parsing (pure)
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(["1", "true", "on", "yes", "y", "enable", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no", "n", "disable", "disabled", "none", ""]);

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	const v = raw.trim().toLowerCase();
	if (TRUE_VALUES.has(v)) return true;
	if (FALSE_VALUES.has(v)) return false;
	return fallback;
}

function parseInt_(raw: string | undefined, fallback: number, min = 0): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(n) || n < min) return fallback;
	return n;
}

/** Defaults chosen so the three kinds are instantly distinguishable by ear. */
export const DEFAULT_NAMES: Record<SoundKind, string> = {
	ask: "Ping",
	done: "Glass",
	error: "Basso",
};

export function parseConfig(env: Record<string, string | undefined>): SoundConfig {
	const kinds: Record<SoundKind, boolean> = { ask: true, done: true, error: true };
	const rawEvents = env.PI_SOUND_EVENTS?.trim();
	if (rawEvents) {
		const lower = rawEvents.toLowerCase();
		if (lower === "all") {
			// keep all enabled
		} else if (FALSE_VALUES.has(lower)) {
			kinds.ask = kinds.done = kinds.error = false;
		} else {
			const wanted = new Set(
				lower
					.split(/[,\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
			);
			for (const k of SOUND_KINDS) kinds[k] = wanted.has(k);
		}
	}

	const rawVolume = env.PI_SOUND_VOLUME?.trim();
	let volume: number | null = null;
	if (rawVolume) {
		const n = Number.parseFloat(rawVolume);
		if (Number.isFinite(n) && n >= 0) volume = n;
	}

	let modes: Set<string> | "all";
	const rawModes = env.PI_SOUND_MODES?.trim().toLowerCase();
	if (!rawModes) modes = new Set(["tui", "rpc"]);
	else if (rawModes === "all" || rawModes === "*") modes = "all";
	else
		modes = new Set(
			rawModes
				.split(/[,\s]+/)
				.map((s) => s.trim())
				.filter(Boolean),
		);

	const rawPlayer = env.PI_SOUND_PLAYER?.trim();
	const playerOverride =
		rawPlayer && rawPlayer.length > 0 ? rawPlayer.split(/\s+/).filter(Boolean) : null;

	let debugPath: string | null = null;
	const rawDebug = env.PI_SOUND_DEBUG?.trim();
	if (rawDebug) {
		if (TRUE_VALUES.has(rawDebug.toLowerCase())) debugPath = join(tmpdir(), "pi-sound-notify.log");
		else if (!FALSE_VALUES.has(rawDebug.toLowerCase())) debugPath = rawDebug;
	}

	return {
		enabled: parseBool(env.PI_SOUND_NOTIFY, true),
		kinds,
		names: {
			ask: env.PI_SOUND_ASK?.trim() || DEFAULT_NAMES.ask,
			done: env.PI_SOUND_DONE?.trim() || DEFAULT_NAMES.done,
			error: env.PI_SOUND_ERROR?.trim() || DEFAULT_NAMES.error,
		},
		volume,
		cooldownMs: parseInt_(env.PI_SOUND_COOLDOWN_MS, 1200),
		minTurnMs: parseInt_(env.PI_SOUND_MIN_TURN_MS, 0),
		modes,
		playerOverride,
		bell: parseBool(env.PI_SOUND_BELL, true),
		debugPath,
	};
}

// ---------------------------------------------------------------------------
// Decision engine (pure) — the whole anti-spam policy lives here
// ---------------------------------------------------------------------------

/**
 * Process-wide playback clock.
 *
 * Deliberately shared through globalThis: the same extension file can be loaded
 * twice in one pi process (`-e ./x.ts` while an installed copy auto-discovers, or
 * two sessions in one SDK host). Both instances then see the same `agent_settled`
 * and each would ring — empirically reproduced as a double sound. Sharing the
 * cooldown clock collapses those duplicates into one audible notification
 * without any ownership handshake between instances.
 */
const CLOCK_KEY = "__piSoundNotifyClockV1";

/** Minimum gap between two identical sounds, even when the cooldown is disabled. */
export const DEDUPE_FLOOR_MS = 250;

export function processClock(): LastPlayedAt {
	const g = globalThis as unknown as Record<string, LastPlayedAt | undefined>;
	const existing = g[CLOCK_KEY];
	if (existing) return existing;
	const fresh: LastPlayedAt = { ask: 0, done: 0, error: 0 };
	g[CLOCK_KEY] = fresh;
	return fresh;
}

export function decide(cfg: SoundConfig, lastPlayedAt: LastPlayedAt, i: DecideInput): Decision {
	if (!cfg.enabled) return { play: false, reason: "off:env" };
	if (i.muted) return { play: false, reason: "off:muted" };
	if (cfg.modes !== "all" && !cfg.modes.has(i.mode)) return { play: false, reason: `off:mode(${i.mode})` };
	if (!cfg.kinds[i.kind]) return { play: false, reason: `off:kind(${i.kind})` };
	// Esc-aborted run: the human is at the keyboard by definition.
	if (i.aborted && i.kind !== "ask") return { play: false, reason: "off:aborted" };
	// Queued follow-ups mean Pi keeps working; only "ask" truly blocks now.
	if (i.busy && i.kind !== "ask") return { play: false, reason: "off:busy" };
	if (i.kind === "done" && cfg.minTurnMs > 0 && i.runMs != null && i.runMs < cfg.minTurnMs)
		return { play: false, reason: `off:fast-turn(${i.runMs}ms)` };
	const last = lastPlayedAt[i.kind] ?? 0;
	if (last > 0) {
		const gap = i.now - last;
		if (gap < cfg.cooldownMs) return { play: false, reason: "off:cooldown" };
		// Hard floor: even with PI_SOUND_COOLDOWN_MS=0, two instances of this
		// extension in one process must not double-ring the same notification.
		if (gap < DEDUPE_FLOOR_MS) return { play: false, reason: "off:duplicate" };
	}
	return { play: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Player resolution (pure, given probes)
// ---------------------------------------------------------------------------

export function commandExists(cmd: string, pathEnv: string | undefined, exists: (p: string) => boolean): boolean {
	if (cmd.includes("/") || cmd.includes("\\")) return exists(cmd);
	for (const dir of (pathEnv ?? "").split(delimiter)) {
		if (dir && exists(join(dir, cmd))) return true;
	}
	return false;
}

const MAC_SOUND_DIRS = ["/System/Library/Sounds", "/Library/Sounds"];

/** Resolve a user-supplied sound name/path to a real file, or null. */
export function resolveMacSound(name: string, exists: (p: string) => boolean): string | null {
	if (isAbsolute(name) || name.includes("/")) return exists(name) ? name : null;
	for (const dir of MAC_SOUND_DIRS) {
		const p = join(dir, name.endsWith(".aiff") ? name : `${name}.aiff`);
		if (exists(p)) return p;
	}
	return null;
}

/** freedesktop sound theme files, by kind, most specific first. */
const LINUX_FILES: Record<SoundKind, string[]> = {
	ask: ["message.oga", "dialog-information.oga", "message-new-instant.oga", "bell.oga"],
	done: ["complete.oga", "bell.oga", "message.oga"],
	error: ["dialog-error.oga", "dialog-warning.oga", "bell.oga"],
};
const LINUX_SOUND_DIRS = [
	"/usr/share/sounds/freedesktop/stereo",
	"/usr/share/sounds/gnome/default/alerts",
	"/usr/share/sounds/ubuntu/stereo",
];
/** canberra event ids need no file at all. */
const CANBERRA_IDS: Record<SoundKind, string> = {
	ask: "message-new-instant",
	done: "complete",
	error: "dialog-error",
};
/** Windows: distinct machine-speaker beeps, file-independent. */
const WIN_BEEP: Record<SoundKind, [number, number]> = {
	ask: [1046, 160],
	done: [784, 200],
	error: [330, 320],
};

function withVolume(cfg: SoundConfig, args: string[]): string[] {
	return cfg.volume == null ? args : ["-v", String(cfg.volume), ...args];
}

/**
 * Build the exact child process to run for `kind`, or a bell/none fallback.
 * Pure: all filesystem/PATH knowledge comes in through `probes`.
 */
export function resolvePlan(
	cfg: SoundConfig,
	kind: SoundKind,
	platform: string,
	env: Record<string, string | undefined>,
	probes: PlanProbes,
): PlayPlan {
	const name = cfg.names[kind];

	// 1. Explicit override wins on every platform.
	if (cfg.playerOverride) {
		const [command, ...rest] = cfg.playerOverride;
		if (!command) return bellOr(cfg, "override-empty");
		const file =
			platform === "darwin" ? (resolveMacSound(name, probes.exists) ?? name) : resolveLinuxFile(kind, name, probes) ?? name;
		const args = rest.some((a) => a.includes("{file}"))
			? rest.map((a) => a.replace("{file}", file).replace("{kind}", kind))
			: [...rest.map((a) => a.replace("{kind}", kind)), file];
		return { kind: "spawn", command, args };
	}

	if (platform === "darwin") {
		if (!probes.hasCommand("afplay")) return bellOr(cfg, "no-afplay");
		const file = resolveMacSound(name, probes.exists) ?? resolveMacSound(DEFAULT_NAMES[kind], probes.exists);
		if (!file) return bellOr(cfg, "no-sound-file");
		return { kind: "spawn", command: "afplay", args: withVolume(cfg, [file]) };
	}

	if (platform === "win32") {
		const [freq, ms] = WIN_BEEP[kind];
		const ps = probes.hasCommand("powershell.exe")
			? "powershell.exe"
			: probes.hasCommand("pwsh.exe")
				? "pwsh.exe"
				: null;
		if (!ps) return bellOr(cfg, "no-powershell");
		const custom = name !== DEFAULT_NAMES[kind] && probes.exists(name);
		const script = custom
			? `(New-Object Media.SoundPlayer '${name.replace(/'/g, "''")}').PlaySync()`
			: `[console]::beep(${freq},${ms})`;
		return { kind: "spawn", command: ps, args: ["-NoProfile", "-NonInteractive", "-Command", script] };
	}

	// linux / bsd / anything else with a POSIX-ish sound stack
	const file = resolveLinuxFile(kind, name, probes);
	for (const cmd of ["paplay", "pw-play", "play"]) {
		if (file && probes.hasCommand(cmd)) {
			const args = cmd === "play" ? ["-q", file] : [file];
			return { kind: "spawn", command: cmd, args };
		}
	}
	if (probes.hasCommand("canberra-gtk-play"))
		return { kind: "spawn", command: "canberra-gtk-play", args: ["-i", CANBERRA_IDS[kind]] };
	if (file && file.endsWith(".wav") && probes.hasCommand("aplay"))
		return { kind: "spawn", command: "aplay", args: ["-q", file] };
	return bellOr(cfg, file ? "no-player" : "no-sound-file");
}

function resolveLinuxFile(kind: SoundKind, name: string, probes: PlanProbes): string | null {
	// A user-provided path (or a name that is not one of our defaults) is tried first.
	if (name.includes("/")) return probes.exists(name) ? name : null;
	const candidates: string[] = [];
	if (name !== DEFAULT_NAMES[kind]) {
		for (const dir of LINUX_SOUND_DIRS) {
			candidates.push(join(dir, name.includes(".") ? name : `${name}.oga`));
			candidates.push(join(dir, `${name}.wav`));
		}
	}
	for (const f of LINUX_FILES[kind]) for (const dir of LINUX_SOUND_DIRS) candidates.push(join(dir, f));
	for (const c of candidates) if (probes.exists(c)) return c;
	return null;
}

function bellOr(cfg: SoundConfig, reason: string): PlayPlan {
	return cfg.bell ? { kind: "bell" } : { kind: "none", reason };
}

/**
 * Human-facing warning when playback is running on a degraded path, or null when
 * real audio is available. The degradation is deliberately surfaced (session_start
 * notify + `/sound status` + `plan=` in the debug log) instead of silently
 * pretending to work.
 */
export function degradedWarning(plan: PlayPlan, platform: string): string | null {
	if (plan.kind === "spawn") return null;
	const how =
		plan.kind === "bell"
			? "falling back to the terminal bell"
			: `staying silent (${plan.reason}, PI_SOUND_BELL=0)`;
	const hint =
		platform === "linux"
			? " Install pulseaudio-utils/pipewire (paplay/pw-play) or libcanberra, or set PI_SOUND_PLAYER."
			: " Set PI_SOUND_PLAYER to a command that can play a sound file.";
	return `sound-notify: no audio player found, ${how}.${hint}`;
}

/** One-line human/machine readable description of a plan, for logs and /sound status. */
export function describePlan(plan: PlayPlan): string {
	if (plan.kind === "spawn") return `${plan.command} ${plan.args.join(" ")}`.trim();
	if (plan.kind === "bell") return "terminal-bell";
	return `disabled(${plan.reason})`;
}

// ---------------------------------------------------------------------------
// Error classification from an agent_end payload (pure)
// ---------------------------------------------------------------------------

export interface RunOutcome {
	/** The provider/model failed: ring the error sound instead of done. */
	failed: boolean;
	/** The user aborted (Esc): stay silent. */
	aborted: boolean;
	/** First error message seen, for the log/notify. */
	message?: string;
}

export function classifyMessages(messages: unknown): RunOutcome {
	const out: RunOutcome = { failed: false, aborted: false };
	if (!Array.isArray(messages)) return out;
	for (let idx = messages.length - 1; idx >= 0; idx--) {
		const m = messages[idx] as { role?: string; stopReason?: string; errorMessage?: string } | null;
		if (!m || m.role !== "assistant") continue;
		if (m.stopReason === "error") {
			out.failed = true;
			out.message = m.errorMessage;
		} else if (m.stopReason === "aborted") {
			out.aborted = true;
			out.message = m.errorMessage;
		}
		return out; // only the last assistant message decides
	}
	return out;
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function soundNotify(pi: ExtensionAPI) {
	// Config is read once per extension load (per session: /reload re-reads it).
	let cfg = parseConfig(process.env);
	let muted = false;
	let torndown = false;

	// Shared with any other instance of this extension in the same process.
	const lastPlayedAt = processClock();
	/** Cached plan per kind; invalidated when the player turns out to be broken. */
	const planCache = new Map<SoundKind, PlayPlan>();
	/** Latched after a spawn ENOENT/EACCES: never try that player again this session. */
	let playerBroken: string | null = null;
	let notifiedBroken = false;

	let runStartedAt: number | null = null;
	let outcome: RunOutcome = { failed: false, aborted: false };

	const probes: PlanProbes = {
		exists: (p) => {
			try {
				return existsSync(p);
			} catch {
				return false;
			}
		},
		hasCommand: (c) => commandExists(c, process.env.PATH, probes.exists),
	};

	function log(line: string): void {
		if (!cfg.debugPath) return;
		try {
			appendFileSync(cfg.debugPath, `${new Date().toISOString()} ${line}\n`);
		} catch {
			/* logging must never break a session */
		}
	}

	function planFor(kind: SoundKind): PlayPlan {
		const cached = planCache.get(kind);
		if (cached) return cached;
		const plan = playerBroken ? bellOr(cfg, `broken(${playerBroken})`) : resolvePlan(cfg, kind, process.platform, process.env, probes);
		planCache.set(kind, plan);
		return plan;
	}

	function bell(): void {
		try {
			if (process.stdout.isTTY) process.stdout.write("\u0007");
		} catch {
			/* ignore */
		}
	}

	/** Fire-and-forget playback. Returns the plan actually used, for logging. */
	function emit(kind: SoundKind, ctx?: ExtensionContext): PlayPlan {
		const plan = planFor(kind);
		if (plan.kind === "bell") {
			bell();
			return plan;
		}
		if (plan.kind === "none") return plan;
		try {
			const child = spawn(plan.command, plan.args, { stdio: "ignore", detached: true });
			// An unhandled 'error' event on a spawned child throws in the host process.
			child.on("error", (err: NodeJS.ErrnoException) => {
				playerBroken = err.code ?? err.message;
				planCache.clear();
				log(`player-failed kind=${kind} cmd=${plan.command} code=${playerBroken}`);
				bell();
				if (!notifiedBroken && !torndown && ctx?.hasUI) {
					notifiedBroken = true;
					try {
						ctx.ui.notify(
							`sound-notify: cannot run "${plan.command}" (${playerBroken}); falling back to the terminal bell. Set PI_SOUND_PLAYER or PI_SOUND_NOTIFY=0.`,
							"warning",
						);
					} catch {
						/* UI may be gone */
					}
				}
			});
			child.unref();
		} catch (err) {
			playerBroken = (err as Error)?.message ?? "spawn-threw";
			planCache.clear();
			log(`player-threw kind=${kind} cmd=${plan.command} err=${playerBroken}`);
			bell();
		}
		return plan;
	}

	function ring(kind: SoundKind, ctx: ExtensionContext, extra: Partial<DecideInput> = {}): void {
		const t0 = Date.now();
		let busy = false;
		try {
			busy = ctx.hasPendingMessages();
		} catch {
			/* not available in every context */
		}
		const input: DecideInput = { kind, now: t0, mode: ctx.mode, muted, busy, ...extra };
		const d = decide(cfg, lastPlayedAt, input);
		let planStr = "-";
		if (d.play) {
			lastPlayedAt[kind] = t0;
			planStr = describePlan(emit(kind, ctx));
		}
		log(
			`kind=${kind} play=${d.play ? 1 : 0} reason=${d.reason} mode=${ctx.mode} ` +
				`runMs=${extra.runMs ?? "-"} busy=${busy ? 1 : 0} plan=${planStr} handlerMs=${Date.now() - t0}`,
		);
	}

	// -- lifecycle ------------------------------------------------------------

	pi.on("session_start", (_event, _ctx) => {
		torndown = false;
		cfg = parseConfig(process.env);
		planCache.clear();
		playerBroken = null;
		notifiedBroken = false;
		runStartedAt = null;
		outcome = { failed: false, aborted: false };
		const plan = planFor("done");
		log(
			`session_start mode=${_ctx.mode} enabled=${cfg.enabled} ` +
				`modes=${cfg.modes === "all" ? "all" : [...cfg.modes].join("+")} plan=${describePlan(plan)}`,
		);
		// Make a degraded audio path visible instead of looking silently broken.
		const warning = degradedWarning(plan, process.platform);
		if (warning && cfg.enabled && _ctx.hasUI && (cfg.modes === "all" || cfg.modes.has(_ctx.mode))) {
			try {
				_ctx.ui.notify(warning, "warning");
			} catch {
				/* never break startup over a notification */
			}
		}
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		torndown = true;
		// No timers/watchers are held; detached players are already unref'd.
		runStartedAt = null;
	});

	pi.on("agent_start", (_event, _ctx) => {
		if (runStartedAt == null) runStartedAt = Date.now();
		outcome = { failed: false, aborted: false };
	});

	pi.on("agent_end", (event, _ctx) => {
		outcome = classifyMessages((event as { messages?: unknown }).messages);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const runMs = runStartedAt == null ? null : Date.now() - runStartedAt;
		runStartedAt = null;
		const failed = outcome.failed;
		const aborted = outcome.aborted;
		outcome = { failed: false, aborted: false };
		if (failed) {
			ring("error", ctx, { runMs });
			return;
		}
		ring("done", ctx, { runMs, aborted });
	});

	// Any blocking extension dialog (confirm/select/input/editor/custom).
	pi.on("ui_prompt_start", (event, ctx) => {
		ring("ask", ctx, {});
		log(`ask-detail kind=${event.kind} title=${event.title ?? "-"}`);
	});

	// -- /sound command -------------------------------------------------------

	pi.registerCommand("sound", {
		description: "Audio notifications: /sound [status|on|off|test [ask|done|error]]",
		getArgumentCompletions: (prefix) =>
			["status", "on", "off", "test", "test ask", "test done", "test error"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [verb = "status", arg] = args.trim().split(/\s+/);
			if (verb === "on" || verb === "off") {
				muted = verb === "off";
				ctx.ui.notify(`sound-notify: ${muted ? "muted" : "unmuted"} for this session`, "info");
				log(`command muted=${muted ? 1 : 0}`);
				return;
			}
			if (verb === "test") {
				const kinds = arg && (SOUND_KINDS as readonly string[]).includes(arg) ? [arg as SoundKind] : SOUND_KINDS;
				const lines: string[] = [];
				for (const k of kinds) {
					const plan = emit(k, ctx);
					lines.push(`${k}: ${describePlan(plan)}`);
					await new Promise((r) => setTimeout(r, 700));
				}
				ctx.ui.notify(`sound-notify test\n${lines.join("\n")}`, "info");
				return;
			}
			const enabledKinds = SOUND_KINDS.filter((k) => cfg.kinds[k]).join(",") || "none";
			ctx.ui.notify(
				[
					`sound-notify: ${cfg.enabled ? (muted ? "muted (/sound on)" : "active") : "disabled (PI_SOUND_NOTIFY)"}`,
					`events: ${enabledKinds}`,
					`modes: ${cfg.modes === "all" ? "all" : [...cfg.modes].join(",")} (current: ${ctx.mode})`,
					`cooldown: ${cfg.cooldownMs}ms, minTurn: ${cfg.minTurnMs}ms`,
					...SOUND_KINDS.map((k) => `${k}: ${describePlan(planFor(k))}`),
					cfg.debugPath ? `log: ${cfg.debugPath}` : "log: off (PI_SOUND_DEBUG=1)",
				].join("\n"),
				"info",
			);
		},
	});
}
