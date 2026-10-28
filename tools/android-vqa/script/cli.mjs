import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { caInstall, caRemove } from "./ca.mjs";
import { ANIM_KEYS, resolveDevice } from "./device.mjs";
import { checkMedia, contactSheet, makeGif, needVenv } from "./media.mjs";
import { absPath, findAdb, hasVenv, mitmdumpPath, proxyStateFile, pyPath, resolveOut, venvDir, vqaHome } from "./paths.mjs";
import { VqaError, errText, run, usageErr } from "./proc.mjs";
import { proxyFixture, proxyInfo, proxyLog, proxyStart, proxyStop, readCurrentFixture } from "./proxy.mjs";
import { buildReport } from "./report.mjs";
import { NAME_RE, parseScenarios, renderResult, runScenario, validateScenario } from "./scenario.mjs";
import { center, fmtNode, listNodes, nodeMatches, parseNodes } from "./ui.mjs";

/** Superset of every flag. Each command declares which subset it accepts (typos fail loudly). */
const OPTION_TYPES = {
  serial: { type: "string" },
  "out-dir": { type: "string" },
  find: { type: "string" },
  text: { type: "string" },
  id: { type: "string" },
  index: { type: "string" },
  x: { type: "string" },
  y: { type: "string" },
  code: { type: "string" },
  value: { type: "string" },
  scenario: { type: "string" },
  name: { type: "string" },
  title: { type: "string" },
  desc: { type: "string" },
  expect: { type: "string" },
  package: { type: "string" },
  activity: { type: "string" },
  "record-limit": { type: "string" },
  "no-record": { type: "boolean" },
  "no-animations": { type: "boolean" },
  "no-touches": { type: "boolean" },
  fps: { type: "string" },
  width: { type: "string" },
  hold: { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
  src: { type: "string" },
  count: { type: "string" },
  "fixtures-dir": { type: "string" },
  match: { type: "string" },
  port: { type: "string" },
  needle: { type: "string", multiple: true },
  host: { type: "string" },
  lines: { type: "string" },
  "no-proxy": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const GLOBAL_OPTS = ["json", "help"];
const GIF_OPTS = ["title", "desc", "expect", "fps", "width", "hold", "start", "end"];

export function num(v, name, { int = false, min } = {}) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === "" || !Number.isFinite(n) || (int && !Number.isInteger(n)) || (min !== undefined && n < min)) {
    throw usageErr(`--${name} must be ${int ? "an integer" : "a number"}${min !== undefined ? ` >= ${min}` : ""}, got "${v}".`);
  }
  return n;
}

const srcArg = (v, pos, cmd) => {
  const s = v.src ?? pos[0];
  if (!s) throw usageErr(`${cmd}: source file is required (positional or --src)`);
  return absPath(s);
};

/** Builds the scenario list for `run` from --scenario plus CLI overrides. Exported for tests. */
export function buildScenarios(v, readInput = (f) => readFileSync(f === "-" ? 0 : absPath(f), "utf8")) {
  if (!v.scenario) throw usageErr("run: --scenario <file.json> (or - for stdin) is required");
  let text;
  try {
    text = readInput(v.scenario);
  } catch (e) {
    throw usageErr(`run: cannot read scenario ${v.scenario}: ${errText(e)}`);
  }
  const list = parseScenarios(text, v.scenario === "-" ? "stdin" : v.scenario);
  if (list.length > 1 && v.name) throw usageErr("run: --name cannot be used with a scenario list");
  const over = {};
  for (const k of ["name", "title", "desc", "expect"]) if (v[k] !== undefined) over[k] = v[k];
  const n = (k, key, o) => { const x = num(v[k], k, o); if (x !== undefined) over[key] = x; };
  n("record-limit", "recordLimit", { min: 1 });
  n("fps", "fps", { int: true, min: 1 });
  n("width", "width", { int: true, min: 16 });
  n("hold", "hold", { min: 0 });
  n("start", "start", { min: 0 });
  n("end", "end", { min: 0 });
  if (v["no-record"]) over.noRecord = true;
  if (v["no-animations"]) over.animations = false;
  if (v["no-touches"]) over.touches = false;
  return list.map((sc, i) => {
    if (!sc || typeof sc !== "object" || Array.isArray(sc)) throw usageErr(`scenario #${i + 1} must be a JSON object`);
    const merged = { ...sc, ...over };
    if (v.package) merged.app = { ...(sc.app ?? {}), package: v.package };
    if (v.activity) merged.app = { ...(merged.app ?? {}), activity: v.activity };
    return validateScenario(merged, list.length > 1 ? `scenario #${i + 1}` : "scenario");
  });
}

/* ------------------------------------------------------------------ commands */

const COMMANDS = {
  setup: {
    usage: "setup [--no-proxy]",
    desc: "Create the private venv (imageio-ffmpeg, pillow, mitmproxy unless --no-proxy). Nothing is installed globally. May take minutes.",
    opts: ["no-proxy"],
    async run({ v, say }) {
      const VENV = venvDir();
      mkdirSync(vqaHome(), { recursive: true });
      const py = process.env.PYTHON ?? "python3";
      if (!hasVenv()) {
        say(`creating venv ${VENV}…`);
        const r = await run(py, ["-m", "venv", VENV], { timeout: 120 });
        if (r.code !== 0) throw new VqaError(`venv failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
      }
      const pkgs = ["imageio-ffmpeg", "pillow", ...(v["no-proxy"] ? [] : ["mitmproxy"])];
      say(`pip install ${pkgs.join(" ")} (may take minutes)…`);
      const i = await run(join(VENV, "bin", "pip"), ["install", "--quiet", ...pkgs], { timeout: 900 });
      if (i.code !== 0) throw new VqaError(`pip failed: ${(i.stderr || i.stdout).trim().slice(0, 800)}`);
      const ff = await run(pyPath(), ["-c", "import imageio_ffmpeg,PIL;print(imageio_ffmpeg.get_ffmpeg_exe(),PIL.__version__)"], { timeout: 30 });
      const mitm = existsSync(mitmdumpPath()) ? mitmdumpPath() : null;
      return { data: { venv: VENV, ffmpegPillow: ff.stdout.trim(), mitmdump: mitm }, text: `setup ok\nvenv: ${VENV}\nffmpeg/pillow: ${ff.stdout.trim()}\nmitmdump: ${mitm ?? "not installed"}` };
    },
  },

  status: {
    usage: "status [--serial S]",
    desc: "Venv, adb, device, animation scales, show_touches, http_proxy, proxy state, screenrecord running on device.",
    opts: ["serial"],
    async run({ v }) {
      const d = { venv: hasVenv() ? venvDir() : null, mitmdump: existsSync(mitmdumpPath()), adb: findAdb(), device: null, settings: {}, proxy: null, recording: null };
      const lines = [`venv: ${d.venv ?? `MISSING (run setup; expected ${venvDir()})`}`, `mitmdump: ${d.mitmdump ? "yes" : "no"}`, `adb: ${d.adb}`];
      try {
        const dev = await resolveDevice(v.serial);
        d.device = dev.serial;
        lines.push(`device: ${dev.serial}`);
        for (const k of ANIM_KEYS) lines.push(`${k}=${(d.settings[k] = await dev.getSetting("global", k))}`);
        d.settings.show_touches = await dev.getSetting("system", "show_touches");
        d.settings.http_proxy = await dev.getSetting("global", "http_proxy");
        lines.push(`show_touches=${d.settings.show_touches}`, `http_proxy=${d.settings.http_proxy}`);
        const rec = await dev.sh("pgrep screenrecord", 10);
        d.recording = rec.stdout.trim() ? "in progress on device" : "none";
      } catch (e) {
        d.deviceError = errText(e);
        lines.push(`device: ${d.deviceError}`);
      }
      const p = proxyInfo();
      if (p.running) {
        d.proxy = { ...p.state, fixture: readCurrentFixture(p.state) };
        lines.push(`proxy: running :${p.state.port} pid ${p.state.pid} fixture=${d.proxy.fixture} match='${p.state.match}'`);
      } else {
        d.proxy = { running: false, stale: p.stale };
        lines.push(`proxy: stopped${p.stale ? ` (${p.stale})` : ""}`);
      }
      if (d.recording) lines.push(`recording: ${d.recording}`);
      return { data: d, text: lines.join("\n") };
    },
  },

  ui: {
    usage: "ui [--find <regex>] [--serial S]",
    desc: "Foreground activity and visible nodes (bounds, id, text, desc, clickable/checked). --find filters by regex over text/desc/id. Max 150 lines.",
    opts: ["serial", "find"],
    async run({ v }) {
      if (v.find !== undefined) try { new RegExp(v.find, "i"); } catch (e) { throw usageErr(`--find: invalid regex: ${e.message}`); }
      const dev = await resolveDevice(v.serial);
      const { all, sel } = listNodes(parseNodes(await dev.dumpXml()), v.find);
      const activity = await dev.topActivity();
      return {
        data: { activity, total: all.length, nodes: sel.slice(0, 150).map((n) => ({ ...n, center: center(n) })) },
        text: `activity: ${activity}\n${sel.length}/${all.length} nodes\n${sel.slice(0, 150).map(fmtNode).join("\n")}`,
      };
    },
  },

  tap: {
    usage: "tap (--text <regex> | --id <res-id> [--index N] | --x N --y N) [--serial S]",
    desc: "Tap the center of the first (or --index'th) visible node matching --text (case-insensitive regex on text/desc) and/or --id, or tap coordinates. No retry: use `ui` first.",
    opts: ["serial", "text", "id", "index", "x", "y"],
    async run({ v }) {
      const x = num(v.x, "x", { min: 0 });
      const y = num(v.y, "y", { min: 0 });
      const index = num(v.index, "index", { int: true, min: 0 }) ?? 0;
      if ((x === undefined) !== (y === undefined)) throw usageErr("tap: --x and --y go together");
      if (x === undefined && !v.text && !v.id) throw usageErr("tap: give --text, --id, or --x and --y");
      if (v.text) try { new RegExp(v.text, "i"); } catch (e) { throw usageErr(`--text: invalid regex: ${e.message}`); }
      const dev = await resolveDevice(v.serial);
      if (x !== undefined) {
        await dev.sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
        return { data: { x, y }, text: `tapped ${x},${y}` };
      }
      const nodes = parseNodes(await dev.dumpXml()).filter((n) => nodeMatches(n, { text: v.text, id: v.id }));
      const n = nodes[index];
      if (!n) throw new VqaError(`no visible node for text=${v.text ?? ""} id=${v.id ?? ""} (${nodes.length} matches)`);
      const [cx, cy] = center(n);
      await dev.sh(`input tap ${cx} ${cy}`);
      return { data: { node: n, x: cx, y: cy }, text: `tapped ${fmtNode(n)} at ${cx},${cy}` };
    },
  },

  key: {
    usage: "key [<KEYCODE_*|number>] [--code C] [--serial S]",
    desc: "Send a key event (default KEYCODE_BACK).",
    opts: ["serial", "code"],
    async run({ v, pos }) {
      const code = v.code ?? pos[0] ?? "KEYCODE_BACK";
      if (!/^(KEYCODE_[A-Z0-9_]+|\d+)$/.test(code)) throw usageErr(`key: expected KEYCODE_* or a number, got "${code}"`);
      const dev = await resolveDevice(v.serial);
      await dev.sh(`input keyevent ${code}`);
      return { data: { code }, text: `key ${code}` };
    },
  },

  type: {
    usage: "type <text> | --value <text> [--serial S]",
    desc: "Type text into the focused field (spaces sent as %s).",
    opts: ["serial", "value"],
    async run({ v, pos }) {
      const text = v.value ?? (pos.length ? pos.join(" ") : undefined);
      if (text === undefined) throw usageErr("type: text is required");
      const dev = await resolveDevice(v.serial);
      await dev.sh(`input text ${JSON.stringify(text.replace(/ /g, "%s"))}`);
      return { data: { typed: text }, text: "typed" };
    },
  },

  run: {
    usage: "run --scenario <file.json|-> [--name N] [--title T] [--desc D] [--expect E] [--package P] [--activity A] [--no-record] [--no-animations] [--no-touches] [--record-limit S] [--fps N] [--width PX] [--hold S] [--start S] [--end S] [--out-dir D] [--serial S]",
    desc: "Run a scenario (or a JSON list of scenarios) from a file or stdin: record + dump + assert + captioned GIF. Flags override scenario fields. Exit 1 if any scenario FAILs (result still printed).",
    opts: ["serial", "out-dir", "scenario", "name", "package", "activity", "record-limit", "no-record", "no-animations", "no-touches", ...GIF_OPTS],
    async run({ v, say, signal }) {
      const scenarios = buildScenarios(v);
      const dev = await resolveDevice(v.serial);
      const outDir = resolveOut(v["out-dir"]);
      const results = [];
      for (const sc of scenarios) {
        if (signal.aborted) break;
        say(`${sc.name}: starting (${sc.steps.length} steps${sc.noRecord ? ", no recording" : ""})`);
        results.push(await runScenario(sc, dev, outDir, { signal, say }));
      }
      const failed = results.filter((r) => !r.passed).length;
      const text = results.map(renderResult).join("\n\n") + (results.length > 1 ? `\n\n${results.length - failed}/${results.length} PASS` : "");
      return { data: scenarios.length === 1 ? results[0] : results, text, exitCode: signal.aborted ? 130 : failed ? 1 : 0 };
    },
  },

  gif: {
    usage: "gif <src.mp4> [--name N] [--title T] [--desc D] [--expect E] [--fps N] [--width PX] [--hold S] [--start S] [--end S] [--out-dir D]",
    desc: "Build a captioned GIF from an mp4. Output <out-dir>/<name>.gif with --name, else next to the source.",
    opts: ["src", "out-dir", "name", ...GIF_OPTS],
    async run({ v, pos }) {
      needVenv();
      const src = srcArg(v, pos, "gif");
      if (v.name && !NAME_RE.test(v.name)) throw usageErr(`--name may only contain letters, digits, '.', '_' and '-'`);
      const out = v.name ? join(resolveOut(v["out-dir"]), `${v.name}.gif`) : src.replace(/\.[^./]+$/, "") + ".gif";
      if (out === src) throw usageErr("gif: output would overwrite the source; pass --name");
      const g = await makeGif({
        src, out, start: num(v.start, "start", { min: 0 }), end: num(v.end, "end", { min: 0 }), title: v.title, desc: v.desc, expect: v.expect,
        fps: num(v.fps, "fps", { int: true, min: 1 }), width: num(v.width, "width", { int: true, min: 16 }), hold: num(v.hold, "hold", { min: 0 }),
      });
      if (!g.ok) throw new VqaError(`gif failed: ${g.error}`);
      return { data: { gif: out, ...g.info }, text: `gif: ${out}\n${JSON.stringify(g.info)}` };
    },
  },

  check: {
    usage: "check <src.gif|mp4>",
    desc: "Frame stats of a GIF/mp4; warns when it is static (no frame differs from the previous one).",
    opts: ["src"],
    async run({ v, pos }) {
      needVenv();
      const c = await checkMedia(srcArg(v, pos, "check"));
      if (!c) throw new VqaError("check failed");
      const isStatic = Number(c.changedFrames) === 0;
      return { data: { ...c, static: isStatic }, text: `${JSON.stringify(c)}${isStatic ? "\nWARNING: static, no frame differs from the previous one" : ""}` };
    },
  },

  frames: {
    usage: "frames <src.gif|mp4> [--count N] [--out-dir D]",
    desc: "Write a contact sheet PNG (evenly spaced frames, label #frame/total) to <out-dir>/sheets/<base>.sheet.png and print its path. Read that PNG to actually see the GIF.",
    opts: ["src", "out-dir", "count"],
    async run({ v, pos }) {
      needVenv();
      const src = srcArg(v, pos, "frames");
      const count = num(v.count, "count", { int: true, min: 1 }) ?? 8;
      const out = join(resolveOut(v["out-dir"]), "sheets", `${basename(src).replace(/\.[^.]+$/, "")}.sheet.png`);
      const s = await contactSheet(src, out, count);
      return {
        data: { sheet: out, ...s.info },
        text: `contact sheet: ${out}\n${s.raw}\nFrames are evenly spaced; cell label is #frame/total. Read ${out} to look at it before claiming a visual result.`,
      };
    },
  },

  report: {
    usage: "report [--out-dir D]",
    desc: "Write <out-dir>/README.md: one row per *.result.json (GIF, setup, expected, verdict, checked assertions, size).",
    opts: ["out-dir"],
    async run({ v }) {
      const r = buildReport(resolveOut(v["out-dir"]));
      return { data: r, text: `README.md written: ${r.out}  (${r.pass}/${r.total} PASS)` };
    },
  },

  "proxy start": {
    usage: "proxy start --fixtures-dir <dir> --match <url-substring> [--port 8080] [--needle s ...] [--out-dir D]",
    desc: "Start a detached mitmdump that serves <fixtures-dir>/<name>.json for URLs containing --match (initial fixture: passthrough). Requests whose body contains a --needle are logged. State: <ANDROID_VQA_HOME>/proxy.json.",
    opts: ["fixtures-dir", "match", "port", "needle", "out-dir"],
    async run({ v }) {
      if (!v["fixtures-dir"] || !v.match) throw usageErr("proxy start needs --fixtures-dir and --match");
      const port = num(v.port, "port", { int: true, min: 1 }) ?? 8080;
      const { state, fixtures } = await proxyStart({ fixturesDir: absPath(v["fixtures-dir"]), match: v.match, port, needles: v.needle ?? [], outDir: resolveOut(v["out-dir"]) });
      return {
        data: { ...state, fixtures },
        text: `proxy up :${port} (pid ${state.pid}), mocking URLs containing '${v.match}', fixture=passthrough\nfixtures: ${fixtures.join(", ") || "(none found)"} (+ 404, passthrough)\nlog: ${state.logFile}\nnext: ca install (once), proxy device on`,
      };
    },
  },

  "proxy fixture": {
    usage: "proxy fixture <name|404|passthrough>",
    desc: "Switch the fixture served for the matched URL (takes effect on the next request).",
    opts: ["value"],
    async run({ v, pos }) {
      const name = proxyFixture(v.value ?? pos[0]);
      return { data: { fixture: name }, text: `fixture=${name}` };
    },
  },

  "proxy log": {
    usage: "proxy log [--lines 30]",
    desc: "Tail the proxy decision log (MATCH/NEEDLE lines with request bodies). Contains tokens: redact before sharing.",
    opts: ["lines"],
    async run({ v }) {
      const l = proxyLog(num(v.lines, "lines", { int: true, min: 1 }) ?? 30);
      return { data: l, text: l.join("\n") || "(empty)" };
    },
  },

  "proxy status": {
    usage: "proxy status",
    desc: "Whether our mitmdump is running (pid verified), its port, match and current fixture. Removes stale state.",
    opts: [],
    async run() {
      const p = proxyInfo();
      if (!p.running) return { data: { running: false, stale: p.stale }, text: `proxy: stopped${p.stale ? ` (${p.stale})` : ""}` };
      const fixture = readCurrentFixture(p.state);
      return { data: { running: true, ...p.state, fixture }, text: `proxy: running :${p.state.port} pid ${p.state.pid} fixture=${fixture} match='${p.state.match}'\nfixtures: ${p.state.fixturesDir}\nlog: ${p.state.logFile}\nstate: ${proxyStateFile()}` };
    },
  },

  "proxy stop": {
    usage: "proxy stop",
    desc: "Stop our mitmdump (only after verifying the pid is our mitmdump). Does not touch the device proxy setting.",
    opts: [],
    async run() {
      const r = await proxyStop();
      return { data: r, text: r.message };
    },
  },

  "proxy device": {
    usage: "proxy device <on|off> [--host 10.0.2.2] [--port N] [--serial S]",
    desc: "Set the device global http_proxy to host:port (on; default port from the running proxy, else 8080) or :0 (off).",
    opts: ["serial", "host", "port", "value"],
    async run({ v, pos }) {
      const mode = v.value ?? pos[0] ?? "on";
      if (mode !== "on" && mode !== "off") throw usageErr(`proxy device: expected on or off, got "${mode}"`);
      const portFlag = num(v.port, "port", { int: true, min: 1 });
      const dev = await resolveDevice(v.serial);
      if (mode === "off") {
        await dev.putSetting("global", "http_proxy", ":0");
        return { data: { http_proxy: ":0" }, text: "device http_proxy=:0" };
      }
      const p = proxyInfo();
      const port = portFlag ?? (p.running ? p.state.port : 8080);
      const host = v.host ?? "10.0.2.2";
      await dev.putSetting("global", "http_proxy", `${host}:${port}`);
      return { data: { http_proxy: `${host}:${port}` }, text: `device http_proxy=${host}:${port}${host === "10.0.2.2" ? " (emulator host alias)" : ""}` };
    },
  },

  "ca install": {
    usage: "ca install [--serial S]",
    desc: "Install the mitmproxy CA as a user credential through the Settings UI (validated on API 33 AOSP only; needs `proxy start` once to generate the CA).",
    opts: ["serial"],
    async run({ v, say }) {
      const dev = await resolveDevice(v.serial);
      const msg = await caInstall(dev, say);
      return { data: { message: msg }, text: msg };
    },
  },

  "ca remove": {
    usage: "ca remove [--serial S]",
    desc: "Remove the mitmproxy user CA through the Settings UI and delete the pushed cert from /sdcard/Download.",
    opts: ["serial"],
    async run({ v }) {
      const dev = await resolveDevice(v.serial);
      const msg = await caRemove(dev);
      return { data: { message: msg }, text: msg };
    },
  },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

/* ------------------------------------------------------------------ help */

function helpText(cmdName) {
  if (cmdName && COMMANDS[cmdName]) {
    const c = COMMANDS[cmdName];
    return `${c.desc}\n\nUsage: android-vqa ${c.usage}\nFlags valid for every command: --json, --help`;
  }
  const rows = Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.desc}`);
  return [
    "android-vqa: visual QA on an Android emulator/device with captioned GIF evidence.",
    "",
    "Device: --serial, else ANDROID_SERIAL, else the only connected device. adb from ADB, ANDROID_HOME, ANDROID_SDK_ROOT or the default SDK path. Never starts emulators.",
    `Tooling: private venv at ${venvDir()} (ANDROID_VQA_HOME overrides the home dir). Artifacts: --out-dir, default ./.vqa.`,
    "Output: compact text by default, --json for structured data. Progress and errors go to stderr. Exit 0 ok, 1 runtime error or FAILed scenario, 2 usage error, 130 interrupted.",
    "",
    "Commands:",
    ...rows,
  ].join("\n");
}

/* ------------------------------------------------------------------ main */

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const err = (s) => stderr.write(s.endsWith("\n") ? s : `${s}\n`);
  const say = (m) => err(m);
  let json = argv.includes("--json");
  const ac = new AbortController();
  let sigints = 0;
  const onSigint = () => {
    sigints++;
    if (sigints === 1) {
      ac.abort();
      err("interrupted: stopping and restoring device settings (Ctrl-C again to force quit)…");
    } else {
      err("forced quit: device settings may not be restored; check with `android-vqa status`.");
      process.exit(130);
    }
  };
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTION_TYPES, allowPositionals: true, strict: true });
    } catch (e) {
      throw usageErr(`${e.message}\nRun "android-vqa --help" for usage.`);
    }
    const { values: v, positionals } = parsed;
    json = !!v.json;
    if (!positionals.length) {
      out(helpText());
      return 0;
    }
    const two = positionals.slice(0, 2).join(" ");
    const name = COMMANDS[two] ? two : COMMANDS[positionals[0]] ? positionals[0] : null;
    if (!name) {
      const known = Object.keys(COMMANDS).filter((k) => k.startsWith(positionals[0]));
      throw usageErr(`Unknown command "${two}".${known.length ? ` Did you mean: ${known.join(", ")}?` : ""}\nRun "android-vqa --help".`);
    }
    if (v.help) {
      out(helpText(name));
      return 0;
    }
    const cmd = COMMANDS[name];
    const allowed = new Set([...cmd.opts, ...GLOBAL_OPTS]);
    const extra = Object.keys(v).filter((k) => !allowed.has(k));
    if (extra.length) throw usageErr(`Flag(s) not valid for "${name}": ${extra.map((k) => `--${k}`).join(", ")}.\nUsage: android-vqa ${cmd.usage}`);
    const pos = positionals.slice(name.split(" ").length);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);
    const result = await cmd.run({ v, pos, say, signal: ac.signal });
    out(json ? JSON.stringify(result.data) : result.text);
    return result.exitCode ?? (ac.signal.aborted ? 130 : 0);
  } catch (e) {
    const message = e?.message ?? String(e);
    err(json ? JSON.stringify({ error: message, code: e?.code }) : `Error: ${message}`);
    return e?.code === "usage" ? 2 : ac.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
  }
}
