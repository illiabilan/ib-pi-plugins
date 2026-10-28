/**
 * Integration tests: the real CLI as a subprocess against a fake `adb` (ADB env var), a fake venv python
 * (stands in for gif.py/frames.py) and a fake mitmdump. No device, no ffmpeg, no mitmproxy needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AFTER_TAP_XML, XML } from "./fakes/screens.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "android-vqa.mjs");
const FAKES = join(HERE, "fakes");
const SETTINGS = { "global.window_animation_scale": "0.5", "global.transition_animation_scale": "0.5", "system.show_touches": "0" };

function wrapper(path, target) {
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`);
  chmodSync(path, 0o755);
}

function makeEnv({ venv = false, devices } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vqa-it-")));
  const adbDir = join(root, "adb-state");
  const home = join(root, "vqa-home");
  const cwd = join(root, "work");
  for (const d of [adbDir, home, cwd, join(root, "user")]) mkdirSync(d, { recursive: true });
  wrapper(join(root, "adb"), join(FAKES, "fake-adb.mjs"));
  writeFileSync(join(adbDir, "ui.xml"), XML);
  writeFileSync(join(adbDir, "after-tap.xml"), AFTER_TAP_XML);
  writeFileSync(join(adbDir, "settings.json"), JSON.stringify(SETTINGS));
  if (devices !== undefined) writeFileSync(join(adbDir, "devices.txt"), devices);
  if (venv) {
    mkdirSync(join(home, "venv", "bin"), { recursive: true });
    wrapper(join(home, "venv", "bin", "python"), join(FAKES, "fake-python.mjs"));
    wrapper(join(home, "venv", "bin", "mitmdump"), join(FAKES, "fake-mitmdump.mjs"));
  }
  const env = { ...process.env, HOME: join(root, "user"), ANDROID_VQA_HOME: home, ADB: join(root, "adb"), FAKE_ADB_DIR: adbDir };
  delete env.ANDROID_SERIAL;
  return {
    root, adbDir, home, cwd, env,
    calls: () => readFileSync(join(adbDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    shells: () => readFileSync(join(adbDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[2] === "shell").map((a) => a.slice(3).join(" ")),
    settings: () => JSON.parse(readFileSync(join(adbDir, "settings.json"), "utf8")),
  };
}

function cli(t, args, { input, env, onSpawn } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: t.cwd, env: { ...t.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
    onSpawn?.(child, () => stderr);
  });
}

const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const waitFor = async (fn, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

const SCENARIO = (extra = {}) => ({
  name: "G03-single", app: { package: "com.example.app" }, title: "G03 single copy", desc: "tap Join", expect: "checkout opens",
  steps: [
    { do: "force_stop" }, { do: "launch" }, { do: "wait", text: "Delivery", timeout: 2 }, { do: "cut" },
    { do: "assert", label: "bar", present: ["QA single copy", "^Join$"], absent: ["cashback_info_icon"] },
    { do: "tap", text: "^Join$" },
    { do: "assert", label: "checkout", present: ["Checkout", "Standard Plan"], absent: ["^Join$"] },
    { do: "back" },
    { do: "assert", label: "back-home", present: ["QA single copy"] },
  ],
  ...extra,
});

/* ------------------------------------------------------------------ device probes */

test("status: device, animation scales, show_touches, proxy, venv", async () => {
  const t = makeEnv();
  const r = await cli(t, ["status"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /device: emulator-5554/);
  assert.match(r.stdout, /window_animation_scale=0.5/);
  assert.match(r.stdout, /animator_duration_scale=null/);
  assert.match(r.stdout, /show_touches=0/);
  assert.match(r.stdout, /proxy: stopped/);
  assert.match(r.stdout, /venv: MISSING/);
  const j = JSON.parse((await cli(t, ["status", "--json"])).stdout);
  assert.equal(j.device, "emulator-5554");
  assert.equal(j.settings.transition_animation_scale, "0.5");
  assert.ok(t.calls().every((a) => a[0] === "devices" || (a[0] === "-s" && a[1] === "emulator-5554")), "every device call is pinned with -s");
});

test("device resolution: none, several, explicit --serial", async () => {
  const none = makeEnv({ devices: "List of devices attached\nemulator-5554\toffline\n" });
  let r = await cli(none, ["ui"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no adb device in 'device' state; start an emulator \(the user must start it\)/);
  const two = makeEnv({ devices: "List of devices attached\nemulator-5554\tdevice\nR58M\tdevice\n" });
  r = await cli(two, ["ui"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /several devices connected \(emulator-5554, R58M\); pass --serial/);
  r = await cli(two, ["ui", "--serial", "R58M"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(two.calls().some((a) => a[1] === "R58M"));
});

test("ui: activity, visible nodes, --find", async () => {
  const t = makeEnv();
  const r = await cli(t, ["ui"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^activity: com.example.app\/.MainActivity\n4\/4 nodes\n/);
  assert.match(r.stdout, /\[800,400,1000,500\] id=cta t="Join" clickable/);
  assert.doesNotMatch(r.stdout, /cashback_info_icon/, "invisible node hidden");
  const f = await cli(t, ["ui", "--find", "join", "--json"]);
  const j = JSON.parse(f.stdout);
  assert.equal(j.nodes.length, 1);
  assert.deepEqual(j.nodes[0].center, [900, 450]);
  assert.ok(t.shells().includes("uiautomator dump /sdcard/vqa-ui.xml"));
});

test("tap --text taps the node center; misses and bad flags fail", async () => {
  const t = makeEnv();
  let r = await cli(t, ["tap", "--text", "^join$"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /tapped .*id=cta.* at 900,450/);
  assert.ok(t.shells().includes("input tap 900 450"));
  await cli(t, ["key"]); // fake adb: BACK returns to the first screen
  r = await cli(t, ["tap", "--id", "menu"]);
  assert.ok(t.shells().includes("input tap 1030 150"), r.stderr);
  r = await cli(t, ["tap", "--x", "10.4", "--y", "20.6"]);
  assert.ok(t.shells().includes("input tap 10 21"));
  r = await cli(t, ["tap", "--text", "nothing-like-this"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no visible node for text=nothing-like-this/);
  r = await cli(t, ["tap"]);
  assert.equal(r.code, 2);
  r = await cli(t, ["tap", "--x", "5"]);
  assert.equal(r.code, 2);
  r = await cli(t, ["tap", "--text", "x", "--find", "y"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not valid for "tap": --find/);
});

test("key, type, proxy device on/off", async () => {
  const t = makeEnv();
  assert.equal((await cli(t, ["key"])).code, 0);
  assert.equal((await cli(t, ["key", "KEYCODE_HOME"])).code, 0);
  assert.equal((await cli(t, ["key", "rm -rf"])).code, 2);
  assert.equal((await cli(t, ["type", "hello world"])).code, 0);
  const sh = t.shells();
  assert.ok(sh.includes("input keyevent KEYCODE_BACK"));
  assert.ok(sh.includes("input keyevent KEYCODE_HOME"));
  assert.ok(sh.includes('input text "hello%sworld"'));
  let r = await cli(t, ["proxy", "device", "on", "--port", "9999"]);
  assert.equal(r.stdout.trim(), "device http_proxy=10.0.2.2:9999 (emulator host alias)");
  assert.equal(t.settings()["global.http_proxy"], "10.0.2.2:9999");
  r = await cli(t, ["proxy", "device", "off"]);
  assert.equal(t.settings()["global.http_proxy"], ":0");
  assert.equal((await cli(t, ["proxy", "device", "maybe"])).code, 2);
});

/* ------------------------------------------------------------------ run */

test("run --no-record: assertions pass (scenario from stdin)", async () => {
  const t = makeEnv();
  const r = await cli(t, ["run", "--scenario", "-", "--no-record"], { input: JSON.stringify(SCENARIO()) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS G03-single \([\d.]+s\)  assertions 7\/7/);
  assert.match(r.stdout, /ok   checkout: present \/Checkout\//);
  assert.match(r.stderr, /G03-single: step 9\/9 assert ok/, "progress on stderr");
  const sh = t.shells();
  assert.ok(sh.includes("am force-stop com.example.app"));
  assert.ok(sh.includes("am start -n com.example.app/.MainActivity"), "launcher activity resolved");
  assert.ok(!sh.some((s) => s.startsWith("settings put")), "no settings touched without recording");
  assert.ok(!sh.some((s) => s.startsWith("screenrecord")));
  const out = join(t.cwd, ".vqa");
  const res = JSON.parse(readFileSync(join(out, "G03-single.result.json"), "utf8"));
  assert.equal(res.passed, true);
  assert.equal(res.assertions.length, 7);
  assert.ok(existsSync(join(out, "ui", "G03-single-bar.xml")));
  assert.match(readFileSync(join(out, "G03-single.timeline.txt"), "utf8"), /tap \^Join\$ at 900,450/);
});

test("run --no-record: failing assertions -> FAIL, exit 1, details; report table", async () => {
  const t = makeEnv();
  const sc = SCENARIO({ name: "G04-fail" });
  sc.steps[4] = { do: "assert", label: "bar", present: ["Missing banner"], absent: ["^Delivery$"] };
  writeFileSync(join(t.cwd, "sc.json"), JSON.stringify(sc));
  const r = await cli(t, ["run", "--scenario", "sc.json", "--no-record", "--out-dir", "gifs"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^FAIL G04-fail .* assertions 4\/6/);
  assert.match(r.stdout, /FAIL bar: present \/Missing banner\/  no visible node matched/);
  assert.match(r.stdout, /FAIL bar: absent \/\^Delivery\$\/  found \[0,100,540,200\] id=tab_delivery/);
  const j = await cli(t, ["run", "--scenario", "sc.json", "--no-record", "--out-dir", "gifs", "--json", "--name", "G04-json"]);
  const res = JSON.parse(j.stdout);
  assert.equal(res.passed, false);
  assert.equal(res.assertions.filter((a) => !a.ok).length, 2);
  await cli(t, ["run", "--scenario", "-", "--no-record", "--out-dir", "gifs"], { input: JSON.stringify(SCENARIO()) });
  const rep = await cli(t, ["report", "--out-dir", "gifs"]);
  assert.equal(rep.code, 0, rep.stderr);
  assert.match(rep.stdout, /\(1\/3 PASS\)/);
  const md = readFileSync(join(t.cwd, "gifs", "README.md"), "utf8");
  assert.match(md, /\| - \| G03 single copy \| tap Join \| checkout opens \| FAIL \(2 failed\) \| ✘ present \/Missing banner\//);
});

test("run: wait target missing aborts the run as FAIL", async () => {
  const t = makeEnv();
  const sc = SCENARIO({ name: "G05-wait" });
  sc.steps[2] = { do: "wait", text: "Never shown", timeout: 1 };
  const r = await cli(t, ["run", "--scenario", "-", "--no-record"], { input: JSON.stringify(sc) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ABORTED: wait failed at step 3: Never shown/);
});

test("run: usage errors (bad JSON, schema, missing venv for recording)", async () => {
  const t = makeEnv();
  let r = await cli(t, ["run", "--scenario", "-"], { input: "{nope" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /stdin: invalid JSON/);
  r = await cli(t, ["run", "--scenario", "-"], { input: JSON.stringify({ name: "x", steps: [{ do: "tap" }] }) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tap needs text, id, or x and y/);
  r = await cli(t, ["run"]);
  assert.equal(r.code, 2);
  r = await cli(t, ["run", "--scenario", "-"], { input: JSON.stringify(SCENARIO()) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GIF tooling missing.*setup/);
});

test("run with recording (stub venv): settings set during run and restored after; GIF built and checked", async () => {
  const t = makeEnv({ venv: true });
  const r = await cli(t, ["run", "--scenario", "-"], { input: JSON.stringify(SCENARIO()) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const sh = t.shells();
  for (const k of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) assert.ok(sh.includes(`settings put global ${k} 1.0`), k);
  assert.ok(sh.includes("settings put system show_touches 1"));
  assert.ok(sh.some((s) => s.startsWith("screenrecord --bit-rate 4000000 --time-limit 170 /sdcard/G03-single.mp4")));
  assert.ok(sh.includes("pkill -INT screenrecord || killall -2 screenrecord"));
  assert.ok(t.calls().some((a) => a[2] === "pull" && a[3] === "/sdcard/G03-single.mp4"));
  assert.deepEqual(t.settings(), { ...SETTINGS, "global.animator_duration_scale": "1.0" }, "originals restored ('null' -> 1.0)");
  const out = join(t.cwd, ".vqa");
  assert.match(r.stdout, new RegExp(`gif: ${out}/G03-single.gif  frames=20 changed=5`));
  assert.match(r.stdout, /Read the sheet PNG/);
  const py = readFileSync(join(t.adbDir, "python.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gifArgs = py.find((a) => a[0].endsWith("gif.py"));
  assert.equal(gifArgs[gifArgs.indexOf("--title") + 1], "G03 single copy");
  assert.equal(gifArgs[gifArgs.indexOf("--expect") + 1], "checkout opens");
  assert.ok(Number(gifArgs[gifArgs.indexOf("--start") + 1]) >= 0, "cut offset passed as --start");
  assert.match(readFileSync(join(out, "G03-single.timeline.txt"), "utf8"), /restored window_animation_scale=0.5 transition_animation_scale=0.5 animator_duration_scale=null show_touches=0/);
});

test("run with recording: static GIF warning; --no-animations keeps scales untouched", async () => {
  const t = makeEnv({ venv: true });
  const r = await cli(t, ["run", "--scenario", "-", "--no-animations"], { input: JSON.stringify(SCENARIO()), env: { FAKE_CHANGED: "0" } });
  assert.match(r.stdout, /warning: GIF is static \(0 changed frames\)/);
  assert.ok(!t.shells().some((s) => s.startsWith("settings put global")));
  assert.ok(t.shells().includes("settings put system show_touches 1"));
  assert.equal(t.settings()["system.show_touches"], "0");
});

test("run with recording: step error still restores settings", async () => {
  const t = makeEnv({ venv: true });
  const sc = SCENARIO({ name: "G06-err", steps: [{ do: "mark", label: "x" }, { do: "fixture", value: "m1" }] });
  const r = await cli(t, ["run", "--scenario", "-"], { input: JSON.stringify(sc) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ABORTED: fixture step needs a running proxy/);
  assert.deepEqual(t.settings(), { ...SETTINGS, "global.animator_duration_scale": "1.0" });
});

test("run with recording: SIGINT stops, restores settings, exits 130", async () => {
  const t = makeEnv({ venv: true });
  const sc = SCENARIO({ name: "G07-int", steps: [{ do: "mark", label: "start" }, { do: "sleep", s: 60 }] });
  const started = Date.now();
  const r = await cli(t, ["run", "--scenario", "-"], {
    input: JSON.stringify(sc),
    onSpawn: async (child, stderr) => {
      await waitFor(() => /step 1\/2 mark ok/.test(stderr()));
      child.kill("SIGINT");
    },
  });
  assert.equal(r.code, 130, r.stdout + r.stderr);
  assert.ok(Date.now() - started < 30_000, "did not wait for the 60s sleep");
  assert.match(r.stderr, /interrupted: stopping and restoring device settings/);
  assert.match(r.stdout, /FAIL G07-int .*ABORTED: interrupted/);
  assert.match(r.stdout, /warning: interrupted: GIF not built/);
  assert.deepEqual(t.settings(), { ...SETTINGS, "global.animator_duration_scale": "1.0" });
  assert.ok(t.shells().includes("pkill -INT screenrecord || killall -2 screenrecord"));
});

test("run: a JSON list runs every scenario", async () => {
  const t = makeEnv();
  const bad = SCENARIO({ name: "B" });
  bad.steps = [{ do: "assert", present: ["nope"] }];
  const r = await cli(t, ["run", "--scenario", "-", "--no-record"], { input: JSON.stringify([SCENARIO({ name: "A" }), bad]) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /PASS A/);
  assert.match(r.stdout, /FAIL B/);
  assert.match(r.stdout, /1\/2 PASS\n$/);
});

/* ------------------------------------------------------------------ proxy state */

test("proxy: start/fixture/log/status/stop with a detached (fake) mitmdump", async () => {
  const t = makeEnv({ venv: true });
  const fx = join(t.cwd, "fixtures");
  mkdirSync(fx);
  writeFileSync(join(fx, "m1-single.json"), "{}");
  const port = await freePort();
  let r = await cli(t, ["proxy", "start", "--fixtures-dir", "fixtures", "--match", "/plans", "--port", String(port)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`proxy up :${port} \\(pid \\d+\\), mocking URLs containing '/plans'`));
  assert.match(r.stdout, /fixtures: m1-single \(\+ 404, passthrough\)/);
  const state = JSON.parse(readFileSync(join(t.home, "proxy.json"), "utf8"));
  assert.equal(state.port, port);
  assert.equal(state.fixturesDir, fx);
  try {
    r = await cli(t, ["proxy", "start", "--fixtures-dir", "fixtures", "--match", "x", "--port", String(port)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already running/);
    r = await cli(t, ["proxy", "fixture", "m1-single"]);
    assert.equal(r.stdout.trim(), "fixture=m1-single");
    assert.equal(readFileSync(state.currentFile, "utf8"), "m1-single");
    r = await cli(t, ["proxy", "fixture", "nope"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /fixture 'nope.json' not found/);
    assert.equal((await cli(t, ["proxy", "fixture", "404"])).code, 0);
    r = await cli(t, ["proxy", "status"]);
    assert.match(r.stdout, new RegExp(`proxy: running :${port} pid ${state.pid} fixture=404`));
    assert.match((await cli(t, ["status"])).stdout, /proxy: running/);
    r = await cli(t, ["proxy", "log", "--lines", "5"]);
    assert.match(r.stdout, /MATCH GET https:\/\/api.example.com\/\/plans/);
    r = await cli(t, ["proxy", "device", "on"]);
    assert.equal(t.settings()["global.http_proxy"], `10.0.2.2:${port}`, "port taken from proxy state");
    // the run fixture step writes through the persisted state
    const sc = SCENARIO({ name: "G08-fx", noRecord: true, steps: [{ do: "fixture", value: "passthrough" }] });
    r = await cli(t, ["run", "--scenario", "-"], { input: JSON.stringify(sc) });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(state.currentFile, "utf8"), "passthrough");
  } finally {
    r = await cli(t, ["proxy", "stop"]);
  }
  assert.equal(r.code, 0);
  assert.match(r.stdout, /proxy stopped/);
  assert.ok(!existsSync(join(t.home, "proxy.json")));
  assert.ok(await waitFor(() => { try { process.kill(state.pid, 0); return false; } catch { return true; } }, 5000), "mitmdump pid is gone");
  r = await cli(t, ["proxy", "log"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /proxy not running/);
});

test("proxy: stale state (dead pid) is cleaned; a live foreign pid is never killed", async () => {
  const t = makeEnv({ venv: true });
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("close", r));
  writeFileSync(join(t.home, "proxy.json"), JSON.stringify({ pid: dead.pid, port: 1, currentFile: "/nope", logFile: "/nope", fixturesDir: "/nope" }));
  let r = await cli(t, ["proxy", "status"]);
  assert.match(r.stdout, new RegExp(`proxy: stopped \\(pid ${dead.pid} is gone; stale state removed\\)`));
  assert.ok(!existsSync(join(t.home, "proxy.json")));

  const foreign = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"]);
  try {
    writeFileSync(join(t.home, "proxy.json"), JSON.stringify({ pid: foreign.pid, port: 1, currentFile: "/nope", logFile: "/nope", fixturesDir: "/nope" }));
    r = await cli(t, ["proxy", "stop"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /is not our mitmdump .*did not kill it/);
    assert.equal(foreign.exitCode, null);
    process.kill(foreign.pid, 0); // still alive
    assert.ok(!existsSync(join(t.home, "proxy.json")));
    writeFileSync(join(t.home, "proxy.json"), "{corrupt");
    r = await cli(t, ["proxy", "fixture", "x"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /state file was corrupt/);
  } finally {
    foreign.kill();
  }
});

test("help and unknown commands", async () => {
  const t = makeEnv();
  let r = await cli(t, ["--help"]);
  assert.equal(r.code, 0);
  for (const c of ["setup", "status", "ui", "tap", "key", "type", "run", "gif", "check", "frames", "report", "proxy start", "proxy fixture", "proxy log", "proxy stop", "proxy status", "proxy device", "ca install", "ca remove"]) {
    assert.match(r.stdout, new RegExp(`^  ${c}\\b`, "m"), c);
  }
  r = await cli(t, ["proxy", "start", "--help"]);
  assert.match(r.stdout, /Usage: android-vqa proxy start --fixtures-dir/);
  r = await cli(t, ["explode"]);
  assert.equal(r.code, 2);
  r = await cli(t, ["frames", "x.gif"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /GIF tooling missing/);
});
