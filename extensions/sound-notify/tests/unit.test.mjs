// Unit tests for sound-notify's pure core (config, policy, player resolution,
// outcome classification). Node >= 22.6 strips the TS types natively.
//   node --test extensions/sound-notify/tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_NAMES,
	SOUND_KINDS,
	classifyMessages,
	commandExists,
	decide,
	describePlan,
	parseBool,
	parseConfig,
	resolveMacSound,
	resolvePlan,
} from "../index.ts";

const NO_ENV = {};
const fresh = () => ({ ask: 0, done: 0, error: 0 });

const probesFor = (files, cmds) => ({
	exists: (p) => files.has(p),
	hasCommand: (c) => cmds.has(c),
});

const MAC_FILES = new Set([
	"/usr/bin/afplay",
	"/System/Library/Sounds/Ping.aiff",
	"/System/Library/Sounds/Glass.aiff",
	"/System/Library/Sounds/Basso.aiff",
	"/System/Library/Sounds/Hero.aiff",
]);

// ---------------------------------------------------------------- config

test("parseBool accepts the usual spellings and falls back on garbage", () => {
	for (const v of ["1", "true", "ON", "yes", "y"]) assert.equal(parseBool(v, false), true, v);
	for (const v of ["0", "false", "off", "no", "", "disabled"]) assert.equal(parseBool(v, true), false, v);
	assert.equal(parseBool("banana", true), true);
	assert.equal(parseBool(undefined, false), false);
});

test("default config: all kinds, tui+rpc only, bell allowed, no debug log", () => {
	const cfg = parseConfig(NO_ENV);
	assert.equal(cfg.enabled, true);
	assert.deepEqual(cfg.kinds, { ask: true, done: true, error: true });
	assert.deepEqual(cfg.names, DEFAULT_NAMES);
	assert.equal(cfg.volume, null);
	assert.equal(cfg.cooldownMs, 1200);
	assert.equal(cfg.minTurnMs, 0);
	assert.deepEqual([...cfg.modes].sort(), ["rpc", "tui"]);
	assert.equal(cfg.playerOverride, null);
	assert.equal(cfg.bell, true);
	assert.equal(cfg.debugPath, null);
});

test("env vars drive every knob", () => {
	const cfg = parseConfig({
		PI_SOUND_NOTIFY: "off",
		PI_SOUND_EVENTS: "ask, error",
		PI_SOUND_ASK: "Hero",
		PI_SOUND_DONE: "/tmp/x.aiff",
		PI_SOUND_VOLUME: "0.4",
		PI_SOUND_COOLDOWN_MS: "50",
		PI_SOUND_MIN_TURN_MS: "5000",
		PI_SOUND_MODES: "ALL",
		PI_SOUND_PLAYER: "mpv --really-quiet {file}",
		PI_SOUND_BELL: "0",
		PI_SOUND_DEBUG: "/tmp/snd.log",
	});
	assert.equal(cfg.enabled, false);
	assert.deepEqual(cfg.kinds, { ask: true, done: false, error: true });
	assert.equal(cfg.names.ask, "Hero");
	assert.equal(cfg.names.done, "/tmp/x.aiff");
	assert.equal(cfg.names.error, DEFAULT_NAMES.error);
	assert.equal(cfg.volume, 0.4);
	assert.equal(cfg.cooldownMs, 50);
	assert.equal(cfg.minTurnMs, 5000);
	assert.equal(cfg.modes, "all");
	assert.deepEqual(cfg.playerOverride, ["mpv", "--really-quiet", "{file}"]);
	assert.equal(cfg.bell, false);
	assert.equal(cfg.debugPath, "/tmp/snd.log");
});

test("PI_SOUND_EVENTS=none silences every kind; bad numbers keep defaults", () => {
	assert.deepEqual(parseConfig({ PI_SOUND_EVENTS: "none" }).kinds, { ask: false, done: false, error: false });
	const cfg = parseConfig({ PI_SOUND_COOLDOWN_MS: "abc", PI_SOUND_MIN_TURN_MS: "-5", PI_SOUND_VOLUME: "nope" });
	assert.equal(cfg.cooldownMs, 1200);
	assert.equal(cfg.minTurnMs, 0);
	assert.equal(cfg.volume, null);
});

test("PI_SOUND_DEBUG=1 lands in tmpdir; =0 stays off", () => {
	assert.match(parseConfig({ PI_SOUND_DEBUG: "1" }).debugPath, /pi-sound-notify\.log$/);
	assert.equal(parseConfig({ PI_SOUND_DEBUG: "0" }).debugPath, null);
});

// ---------------------------------------------------------------- policy

test("happy path: every kind rings in an allowed mode", () => {
	const cfg = parseConfig(NO_ENV);
	for (const kind of SOUND_KINDS) {
		const d = decide(cfg, fresh(), { kind, now: 1000, mode: "tui", muted: false });
		assert.deepEqual(d, { play: true, reason: "ok" }, kind);
	}
});

test("silent in non-interactive modes (print/json = subagents, -p runs)", () => {
	const cfg = parseConfig(NO_ENV);
	for (const mode of ["json", "print"]) {
		const d = decide(cfg, fresh(), { kind: "done", now: 1, mode, muted: false });
		assert.equal(d.play, false);
		assert.equal(d.reason, `off:mode(${mode})`);
	}
	assert.equal(decide(cfg, fresh(), { kind: "done", now: 1, mode: "rpc", muted: false }).play, true);
	const all = parseConfig({ PI_SOUND_MODES: "all" });
	assert.equal(decide(all, fresh(), { kind: "done", now: 1, mode: "json", muted: false }).play, true);
});

test("master switch, mute and per-kind switch each block, in that priority", () => {
	assert.equal(decide(parseConfig({ PI_SOUND_NOTIFY: "0" }), fresh(), { kind: "ask", now: 1, mode: "tui", muted: false }).reason, "off:env");
	assert.equal(decide(parseConfig(NO_ENV), fresh(), { kind: "ask", now: 1, mode: "tui", muted: true }).reason, "off:muted");
	assert.equal(
		decide(parseConfig({ PI_SOUND_EVENTS: "ask" }), fresh(), { kind: "done", now: 1, mode: "tui", muted: false }).reason,
		"off:kind(done)",
	);
});

test("Esc-aborted runs stay silent, but a dialog still rings", () => {
	const cfg = parseConfig(NO_ENV);
	assert.equal(decide(cfg, fresh(), { kind: "done", now: 1, mode: "tui", muted: false, aborted: true }).reason, "off:aborted");
	assert.equal(decide(cfg, fresh(), { kind: "error", now: 1, mode: "tui", muted: false, aborted: true }).reason, "off:aborted");
	assert.equal(decide(cfg, fresh(), { kind: "ask", now: 1, mode: "tui", muted: false, aborted: true }).play, true);
});

test("queued follow-ups suppress done/error but never ask", () => {
	const cfg = parseConfig(NO_ENV);
	assert.equal(decide(cfg, fresh(), { kind: "done", now: 1, mode: "tui", muted: false, busy: true }).reason, "off:busy");
	assert.equal(decide(cfg, fresh(), { kind: "ask", now: 1, mode: "tui", muted: false, busy: true }).play, true);
});

test("min-turn filter only applies to done, and only when configured", () => {
	const cfg = parseConfig({ PI_SOUND_MIN_TURN_MS: "10000" });
	assert.match(decide(cfg, fresh(), { kind: "done", now: 1, mode: "tui", muted: false, runMs: 900 }).reason, /^off:fast-turn/);
	assert.equal(decide(cfg, fresh(), { kind: "done", now: 1, mode: "tui", muted: false, runMs: 99999 }).play, true);
	assert.equal(decide(cfg, fresh(), { kind: "done", now: 1, mode: "tui", muted: false, runMs: null }).play, true);
	assert.equal(decide(cfg, fresh(), { kind: "error", now: 1, mode: "tui", muted: false, runMs: 10 }).play, true);
	// default config never filters by duration
	assert.equal(decide(parseConfig(NO_ENV), fresh(), { kind: "done", now: 1, mode: "tui", muted: false, runMs: 1 }).play, true);
});

test("cooldown is per kind and does not cross-block", () => {
	const cfg = parseConfig(NO_ENV); // 1200ms
	const state = { ask: 10_000, done: 0, error: 0 };
	assert.equal(decide(cfg, state, { kind: "ask", now: 10_500, mode: "tui", muted: false }).reason, "off:cooldown");
	assert.equal(decide(cfg, state, { kind: "ask", now: 11_300, mode: "tui", muted: false }).play, true);
	assert.equal(decide(cfg, state, { kind: "done", now: 10_500, mode: "tui", muted: false }).play, true);
});

// ------------------------------------------------------- player resolution

test("macOS: afplay + system sound file, volume flag when set", () => {
	const probes = probesFor(MAC_FILES, new Set(["afplay"]));
	const plan = resolvePlan(parseConfig(NO_ENV), "done", "darwin", NO_ENV, probes);
	assert.deepEqual(plan, { kind: "spawn", command: "afplay", args: ["/System/Library/Sounds/Glass.aiff"] });
	const loud = resolvePlan(parseConfig({ PI_SOUND_VOLUME: "0.3" }), "ask", "darwin", NO_ENV, probes);
	assert.deepEqual(loud.args, ["-v", "0.3", "/System/Library/Sounds/Ping.aiff"]);
	const named = resolvePlan(parseConfig({ PI_SOUND_DONE: "Hero" }), "done", "darwin", NO_ENV, probes);
	assert.deepEqual(named.args, ["/System/Library/Sounds/Hero.aiff"]);
});

test("macOS: unknown sound name degrades to the kind default, not to silence", () => {
	const probes = probesFor(MAC_FILES, new Set(["afplay"]));
	const plan = resolvePlan(parseConfig({ PI_SOUND_DONE: "NoSuchSound" }), "done", "darwin", NO_ENV, probes);
	assert.deepEqual(plan.args, ["/System/Library/Sounds/Glass.aiff"]);
});

test("macOS without afplay falls back to the bell, or to nothing when bell=0", () => {
	const probes = probesFor(MAC_FILES, new Set());
	assert.equal(resolvePlan(parseConfig(NO_ENV), "done", "darwin", NO_ENV, probes).kind, "bell");
	const p = resolvePlan(parseConfig({ PI_SOUND_BELL: "0" }), "done", "darwin", NO_ENV, probes);
	assert.deepEqual(p, { kind: "none", reason: "no-afplay" });
});

test("linux: prefers paplay with a freedesktop file", () => {
	const files = new Set(["/usr/share/sounds/freedesktop/stereo/complete.oga", "/usr/bin/paplay"]);
	const plan = resolvePlan(parseConfig(NO_ENV), "done", "linux", NO_ENV, probesFor(files, new Set(["paplay", "aplay"])));
	assert.deepEqual(plan, { kind: "spawn", command: "paplay", args: ["/usr/share/sounds/freedesktop/stereo/complete.oga"] });
});

test("linux: canberra needs no file; aplay is only used for wav", () => {
	const canberra = resolvePlan(parseConfig(NO_ENV), "error", "linux", NO_ENV, probesFor(new Set(), new Set(["canberra-gtk-play", "aplay"])));
	assert.deepEqual(canberra, { kind: "spawn", command: "canberra-gtk-play", args: ["-i", "dialog-error"] });
	// only .oga available + only aplay -> aplay cannot play ogg, so bell
	const ogaOnly = resolvePlan(
		parseConfig(NO_ENV),
		"done",
		"linux",
		NO_ENV,
		probesFor(new Set(["/usr/share/sounds/freedesktop/stereo/complete.oga"]), new Set(["aplay"])),
	);
	assert.equal(ogaOnly.kind, "bell");
	const wav = resolvePlan(
		parseConfig({ PI_SOUND_DONE: "/opt/snd/ding.wav" }),
		"done",
		"linux",
		NO_ENV,
		probesFor(new Set(["/opt/snd/ding.wav"]), new Set(["aplay"])),
	);
	assert.deepEqual(wav, { kind: "spawn", command: "aplay", args: ["-q", "/opt/snd/ding.wav"] });
});

test("bare linux with no player and no sounds: bell, never a crash", () => {
	const plan = resolvePlan(parseConfig(NO_ENV), "ask", "freebsd", NO_ENV, probesFor(new Set(), new Set()));
	assert.equal(plan.kind, "bell");
	assert.equal(describePlan(plan), "terminal-bell");
});

test("windows: distinct beeps per kind, custom wav via SoundPlayer", () => {
	const probes = probesFor(new Set(["C:\\snd\\a.wav"]), new Set(["powershell.exe"]));
	const beep = resolvePlan(parseConfig(NO_ENV), "error", "win32", NO_ENV, probes);
	assert.equal(beep.command, "powershell.exe");
	assert.match(beep.args.at(-1), /\[console\]::beep\(330,320\)/);
	const custom = resolvePlan(parseConfig({ PI_SOUND_ASK: "C:\\snd\\a.wav" }), "ask", "win32", NO_ENV, probes);
	assert.match(custom.args.at(-1), /SoundPlayer 'C:\\snd\\a\.wav'/);
});

test("PI_SOUND_PLAYER override wins, with and without {file}", () => {
	const probes = probesFor(MAC_FILES, new Set(["afplay"]));
	const withPh = resolvePlan(parseConfig({ PI_SOUND_PLAYER: "mpv --really-quiet {file}" }), "ask", "darwin", NO_ENV, probes);
	assert.deepEqual(withPh, { kind: "spawn", command: "mpv", args: ["--really-quiet", "/System/Library/Sounds/Ping.aiff"] });
	const appended = resolvePlan(parseConfig({ PI_SOUND_PLAYER: "/bin/echo hi" }), "done", "darwin", NO_ENV, probes);
	assert.deepEqual(appended, { kind: "spawn", command: "/bin/echo", args: ["hi", "/System/Library/Sounds/Glass.aiff"] });
	const kindPh = resolvePlan(parseConfig({ PI_SOUND_PLAYER: "/bin/echo {kind}" }), "error", "darwin", NO_ENV, probes);
	assert.deepEqual(kindPh.args, ["error", "/System/Library/Sounds/Basso.aiff"]);
});

test("resolveMacSound: absolute path passthrough, missing path -> null", () => {
	const exists = (p) => MAC_FILES.has(p);
	assert.equal(resolveMacSound("/System/Library/Sounds/Ping.aiff", exists), "/System/Library/Sounds/Ping.aiff");
	assert.equal(resolveMacSound("Ping.aiff", exists), "/System/Library/Sounds/Ping.aiff");
	assert.equal(resolveMacSound("/nope/x.aiff", exists), null);
	assert.equal(resolveMacSound("Nope", exists), null);
});

test("commandExists walks PATH and honours explicit paths", () => {
	const exists = (p) => p === "/usr/bin/afplay";
	assert.equal(commandExists("afplay", "/bin:/usr/bin", exists), true);
	assert.equal(commandExists("afplay", "/bin", exists), false);
	assert.equal(commandExists("/usr/bin/afplay", "", exists), true);
	assert.equal(commandExists("nope", undefined, exists), false);
});

// ------------------------------------------------------- outcome classification

const asst = (stopReason, errorMessage) => ({ role: "assistant", stopReason, errorMessage });

test("classifyMessages: only the last assistant message decides", () => {
	assert.deepEqual(classifyMessages([asst("error", "boom"), { role: "toolResult" }]), {
		failed: true,
		aborted: false,
		message: "boom",
	});
	assert.deepEqual(classifyMessages([asst("error"), asst("stop")]), { failed: false, aborted: false });
	assert.deepEqual(classifyMessages([asst("aborted")]), { failed: false, aborted: true, message: undefined });
	assert.deepEqual(classifyMessages([asst("stop")]), { failed: false, aborted: false });
	assert.deepEqual(classifyMessages([asst("toolUse")]), { failed: false, aborted: false });
});

test("classifyMessages: malformed payloads never throw", () => {
	for (const bad of [undefined, null, "x", 42, [], [null], [{ role: "user" }], [{}]])
		assert.deepEqual(classifyMessages(bad), { failed: false, aborted: false }, JSON.stringify(bad));
});

// ------------------------------------------------------- duplicate-load guard

test("process clock is shared, so a second instance cannot double-ring", async () => {
	const { processClock, DEDUPE_FLOOR_MS } = await import("../index.ts");
	const a = processClock();
	const b = processClock();
	assert.equal(a, b, "both instances must observe the same clock object");
	const cfg = parseConfig({ PI_SOUND_COOLDOWN_MS: "0" });
	a.done = 0;
	assert.equal(decide(cfg, a, { kind: "done", now: 5_000, mode: "tui", muted: false }).play, true);
	a.done = 5_000; // first instance played
	const second = decide(cfg, a, { kind: "done", now: 5_001, mode: "tui", muted: false });
	assert.deepEqual(second, { play: false, reason: "off:duplicate" });
	// ...but a genuinely later notification still rings even with cooldown=0
	assert.equal(decide(cfg, a, { kind: "done", now: 5_000 + DEDUPE_FLOOR_MS + 1, mode: "tui", muted: false }).play, true);
	a.done = 0;
});

// ------------------------------------------------------- degraded-path visibility

test("degradedWarning names the degradation and how to fix it", async () => {
	const { degradedWarning } = await import("../index.ts");
	assert.equal(degradedWarning({ kind: "spawn", command: "afplay", args: [] }, "darwin"), null);
	const bell = degradedWarning({ kind: "bell" }, "linux");
	assert.match(bell, /terminal bell/);
	assert.match(bell, /paplay|PI_SOUND_PLAYER/);
	const silent = degradedWarning({ kind: "none", reason: "no-afplay" }, "darwin");
	assert.match(silent, /staying silent \(no-afplay, PI_SOUND_BELL=0\)/);
	assert.match(silent, /PI_SOUND_PLAYER/);
});
