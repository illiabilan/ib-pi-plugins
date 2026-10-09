/**
 * android_vqa — visual QA on an Android emulator/device with captioned GIF evidence.
 *
 * Why this exists: a model cannot watch a video while it records one, and a GIF proves nothing unless
 * something verified what is on screen. `run` therefore records the screen AND dumps the UI hierarchy
 * (uiautomator) during the same window, evaluates assertions against those dumps, and builds a captioned
 * GIF. `frames` renders a contact sheet that the model can actually look at (image content block).
 *
 * Actions: setup | status | ui | tap | key | type | run | gif | check | frames | report |
 *          proxy_start | proxy_fixture | proxy_log | proxy_stop | proxy_device | ca_install | ca_remove
 *
 * Install: copy/symlink this directory into ~/.pi/agent/extensions/android-vqa, then call `setup` once
 * (creates a private venv with imageio-ffmpeg, pillow and mitmproxy; nothing is installed globally).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.PI_ANDROID_VQA_HOME ?? join(homedir(), ".pi", "agent", "android-vqa");
const VENV = join(HOME_DIR, "venv");
const PY = join(VENV, "bin", "python");
const MITMDUMP = join(VENV, "bin", "mitmdump");
const MAX_OUT = 12_000;

const ACTIONS = [
  "setup", "status", "ui", "tap", "key", "type", "run", "gif", "check", "frames", "report",
  "proxy_start", "proxy_fixture", "proxy_log", "proxy_stop", "proxy_device", "ca_install", "ca_remove",
] as const;

const Step = Type.Object({
  do: StringEnum(
    ["launch", "force_stop", "sleep", "wait", "tap", "back", "key", "type", "swipe", "dump", "hold", "assert",
      "fixture", "shell", "setting", "screenshot", "cut", "mark"] as const,
    { description: "Step kind" },
  ),
  text: Type.Optional(Type.String({ description: "tap/wait: regex (case-insensitive) on node text or content-desc" })),
  id: Type.Optional(Type.String({ description: "tap/wait: resource-id (suffix after '/', or full id)" })),
  index: Type.Optional(Type.Number({ description: "tap: which match (default 0)" })),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  x2: Type.Optional(Type.Number()),
  y2: Type.Optional(Type.Number()),
  ms: Type.Optional(Type.Number({ description: "swipe duration" })),
  s: Type.Optional(Type.Number({ description: "sleep/hold seconds" })),
  every: Type.Optional(Type.Number({ description: "hold: dump every N seconds (default 2)" })),
  timeout: Type.Optional(Type.Number({ description: "wait/tap: seconds to keep retrying (default 20 / 10)" })),
  label: Type.Optional(Type.String({ description: "dump/assert/mark label" })),
  code: Type.Optional(Type.String({ description: "key: KEYCODE_* or number" })),
  value: Type.Optional(Type.String({ description: "type: text; setting: value; fixture: name" })),
  name: Type.Optional(Type.String({ description: "fixture/screenshot name" })),
  cmd: Type.Optional(Type.String({ description: "shell: command run via `adb shell`" })),
  ns: Type.Optional(Type.String({ description: "setting namespace: global|system|secure" })),
  key: Type.Optional(Type.String({ description: "setting key" })),
  present: Type.Optional(Type.Array(Type.String(), { description: "assert: regexes that MUST match some node text/desc/id" })),
  absent: Type.Optional(Type.Array(Type.String(), { description: "assert: regexes that must match NO node" })),
});
type StepT = Static<typeof Step>;

const Params = Type.Object({
  action: StringEnum(ACTIONS, { description: "What to do" }),
  serial: Type.Optional(Type.String({ description: "adb serial (default: ANDROID_SERIAL or the only connected device)" })),
  name: Type.Optional(Type.String({ description: "run/gif/frames: artifact base name, e.g. 'G03-single-copy'" })),
  outDir: Type.Optional(Type.String({ description: "Artifact directory (default <cwd>/.vqa)" })),
  app: Type.Optional(Type.Object({
    package: Type.String(),
    activity: Type.Optional(Type.String({ description: "Fully qualified or relative activity; omit to use the launcher intent" })),
  })),
  steps: Type.Optional(Type.Array(Step, { description: "run: ordered scenario steps" })),
  title: Type.Optional(Type.String({ description: "GIF caption line 1 (scenario id)" })),
  desc: Type.Optional(Type.String({ description: "GIF caption: setup / what is done" })),
  expect: Type.Optional(Type.String({ description: "GIF caption: expected result" })),
  recordLimit: Type.Optional(Type.Number({ description: "run: max recording seconds (screenrecord caps at 180; default 170)" })),
  noRecord: Type.Optional(Type.Boolean({ description: "run: skip recording/GIF, only run steps + assertions" })),
  animations: Type.Optional(Type.Boolean({ description: "run: set animation scales to 1.0 while recording, restore after (default true)" })),
  touches: Type.Optional(Type.Boolean({ description: "run: show touch dots while recording, restore after (default true)" })),
  fps: Type.Optional(Type.Number({ description: "gif fps (default 10)" })),
  width: Type.Optional(Type.Number({ description: "gif width px (default 360)" })),
  hold: Type.Optional(Type.Number({ description: "gif: seconds to freeze on the last frame (default 1)" })),
  start: Type.Optional(Type.Number({ description: "gif: trim start seconds" })),
  end: Type.Optional(Type.Number({ description: "gif: trim end seconds" })),
  src: Type.Optional(Type.String({ description: "gif/check/frames: source mp4 or gif path" })),
  count: Type.Optional(Type.Number({ description: "frames: how many frames in the sheet (default 8)" })),
  find: Type.Optional(Type.String({ description: "ui: only list nodes whose text/desc/id matches this regex" })),
  text: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  index: Type.Optional(Type.Number()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  code: Type.Optional(Type.String()),
  value: Type.Optional(Type.String({ description: "type: text; proxy_fixture: fixture name; proxy_device: on|off" })),
  fixturesDir: Type.Optional(Type.String({ description: "proxy_start: directory with <name>.json fixtures" })),
  match: Type.Optional(Type.String({ description: "proxy_start: URL substring to mock" })),
  port: Type.Optional(Type.Number({ description: "proxy port (default 8080)" })),
  needles: Type.Optional(Type.Array(Type.String(), { description: "proxy_start: log request bodies containing these strings" })),
  host: Type.Optional(Type.String({ description: "proxy_device: host address as seen by the device (default 10.0.2.2 for emulators)" })),
  lines: Type.Optional(Type.Number({ description: "proxy_log: tail lines (default 30)" })),
  withProxy: Type.Optional(Type.Boolean({ description: "setup: also install mitmproxy (default true)" })),
});
type ParamsT = Static<typeof Params>;

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function run(cmd: string, args: string[], opts: { timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeout * 1000) : undefined;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      res({ code, stdout, stderr, timedOut });
    });
  });
}

function runBuf(cmd: string, args: string[], timeout = 30): Promise<{ code: number | null; data: Buffer }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout * 1000);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("close", (code) => { clearTimeout(timer); res({ code, data: Buffer.concat(chunks) }); });
    child.on("error", () => { clearTimeout(timer); res({ code: -1, data: Buffer.alloc(0) }); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fix = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function findAdb(): string {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    join(homedir(), "Android", "Sdk", "platform-tools", "adb"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return "adb";
}

function hasVenv(): boolean {
  return existsSync(PY);
}

// ---------------------------------------------------------------- device

class Device {
  constructor(public adbPath: string, public serial: string) {}

  args(a: string[]): string[] {
    return ["-s", this.serial, ...a];
  }
  sh(cmd: string, timeout = 30): Promise<RunResult> {
    return run(this.adbPath, this.args(["shell", cmd]), { timeout });
  }
  adb(a: string[], timeout = 60): Promise<RunResult> {
    return run(this.adbPath, this.args(a), { timeout });
  }
  async dumpXml(): Promise<string> {
    await this.sh("uiautomator dump /sdcard/vqa-ui.xml", 20);
    const r = await runBuf(this.adbPath, this.args(["exec-out", "cat", "/sdcard/vqa-ui.xml"]));
    return r.data.toString("utf8");
  }
  async topActivity(): Promise<string> {
    const r = await this.sh("dumpsys activity activities | grep topResumedActivity | head -1", 15);
    const m = r.stdout.match(/ u\d+ ([^\s}]+)/);
    return m ? m[1]! : "?";
  }
  async getSetting(ns: string, key: string): Promise<string> {
    return (await this.sh(`settings get ${ns} ${key}`, 10)).stdout.trim();
  }
  async putSetting(ns: string, key: string, value: string): Promise<void> {
    await this.sh(`settings put ${ns} ${key} ${value}`, 10);
  }
}

async function resolveDevice(serialParam?: string): Promise<Device> {
  const adbPath = findAdb();
  const serial = serialParam ?? process.env.ANDROID_SERIAL;
  if (serial) return new Device(adbPath, serial);
  const r = await run(adbPath, ["devices"], { timeout: 15 });
  if (r.code !== 0) throw new Error(`adb not usable: ${(r.stderr || r.stdout).trim() || "adb missing (set ADB or ANDROID_HOME)"}`);
  const devs = r.stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]!);
  if (devs.length === 0) throw new Error("no adb device in 'device' state; start an emulator (the user must start it) and retry");
  if (devs.length > 1) throw new Error(`several devices connected (${devs.join(", ")}); pass serial`);
  return new Device(adbPath, devs[0]!);
}

// ---------------------------------------------------------------- UI dump

type UiNode = { text: string; desc: string; id: string; bounds: [number, number, number, number]; clickable: boolean; checked: boolean; visible: boolean };

const decode = (s: string) =>
  s.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseNodes(xml: string): UiNode[] {
  const out: UiNode[] = [];
  const attr = (n: string, name: string) => {
    const m = n.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
    return m ? decode(m[1]!) : "";
  };
  for (const m of xml.matchAll(/<node\s[^>]*>/g)) {
    const n = m[0];
    const b = attr(n, "bounds").match(/-?\d+/g)?.map(Number) ?? [0, 0, 0, 0];
    const bounds: [number, number, number, number] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
    out.push({
      text: attr(n, "text"),
      desc: attr(n, "content-desc"),
      id: attr(n, "resource-id"),
      bounds,
      clickable: attr(n, "clickable") === "true",
      checked: attr(n, "checked") === "true",
      visible: bounds[2] > bounds[0] && bounds[3] > bounds[1],
    });
  }
  return out;
}

const center = (n: UiNode): [number, number] => [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];
const fmtNode = (n: UiNode) =>
  `[${n.bounds.join(",")}] ${n.id ? "id=" + n.id.split("/").pop() : ""} ${n.text ? "t=" + JSON.stringify(fix(n.text, 80)) : ""}${
    n.desc ? " d=" + JSON.stringify(fix(n.desc, 60)) : ""
  }${n.clickable ? " clickable" : ""}${n.checked ? " checked" : ""}`.replace(/\s+/g, " ");

function nodeMatches(n: UiNode, sel: { text?: string; id?: string }): boolean {
  if (!n.visible) return false;
  if (sel.id && !(n.id === sel.id || n.id.endsWith("/" + sel.id))) return false;
  if (sel.text) {
    const re = new RegExp(sel.text, "i");
    if (!re.test(n.text) && !re.test(n.desc)) return false;
  }
  return !!(sel.id || sel.text);
}

const anyMatch = (nodes: UiNode[], pattern: string): UiNode | undefined => {
  const re = new RegExp(pattern, "i");
  return nodes.find((n) => n.visible && (re.test(n.text) || re.test(n.desc) || re.test(n.id)));
};

// ---------------------------------------------------------------- shared state

type Proxy = { proc: ChildProcess; port: number; currentFile: string; logFile: string; fixturesDir: string };
let proxy: Proxy | undefined;
let recorder: ChildProcess | undefined;

function killAll() {
  try { proxy?.proc.kill("SIGTERM"); } catch { /* ignore */ }
  try { recorder?.kill("SIGKILL"); } catch { /* ignore */ }
  proxy = undefined;
  recorder = undefined;
}

function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((res) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const s = createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.destroy(); res(true); });
      s.once("error", () => { s.destroy(); if (Date.now() > deadline) res(false); else setTimeout(tryOnce, 300); });
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------- scenario engine

type Assertion = { label: string; ok: boolean; detail: string };
type Result = {
  name: string;
  passed: boolean;
  aborted?: string;
  assertions: Assertion[];
  timeline: string[];
  mp4?: string;
  gif?: string;
  gifInfo?: Record<string, unknown>;
  check?: { frames: number; changedFrames: number };
  warnings: string[];
  elapsedS: number;
  title?: string;
  desc?: string;
  expect?: string;
};

const ANIM_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

async function runScenario(p: ParamsT, dev: Device, cwd: string, signal: AbortSignal | undefined, say: (m: string) => void): Promise<Result> {
  if (!p.name) throw new Error("run: 'name' is required");
  if (!p.steps || p.steps.length === 0) throw new Error("run: 'steps' is required");
  const outDir = resolveOut(p, cwd);
  const uiDir = join(outDir, "ui");
  const srcDir = join(outDir, "src");
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  const record = !p.noRecord;
  if (record && !hasVenv()) throw new Error("run: GIF tooling missing. Call android_vqa {action:'setup'} first (or pass noRecord:true)");

  const res: Result = { name: p.name, passed: true, assertions: [], timeline: [], warnings: [], elapsedS: 0, title: p.title, desc: p.desc, expect: p.expect };
  let t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  const mark = (m: string) => { res.timeline.push(`t=${el()} ${m}`); };
  let cutAt = 0;
  let lastNodes: UiNode[] = [];
  let dumpN = 0;

  const saved: { ns: string; key: string; value: string }[] = [];
  if (record) {
    if (p.animations !== false) for (const k of ANIM_KEYS) saved.push({ ns: "global", key: k, value: await dev.getSetting("global", k) });
    if (p.touches !== false) saved.push({ ns: "system", key: "show_touches", value: await dev.getSetting("system", "show_touches") });
    for (const s of saved) await dev.putSetting(s.ns, s.key, s.key === "show_touches" ? "1" : "1.0");
  }

  const mp4Name = `${p.name}.mp4`;
  if (record) {
    await dev.sh(`rm -f /sdcard/${mp4Name}`, 10);
    recorder = spawn(dev.adbPath, dev.args(["shell", "screenrecord", "--bit-rate", "4000000", "--time-limit", String(Math.min(p.recordLimit ?? 170, 180)), `/sdcard/${mp4Name}`]), { stdio: "ignore" });
    await sleep(1200);
  }
  t0 = Date.now();
  mark(`recording ${record ? "started" : "skipped"}`);

  const doDump = async (label: string, withActivity = false): Promise<UiNode[]> => {
    const xml = await dev.dumpXml();
    dumpN++;
    writeFileSync(join(uiDir, `${p.name}-${label}.xml`), xml);
    lastNodes = parseNodes(xml);
    const texts = lastNodes.filter((n) => n.visible && (n.text || n.desc)).map((n) => n.text || n.desc);
    const act = withActivity ? ` [${await dev.topActivity()}]` : "";
    mark(`dump ${label}${act}: ${fix(texts.slice(0, 14).join(" | "), 400)}`);
    return lastNodes;
  };

  const findNode = async (sel: { text?: string; id?: string }, idx: number, timeoutS: number, label: string): Promise<UiNode | undefined> => {
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const nodes = await doDump(label);
      const hits = nodes.filter((n) => nodeMatches(n, sel));
      if (hits[idx]) return hits[idx];
      if (Date.now() > deadline || signal?.aborted) return undefined;
      await sleep(1000);
    }
  };

  try {
    let i = 0;
    for (const st of p.steps) {
      i++;
      if (signal?.aborted) { res.aborted = "cancelled"; break; }
      const tag = `s${i}`;
      switch (st.do) {
        case "launch": {
          if (!p.app) throw new Error("launch needs 'app'");
          if (p.app.activity) {
            const a = p.app.activity;
            const act = a.includes("/") ? a : `${p.app.package}/${a}`;
            await dev.sh(`am start -n ${act}`, 20);
          } else {
            const r = await dev.sh(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${p.app.package}`, 15);
            const comp = r.stdout.trim().split("\n").pop()?.trim() ?? "";
            if (!comp.includes("/")) throw new Error(`no launcher activity for ${p.app.package} (installed?): ${fix(r.stdout + r.stderr, 200)}`);
            await dev.sh(`am start -n ${comp}`, 20);
          }
          mark(`launch ${p.app.package}`);
          break;
        }
        case "force_stop":
          if (!p.app) throw new Error("force_stop needs 'app'");
          await dev.sh(`am force-stop ${p.app.package}`, 10);
          mark("force-stop");
          break;
        case "sleep":
          await sleep((st.s ?? 1) * 1000);
          break;
        case "wait": {
          const n = await findNode({ text: st.text, id: st.id }, 0, st.timeout ?? 20, `${tag}-wait`);
          if (!n) { res.passed = false; res.aborted = `wait failed at step ${i}: ${st.text ?? st.id}`; mark(`!! ${res.aborted}`); break; }
          mark(`wait ok: ${fmtNode(n)}`);
          break;
        }
        case "tap": {
          if (st.x !== undefined && st.y !== undefined) {
            await dev.sh(`input tap ${Math.round(st.x)} ${Math.round(st.y)}`, 10);
            mark(`tap xy ${st.x},${st.y}`);
            break;
          }
          const n = await findNode({ text: st.text, id: st.id }, st.index ?? 0, st.timeout ?? 10, `${tag}-tap`);
          if (!n) { res.passed = false; res.aborted = `tap target not found at step ${i}: ${st.text ?? st.id}`; mark(`!! ${res.aborted}`); break; }
          const [cx, cy] = center(n);
          await dev.sh(`input tap ${cx} ${cy}`, 10);
          mark(`tap ${st.text ?? st.id} at ${cx},${cy}`);
          break;
        }
        case "back":
          await dev.sh("input keyevent KEYCODE_BACK", 10);
          mark("BACK");
          break;
        case "key":
          await dev.sh(`input keyevent ${st.code ?? "KEYCODE_HOME"}`, 10);
          mark(`key ${st.code}`);
          break;
        case "type":
          await dev.sh(`input text ${JSON.stringify((st.value ?? "").replace(/ /g, "%s"))}`, 10);
          mark(`type ${JSON.stringify(st.value)}`);
          break;
        case "swipe":
          await dev.sh(`input swipe ${st.x ?? 540} ${st.y ?? 1800} ${st.x2 ?? 540} ${st.y2 ?? 600} ${st.ms ?? 300}`, 10);
          mark("swipe");
          break;
        case "dump":
          await doDump(st.label ?? `${tag}`, true);
          break;
        case "hold": {
          const end = Date.now() + (st.s ?? 5) * 1000;
          const every = (st.every ?? 2) * 1000;
          let k = 0;
          while (Date.now() < end && !signal?.aborted) {
            const began = Date.now();
            await doDump(`${tag}-h${++k}`);
            await sleep(Math.max(0, every - (Date.now() - began)));
          }
          break;
        }
        case "assert": {
          const nodes = await doDump(st.label ?? `${tag}-assert`, true);
          const label = st.label ?? `assert@s${i}`;
          for (const pat of st.present ?? []) {
            const hit = anyMatch(nodes, pat);
            res.assertions.push({ label: `${label}: present /${pat}/`, ok: !!hit, detail: hit ? fmtNode(hit) : "no visible node matched" });
          }
          for (const pat of st.absent ?? []) {
            const hit = anyMatch(nodes, pat);
            res.assertions.push({ label: `${label}: absent /${pat}/`, ok: !hit, detail: hit ? `found ${fmtNode(hit)}` : "no node matched" });
          }
          break;
        }
        case "fixture": {
          if (!proxy) throw new Error("fixture step needs proxy_start first");
          writeFileSync(proxy.currentFile, st.value ?? st.name ?? "passthrough");
          mark(`fixture ${st.value ?? st.name}`);
          break;
        }
        case "shell": {
          const r = await dev.sh(st.cmd ?? "true", 30);
          mark(`shell ${fix(st.cmd ?? "", 60)} -> ${fix((r.stdout + r.stderr).trim().replace(/\n/g, " ⏎ "), 200)}`);
          break;
        }
        case "setting":
          await dev.putSetting(st.ns ?? "global", st.key ?? "", st.value ?? "");
          mark(`setting ${st.ns ?? "global"} ${st.key}=${st.value}`);
          break;
        case "screenshot": {
          const shotDir = join(outDir, "shots");
          mkdirSync(shotDir, { recursive: true });
          const r = await runBuf(dev.adbPath, dev.args(["exec-out", "screencap", "-p"]));
          const f = join(shotDir, `${p.name}-${st.name ?? tag}.png`);
          writeFileSync(f, r.data);
          mark(`screenshot ${f}`);
          break;
        }
        case "cut":
          cutAt = Math.max(0, (Date.now() - t0) / 1000 - 0.3);
          mark("gif starts here");
          break;
        case "mark":
          mark(st.label ?? "mark");
          break;
      }
      if (res.aborted) break;
      say(`${p.name}: step ${i}/${p.steps.length} ${st.do} ok`);
    }
  } catch (e) {
    res.passed = false;
    res.aborted = errText(e);
    mark(`!! ${res.aborted}`);
  }

  const restore = async () => {
    for (const s of saved) await dev.putSetting(s.ns, s.key, s.value === "null" || s.value === "" ? (s.key === "show_touches" ? "0" : "1.0") : s.value);
    if (saved.length) mark(`restored ${saved.map((s) => `${s.key}=${s.value}`).join(" ")}`);
  };
  if (record) {
   try {
    await sleep(1000);
    await dev.sh("pkill -INT screenrecord || killall -2 screenrecord", 10);
    await new Promise<void>((r) => {
      const t = setTimeout(() => r(), 10_000);
      recorder?.once("close", () => { clearTimeout(t); r(); });
      if (!recorder || recorder.exitCode !== null) { clearTimeout(t); r(); }
    });
    recorder = undefined;
    await sleep(1500);
    mark("recording stopped");
    const mp4 = join(srcDir, mp4Name);
    const pull = await dev.adb(["pull", `/sdcard/${mp4Name}`, mp4], 120);
    if (pull.code !== 0) res.warnings.push(`adb pull failed: ${fix((pull.stderr || pull.stdout).trim(), 200)}`);
    await dev.sh(`rm -f /sdcard/${mp4Name}`, 10);
    if (existsSync(mp4) && statSync(mp4).size > 0) {
      res.mp4 = mp4;
      const g = await makeGif({ src: mp4, out: join(outDir, `${p.name}.gif`), start: p.start ?? cutAt, end: p.end, title: p.title ?? p.name, desc: p.desc, expect: p.expect, fps: p.fps, width: p.width, hold: p.hold }, signal);
      if (g.ok) {
        res.gif = join(outDir, `${p.name}.gif`);
        res.gifInfo = g.info;
        const c = await checkMedia(res.gif);
        if (c) {
          res.check = { frames: Number(c.frames), changedFrames: Number(c.changedFrames) };
          if (res.check.changedFrames === 0) res.warnings.push("GIF is static (0 changed frames): recording probably captured a frozen screen");
        }
      } else res.warnings.push(`gif build failed: ${g.error}`);
    } else {
      res.warnings.push("recording file missing or empty after pull");
    }
   } finally {
    await restore();
   }
  }

  res.passed = res.passed && res.assertions.every((a) => a.ok);
  res.elapsedS = Number(el());
  writeFileSync(join(outDir, `${p.name}.timeline.txt`), res.timeline.join("\n") + "\n");
  writeFileSync(join(outDir, `${p.name}.result.json`), JSON.stringify(res, null, 2));
  return res;
}

function resolveOut(p: { outDir?: string }, cwd: string): string {
  const d = p.outDir ?? ".vqa";
  return isAbsolute(d) ? d : resolve(cwd, d);
}

async function makeGif(o: { src: string; out: string; start?: number; end?: number; title?: string; desc?: string; expect?: string; fps?: number; width?: number; hold?: number }, signal?: AbortSignal): Promise<{ ok: boolean; info?: Record<string, unknown>; error?: string }> {
  const args = [join(HERE, "py", "gif.py"), "--src", o.src, "--out", o.out, "--start", String(o.start ?? 0)];
  if (o.end) args.push("--end", String(o.end));
  if (o.title) args.push("--title", o.title);
  if (o.desc) args.push("--desc", o.desc);
  if (o.expect) args.push("--expect", o.expect);
  if (o.fps) args.push("--fps", String(o.fps));
  if (o.width) args.push("--width", String(o.width));
  if (o.hold !== undefined) args.push("--hold", String(o.hold));
  mkdirSync(dirname(o.out), { recursive: true });
  const r = await run(PY, args, { timeout: 300, signal });
  if (r.code !== 0) return { ok: false, error: fix((r.stderr || r.stdout).trim(), 600) };
  try { return { ok: true, info: JSON.parse(r.stdout.trim().split("\n").pop()!) }; } catch { return { ok: true, info: {} }; }
}

async function checkMedia(path: string): Promise<Record<string, unknown> | undefined> {
  const r = await run(PY, [join(HERE, "py", "frames.py"), "--src", path, "--check"], { timeout: 120 });
  if (r.code !== 0) return undefined;
  try { return JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { return undefined; }
}

function renderResult(r: Result): string {
  const bad = r.assertions.filter((a) => !a.ok);
  const out: string[] = [
    `${r.passed ? "PASS" : "FAIL"} ${r.name} (${r.elapsedS}s)  assertions ${r.assertions.length - bad.length}/${r.assertions.length}${r.aborted ? `  ABORTED: ${r.aborted}` : ""}`,
  ];
  if (r.gif) out.push(`gif: ${r.gif}  ${r.check ? `frames=${r.check.frames} changed=${r.check.changedFrames}` : ""}  ${r.gifInfo?.bytes ? Math.round(Number(r.gifInfo.bytes) / 1024) + " KB" : ""}`);
  if (r.mp4) out.push(`mp4: ${r.mp4}`);
  for (const a of r.assertions) out.push(`  ${a.ok ? "ok  " : "FAIL"} ${a.label}  ${fix(a.detail, 160)}`);
  for (const w of r.warnings) out.push(`warning: ${w}`);
  out.push("timeline:", ...r.timeline.slice(0, 60).map((l) => "  " + fix(l, 300)));
  if (r.timeline.length > 60) out.push(`  … ${r.timeline.length - 60} more lines in <outDir>/${r.name}.timeline.txt`);
  out.push("note: the GIF itself was NOT viewed. Run android_vqa {action:'frames', src:<gif>} and look at the sheet before claiming a visual result.");
  return out.join("\n");
}

// ---------------------------------------------------------------- Settings-UI automation for the mitm CA

async function uiTap(dev: Device, text: string, tries = 5): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const nodes = parseNodes(await dev.dumpXml());
    const n = nodes.find((x) => nodeMatches(x, { text }));
    if (n) { const [cx, cy] = center(n); await dev.sh(`input tap ${cx} ${cy}`, 10); return true; }
    await sleep(1500);
  }
  return false;
}

async function caInstall(dev: Device, say: (m: string) => void): Promise<string> {
  const cert = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.cer");
  if (!existsSync(cert)) throw new Error("mitm CA not generated yet: run proxy_start first");
  await dev.adb(["push", cert, "/sdcard/Download/"], 30);
  await dev.sh("am force-stop com.android.settings", 10);
  await sleep(800);
  await dev.sh("am start -a android.settings.SECURITY_SETTINGS", 15);
  await sleep(2000);
  const steps = ["^More security settings$", "^Encryption (&|and) credentials$", "^Install a certificate$", "^CA certificate$", "^install anyway$", "^mitmproxy-ca-cert\\.cer$"];
  for (const s of steps) {
    if (s.startsWith("^More") && !(await uiTap(dev, s, 2))) {
      await dev.sh("input swipe 540 1800 540 600 300", 10);
      if (!(await uiTap(dev, s))) throw new Error(`ca_install: '${s}' not found (UI differs from API 33 AOSP; do it manually)`);
    } else if (!s.startsWith("^More") && !(await uiTap(dev, s))) {
      throw new Error(`ca_install: '${s}' not found (UI differs from API 33 AOSP; do it manually)`);
    }
    say(`ca_install: ${s}`);
    await sleep(1500);
  }
  await sleep(2000);
  await dev.sh("input keyevent KEYCODE_BACK", 10);
  await sleep(1500);
  if (!(await uiTap(dev, "^Trusted credentials$"))) throw new Error("ca_install: Trusted credentials not found");
  await sleep(1500);
  await uiTap(dev, "^user$");
  await sleep(1500);
  const ok = !!anyMatch(parseNodes(await dev.dumpXml()), "mitmproxy");
  await dev.sh("am force-stop com.android.settings", 10);
  if (!ok) throw new Error("ca_install: finished the flow but no 'mitmproxy' entry in Trusted credentials > User");
  return "mitmproxy CA present in Trusted credentials > User";
}

async function caRemove(dev: Device): Promise<string> {
  await dev.sh("am force-stop com.android.settings", 10);
  await sleep(800);
  await dev.sh("am start -a android.settings.SECURITY_SETTINGS", 15);
  await sleep(2000);
  for (const s of ["^More security settings$", "^Encryption (&|and) credentials$", "^Trusted credentials$", "^user$", "mitmproxy"]) {
    if (!(await uiTap(dev, s))) throw new Error(`ca_remove: '${s}' not found`);
    await sleep(1800);
  }
  if (!(await uiTap(dev, "^(remove|uninstall)$", 2))) {
    await dev.sh("input swipe 540 1700 540 900 300", 10);
    if (!(await uiTap(dev, "^(remove|uninstall)$"))) throw new Error("ca_remove: Remove button not found");
  }
  await sleep(1500);
  await uiTap(dev, "^ok$");
  await sleep(1500);
  await dev.sh("rm -f /sdcard/Download/mitmproxy-ca-cert.cer", 10);
  const gone = !anyMatch(parseNodes(await dev.dumpXml()), "mitmproxy");
  await dev.sh("am force-stop com.android.settings", 10);
  return gone ? "mitmproxy CA removed" : "Remove flow finished but a 'mitmproxy' entry may still be listed; verify manually";
}

// ---------------------------------------------------------------- report

function buildReport(outDir: string): string {
  const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".result.json")).sort() : [];
  if (files.length === 0) throw new Error(`report: no *.result.json in ${outDir}; run scenarios first`);
  const rows: string[] = [];
  let pass = 0;
  for (const f of files) {
    const r = JSON.parse(readFileSync(join(outDir, f), "utf8")) as Result;
    if (r.passed) pass++;
    const bad = r.assertions.filter((a) => !a.ok);
    const kb = r.gifInfo?.bytes ? `${Math.round(Number(r.gifInfo.bytes) / 1024)} KB` : "-";
    const obs = r.assertions.map((a) => `${a.ok ? "✔" : "✘"} ${a.label.replace(/^[^:]*: /, "")}`).join("<br>");
    rows.push(`| ${r.gif ? `![](${basename(r.gif)})` : "-"} | ${r.title ?? r.name} | ${r.desc ?? ""} | ${r.expect ?? ""} | ${r.passed ? "PASS" : "FAIL"}${bad.length ? ` (${bad.length} failed)` : ""}${r.aborted ? ` aborted: ${r.aborted}` : ""} | ${obs} | ${kb} |`);
  }
  const md = [
    `# Validation GIFs`,
    ``,
    `Generated ${new Date().toISOString()}. ${pass}/${files.length} PASS.`,
    ``,
    `Verdicts come from uiautomator assertions taken during the same recording window, not from watching the GIFs. Per-scenario timelines and dumps: \`<name>.timeline.txt\`, \`ui/\`.`,
    ``,
    `| GIF | Scenario | Setup | Expected | Verdict | Checked by dump | Size |`,
    `|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
  ].join("\n");
  writeFileSync(join(outDir, "README.md"), md);
  return `README.md written: ${join(outDir, "README.md")}  (${pass}/${files.length} PASS)`;
}

// ---------------------------------------------------------------- tool

class AndroidVqa {
  constructor(private pi: ExtensionAPI) {}

  init() {
    this.pi.on("session_shutdown", async () => killAll());
    this.pi.registerTool({
      name: "android_vqa",
      label: "Android VQA",
      description:
        "Visual QA on an Android emulator/device with GIF evidence. `run` executes a scripted scenario (launch, wait, tap by text/id, back, hold, assert, mock-fixture switch), records the screen with screenrecord, dumps the UI hierarchy during the same window, checks assertions against those dumps, and builds a captioned GIF (scenario id, setup, expected result). `frames` returns a contact sheet image so YOU can look at a GIF/mp4. Also: ui (list visible nodes), tap/key/type, check (is the GIF static?), report (README table of all runs), proxy_* (mitmproxy that serves fixture JSON for one URL so backend responses can be mocked), ca_install/ca_remove (user CA via Settings UI, validated on API 33 AOSP only).\n" +
        "Ex: android_vqa {action:'run', name:'G03-single', app:{package:'com.x.app'}, title:'G03 single copy', desc:'toggle ON, tap bar, Back', expect:'bar with CTA, tap opens checkout', steps:[{do:'force_stop'},{do:'launch'},{do:'wait',text:'Delivery',timeout:30},{do:'cut'},{do:'assert',present:['QA single copy','^Join$'],absent:['info_icon']},{do:'tap',text:'^Join$'},{do:'sleep',s:3},{do:'assert',present:['Checkout']},{do:'back'},{do:'sleep',s:2}]}. First use: {action:'setup'}.",
      promptSnippet: "Android emulator VQA: scripted scenarios + UI-dump assertions + captioned GIFs + frame contact sheets + fixture mock proxy",
      promptGuidelines: [
        "Use android_vqa {action:'run'} to produce validation GIFs: it records and asserts in the SAME window, so a GIF always has a UI-dump verdict. Do not hand-roll adb screenrecord/ffmpeg/uiautomator shell scripts.",
        "A passing android_vqa run proves only what its assertions check. Before claiming a GIF looks right, call android_vqa {action:'frames', src:'<gif>'} and read the returned sheet image. Say explicitly if you did not.",
        "Write android_vqa assertions as present/absent regexes over visible node text, content-desc and resource-id (e.g. absent:['info_icon'] for an element that must be hidden). Use one assert per visual state, including after Back.",
        "Use android_vqa proxy_start/proxy_fixture/proxy_device to mock one backend URL with fixture JSON files, and always finish with proxy_device {value:'off'}, ca_remove and proxy_stop. Never mock against production accounts without the user's approval.",
        "android_vqa never starts emulators and never installs globally. If no device is connected, ask the user to start one.",
        "After every android_vqa run with animations or settings changes, trust its restore: it puts animation scales and show_touches back. Check with action:'status' if a run was aborted.",
      ],
      parameters: Params,
      executionMode: "sequential",
      execute: async (_id, raw, signal, onUpdate, ctx: ExtensionContext) => {
        const p = raw as ParamsT;
        const say = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }], details: { pending: true } });
        const text = (t: string, details: Record<string, unknown> = {}) => ({
          content: [{ type: "text" as const, text: t.length > MAX_OUT ? t.slice(0, MAX_OUT) + "\n… [truncated]" : t }],
          details,
        });
        const outDir = resolveOut(p, ctx.cwd);
        const abs = (f: string) => (isAbsolute(f) ? f : resolve(ctx.cwd, f));
        const needVenv = () => { if (!hasVenv()) throw new Error(`GIF tooling missing: call android_vqa {action:'setup'} first (venv: ${VENV})`); };

        switch (p.action) {
          case "setup": {
            mkdirSync(HOME_DIR, { recursive: true });
            const py = process.env.PYTHON ?? "python3";
            if (!hasVenv()) {
              say("creating venv…");
              const v = await run(py, ["-m", "venv", VENV], { timeout: 120, signal });
              if (v.code !== 0) throw new Error(`venv failed: ${fix((v.stderr || v.stdout).trim(), 500)}`);
            }
            const pkgs = ["imageio-ffmpeg", "pillow", ...(p.withProxy === false ? [] : ["mitmproxy"])];
            say(`pip install ${pkgs.join(" ")} (may take minutes)…`);
            const i = await run(join(VENV, "bin", "pip"), ["install", "--quiet", ...pkgs], { timeout: 900, signal });
            if (i.code !== 0) throw new Error(`pip failed: ${fix((i.stderr || i.stdout).trim(), 800)}`);
            const ff = await run(PY, ["-c", "import imageio_ffmpeg,PIL;print(imageio_ffmpeg.get_ffmpeg_exe(),PIL.__version__)"], { timeout: 30 });
            return text(`setup ok\nvenv: ${VENV}\nffmpeg/pillow: ${ff.stdout.trim()}\nmitmdump: ${existsSync(MITMDUMP) ? MITMDUMP : "not installed"}`);
          }
          case "status": {
            const lines = [`venv: ${hasVenv() ? VENV : "MISSING (run setup)"}`, `mitmdump: ${existsSync(MITMDUMP) ? "yes" : "no"}`, `adb: ${findAdb()}`];
            try {
              const dev = await resolveDevice(p.serial);
              lines.push(`device: ${dev.serial}`);
              for (const k of ANIM_KEYS) lines.push(`${k}=${await dev.getSetting("global", k)}`);
              lines.push(`show_touches=${await dev.getSetting("system", "show_touches")}`, `http_proxy=${await dev.getSetting("global", "http_proxy")}`);
            } catch (e) { lines.push(`device: ${errText(e)}`); }
            lines.push(proxy ? `proxy: running :${proxy.port} fixture=${safeRead(proxy.currentFile)}` : "proxy: stopped", `recording: ${recorder ? "in progress" : "none"}`);
            return text(lines.join("\n"));
          }
          case "ui": {
            const dev = await resolveDevice(p.serial);
            const nodes = parseNodes(await dev.dumpXml()).filter((n) => n.visible && (n.text || n.desc || n.clickable || n.id));
            const sel = p.find ? nodes.filter((n) => { const re = new RegExp(p.find!, "i"); return re.test(n.text) || re.test(n.desc) || re.test(n.id); }) : nodes;
            return text(`activity: ${await dev.topActivity()}\n${sel.length}/${nodes.length} nodes\n${sel.slice(0, 150).map(fmtNode).join("\n")}`);
          }
          case "tap": {
            const dev = await resolveDevice(p.serial);
            if (p.x !== undefined && p.y !== undefined) { await dev.sh(`input tap ${Math.round(p.x)} ${Math.round(p.y)}`); return text(`tapped ${p.x},${p.y}`); }
            const nodes = parseNodes(await dev.dumpXml()).filter((n) => nodeMatches(n, { text: p.text, id: p.id }));
            const n = nodes[p.index ?? 0];
            if (!n) throw new Error(`no visible node for text=${p.text ?? ""} id=${p.id ?? ""} (${nodes.length} matches)`);
            const [cx, cy] = center(n);
            await dev.sh(`input tap ${cx} ${cy}`);
            return text(`tapped ${fmtNode(n)} at ${cx},${cy}`);
          }
          case "key": {
            const dev = await resolveDevice(p.serial);
            await dev.sh(`input keyevent ${p.code ?? "KEYCODE_BACK"}`);
            return text(`key ${p.code ?? "KEYCODE_BACK"}`);
          }
          case "type": {
            const dev = await resolveDevice(p.serial);
            await dev.sh(`input text ${JSON.stringify((p.value ?? "").replace(/ /g, "%s"))}`);
            return text("typed");
          }
          case "run": {
            const dev = await resolveDevice(p.serial);
            const r = await runScenario(p, dev, ctx.cwd, signal, say);
            return text(renderResult(r), { result: { ...r, timeline: undefined } });
          }
          case "gif": {
            needVenv();
            if (!p.src) throw new Error("gif: 'src' (mp4) is required");
            const out = abs(p.name ? join(outDir, `${p.name}.gif`) : p.src.replace(/\.[^.]+$/, ".gif"));
            const g = await makeGif({ src: abs(p.src), out, start: p.start, end: p.end, title: p.title, desc: p.desc, expect: p.expect, fps: p.fps, width: p.width, hold: p.hold }, signal);
            if (!g.ok) throw new Error(`gif failed: ${g.error}`);
            return text(`gif: ${out}\n${JSON.stringify(g.info)}`);
          }
          case "check": {
            needVenv();
            if (!p.src) throw new Error("check: 'src' is required");
            const c = await checkMedia(abs(p.src));
            if (!c) throw new Error("check failed");
            const warn = Number(c.changedFrames) === 0 ? "\nWARNING: static, no frame differs from the previous one" : "";
            return text(`${JSON.stringify(c)}${warn}`);
          }
          case "frames": {
            needVenv();
            if (!p.src) throw new Error("frames: 'src' (gif or mp4) is required");
            const out = join(outDir, "sheets", `${basename(p.src).replace(/\.[^.]+$/, "")}.sheet.png`);
            mkdirSync(dirname(out), { recursive: true });
            const r = await run(PY, [join(HERE, "py", "frames.py"), "--src", abs(p.src), "--out", out, "--count", String(p.count ?? 8)], { timeout: 180, signal });
            if (r.code !== 0) throw new Error(`frames failed: ${fix((r.stderr || r.stdout).trim(), 600)}`);
            return {
              content: [
                { type: "text" as const, text: `contact sheet: ${out}\n${r.stdout.trim()}\nFrames are evenly spaced; cell label is #frame/total.` },
                { type: "image" as const, data: readFileSync(out).toString("base64"), mimeType: "image/png" },
              ],
              details: { out },
            };
          }
          case "report":
            return text(buildReport(outDir));
          case "proxy_start": {
            if (!existsSync(MITMDUMP)) throw new Error("mitmdump missing: call setup (withProxy not false)");
            if (proxy) throw new Error(`proxy already running on :${proxy.port}`);
            if (!p.fixturesDir || !p.match) throw new Error("proxy_start needs fixturesDir and match");
            const port = p.port ?? 8080;
            mkdirSync(outDir, { recursive: true });
            const currentFile = join(outDir, ".current-fixture");
            const logFile = join(outDir, "proxy.log");
            writeFileSync(currentFile, "passthrough");
            writeFileSync(logFile, "");
            const proc = spawn(MITMDUMP, ["-q", "-s", join(HERE, "py", "mock_addon.py"), "--listen-port", String(port)], {
              env: { ...process.env, VQA_FIXTURES: abs(p.fixturesDir), VQA_MATCH: p.match, VQA_CURRENT: currentFile, VQA_LOG: logFile, VQA_NEEDLES: (p.needles ?? []).join(",") },
              stdio: "ignore",
            });
            proc.on("exit", () => { if (proxy?.proc === proc) proxy = undefined; });
            if (!(await waitPort(port, 20_000))) { proc.kill("SIGTERM"); throw new Error(`mitmdump did not open :${port} in 20s`); }
            proxy = { proc, port, currentFile, logFile, fixturesDir: abs(p.fixturesDir) };
            const fx = existsSync(proxy.fixturesDir) ? readdirSync(proxy.fixturesDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
            return text(`proxy up :${port}, mocking URLs containing '${p.match}', fixture=passthrough\nfixtures: ${fx.join(", ") || "(none found)"} (+ 404, passthrough)\nnext: ca_install (once), proxy_device {value:'on'}`);
          }
          case "proxy_fixture": {
            if (!proxy) throw new Error("proxy not running");
            const name = p.value ?? p.name;
            if (!name) throw new Error("proxy_fixture needs value (fixture name | 404 | passthrough)");
            if (!["404", "passthrough"].includes(name) && !existsSync(join(proxy.fixturesDir, name + ".json"))) throw new Error(`fixture '${name}.json' not found in ${proxy.fixturesDir}`);
            writeFileSync(proxy.currentFile, name);
            return text(`fixture=${name}`);
          }
          case "proxy_log": {
            if (!proxy) throw new Error("proxy not running");
            const l = readFileSync(proxy.logFile, "utf8").split("\n").filter(Boolean);
            return text(l.slice(-(p.lines ?? 30)).join("\n") || "(empty)");
          }
          case "proxy_stop": {
            if (!proxy) return text("proxy was not running");
            proxy.proc.kill("SIGTERM");
            proxy = undefined;
            return text("proxy stopped (device proxy setting is unchanged: run proxy_device {value:'off'})");
          }
          case "proxy_device": {
            const dev = await resolveDevice(p.serial);
            if ((p.value ?? "on") === "off") { await dev.putSetting("global", "http_proxy", ":0"); return text("device http_proxy=:0"); }
            const port = p.port ?? proxy?.port ?? 8080;
            const host = p.host ?? "10.0.2.2";
            await dev.putSetting("global", "http_proxy", `${host}:${port}`);
            return text(`device http_proxy=${host}:${port}${host === "10.0.2.2" ? " (emulator host alias)" : ""}`);
          }
          case "ca_install": {
            const dev = await resolveDevice(p.serial);
            return text(await caInstall(dev, say));
          }
          case "ca_remove": {
            const dev = await resolveDevice(p.serial);
            return text(await caRemove(dev));
          }
        }
      },
      renderCall: (args, theme) => {
        const a = args as ParamsT;
        const extra = a?.name ?? a?.src ?? a?.text ?? a?.value ?? "";
        return new Text(theme.fg("toolTitle", theme.bold("android_vqa ")) + theme.fg("accent", a?.action ?? "?") + (extra ? theme.fg("dim", ` ${extra}`) : ""), 0, 0);
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", (result.content[0] as { text?: string })?.text ?? "working…"), 0, 0);
        const first = result.content[0];
        const content = (first && "text" in first ? first.text : "") ?? "";
        const lines = content.split("\n");
        if (!expanded && lines.length > 18) return new Text(lines.slice(0, 18).join("\n") + `\n… ${lines.length - 18} more lines`, 0, 0);
        return new Text(content, 0, 0);
      },
    });
  }
}

function safeRead(f: string): string {
  try { return readFileSync(f, "utf8").trim(); } catch { return "?"; }
}

export default function (pi: ExtensionAPI) {
  new AndroidVqa(pi).init();
}
