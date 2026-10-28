/**
 * Scenario validation and engine. `run` records the screen AND dumps the UI hierarchy during the same
 * window, evaluates assertions against those dumps, and builds a captioned GIF.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANIM_KEYS } from "./device.mjs";
import { checkMedia, makeGif } from "./media.mjs";
import { hasVenv } from "./paths.mjs";
import { VqaError, errText, runBuf, sleep, usageErr } from "./proc.mjs";
import { requireProxy } from "./proxy.mjs";
import { center, evaluateAssert, fix, fmtNode, nodeMatches, parseNodes } from "./ui.mjs";

export const STEP_KINDS = ["launch", "force_stop", "sleep", "wait", "tap", "back", "key", "type", "swipe", "dump", "hold", "assert",
  "fixture", "shell", "setting", "screenshot", "cut", "mark"];

const STR = "string";
const NUM = "number";
const STRS = "string[]";
const BOOL = "boolean";

export const STEP_FIELDS = {
  do: STR, text: STR, id: STR, index: NUM, x: NUM, y: NUM, x2: NUM, y2: NUM, ms: NUM, s: NUM, every: NUM, timeout: NUM,
  label: STR, code: STR, value: STR, name: STR, cmd: STR, ns: STR, key: STR, present: STRS, absent: STRS,
};

export const SCENARIO_FIELDS = {
  name: STR, title: STR, desc: STR, expect: STR, app: "app", steps: "steps",
  recordLimit: NUM, noRecord: BOOL, animations: BOOL, touches: BOOL, fps: NUM, width: NUM, hold: NUM, start: NUM, end: NUM,
};

export const NAME_RE = /^[A-Za-z0-9._-]+$/;

const typeOk = (v, t) =>
  t === STRS ? Array.isArray(v) && v.every((x) => typeof x === "string") : t === NUM ? typeof v === "number" && Number.isFinite(v) : typeof v === t;

function checkRegex(pat, where) {
  try {
    new RegExp(pat, "i");
  } catch (e) {
    throw usageErr(`${where}: invalid regex /${pat}/: ${e.message}`);
  }
}

/** Throws a usage error describing the first problem. Returns the scenario unchanged. */
export function validateScenario(sc, where = "scenario") {
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) throw usageErr(`${where} must be a JSON object`);
  for (const [k, v] of Object.entries(sc)) {
    const t = SCENARIO_FIELDS[k];
    if (!t) throw usageErr(`${where}: unknown field '${k}' (allowed: ${Object.keys(SCENARIO_FIELDS).join(", ")})`);
    if (t === "app") {
      if (!v || typeof v !== "object" || typeof v.package !== "string" || !v.package) throw usageErr(`${where}: app must be {"package": "...", "activity"?: "..."}`);
      if (v.activity !== undefined && typeof v.activity !== "string") throw usageErr(`${where}: app.activity must be a string`);
      const extra = Object.keys(v).filter((x) => x !== "package" && x !== "activity");
      if (extra.length) throw usageErr(`${where}: unknown app field(s): ${extra.join(", ")}`);
    } else if (t !== "steps" && !typeOk(v, t)) throw usageErr(`${where}: '${k}' must be a ${t}`);
  }
  if (!sc.name) throw usageErr(`${where}: 'name' is required`);
  if (!NAME_RE.test(sc.name)) throw usageErr(`${where}: name '${sc.name}' may only contain letters, digits, '.', '_' and '-' (used in file names and on /sdcard)`);
  if (!Array.isArray(sc.steps) || sc.steps.length === 0) throw usageErr(`${where}: 'steps' is required (non-empty array)`);
  sc.steps.forEach((st, i) => {
    const w = `${where}: step ${i + 1}`;
    if (!st || typeof st !== "object" || Array.isArray(st)) throw usageErr(`${w} must be an object`);
    for (const [k, v] of Object.entries(st)) {
      const t = STEP_FIELDS[k];
      if (!t) throw usageErr(`${w}: unknown field '${k}'`);
      if (!typeOk(v, t)) throw usageErr(`${w}: '${k}' must be a ${t}`);
    }
    if (!STEP_KINDS.includes(st.do)) throw usageErr(`${w}: 'do' must be one of ${STEP_KINDS.join(", ")}`);
    if (st.text !== undefined) checkRegex(st.text, w);
    for (const p of [...(st.present ?? []), ...(st.absent ?? [])]) checkRegex(p, w);
    const hasXY = st.x !== undefined && st.y !== undefined;
    if (st.do === "wait" && !st.text && !st.id) throw usageErr(`${w}: wait needs text or id`);
    if (st.do === "tap" && !st.text && !st.id && !hasXY) throw usageErr(`${w}: tap needs text, id, or x and y`);
    if (st.do === "assert" && !(st.present?.length || st.absent?.length)) throw usageErr(`${w}: assert needs present and/or absent`);
    if (st.do === "setting" && !st.key) throw usageErr(`${w}: setting needs key`);
    if ((st.do === "launch" || st.do === "force_stop") && !sc.app) throw usageErr(`${w}: ${st.do} needs a top-level 'app'`);
  });
  return sc;
}

/** Parse scenario JSON text: one object or an array of objects (run in order). */
export function parseScenarios(text, source = "scenario") {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw usageErr(`${source}: invalid JSON: ${e.message}`);
  }
  const list = Array.isArray(data) ? data : [data];
  if (list.length === 0) throw usageErr(`${source}: empty scenario list`);
  return list;
}

/**
 * Run one validated scenario. Animation scales and show_touches are restored in a finally block, so
 * they come back on step errors, failed pulls and SIGINT (abort `signal`).
 */
export async function runScenario(p, dev, outDir, { signal, say = () => {} } = {}) {
  validateScenario(p);
  const uiDir = join(outDir, "ui");
  const srcDir = join(outDir, "src");
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  const record = !p.noRecord;
  if (record && !hasVenv()) throw new VqaError("run: GIF tooling missing. Run `android-vqa setup` first (or pass --no-record)");

  const res = { name: p.name, passed: true, assertions: [], timeline: [], warnings: [], elapsedS: 0, title: p.title, desc: p.desc, expect: p.expect };
  let t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  const mark = (m) => { res.timeline.push(`t=${el()} ${m}`); };
  let cutAt = 0;
  let recorder;
  const killRecorder = () => { try { recorder?.kill("SIGKILL"); } catch { /* gone */ } };
  process.once("exit", killRecorder);

  const saved = [];
  const applied = [];
  const restore = async () => {
    for (const s of applied) {
      try {
        await dev.putSetting(s.ns, s.key, s.value === "null" || s.value === "" ? (s.key === "show_touches" ? "0" : "1.0") : s.value);
      } catch (e) {
        res.warnings.push(`restore ${s.key} failed: ${errText(e)}`);
      }
    }
    if (applied.length) mark(`restored ${applied.map((s) => `${s.key}=${s.value}`).join(" ")}`);
    applied.length = 0;
  };

  try {
    if (record) {
      if (p.animations !== false) for (const k of ANIM_KEYS) saved.push({ ns: "global", key: k, value: await dev.getSetting("global", k) });
      if (p.touches !== false) saved.push({ ns: "system", key: "show_touches", value: await dev.getSetting("system", "show_touches") });
      for (const s of saved) {
        applied.push(s);
        await dev.putSetting(s.ns, s.key, s.key === "show_touches" ? "1" : "1.0");
      }
    }

    const mp4Name = `${p.name}.mp4`;
    if (record) {
      await dev.sh(`rm -f /sdcard/${mp4Name}`, 10);
      // detached: a terminal Ctrl-C must not kill the recorder mid-file (the mp4 would be unreadable); we stop it with pkill -INT.
      recorder = spawn(dev.adbPath, dev.args(["shell", "screenrecord", "--bit-rate", "4000000", "--time-limit", String(Math.min(p.recordLimit ?? 170, 180)), `/sdcard/${mp4Name}`]), { stdio: "ignore", detached: true });
      recorder.on("error", (e) => res.warnings.push(`screenrecord spawn failed: ${errText(e)}`));
      await sleep(1200);
    }
    t0 = Date.now();
    mark(`recording ${record ? "started" : "skipped"}`);

    const doDump = async (label, withActivity = false) => {
      const xml = await dev.dumpXml();
      writeFileSync(join(uiDir, `${p.name}-${label}.xml`), xml);
      const nodes = parseNodes(xml);
      const texts = nodes.filter((n) => n.visible && (n.text || n.desc)).map((n) => n.text || n.desc);
      const act = withActivity ? ` [${await dev.topActivity()}]` : "";
      mark(`dump ${label}${act}: ${fix(texts.slice(0, 14).join(" | "), 400)}`);
      return nodes;
    };

    const findNode = async (sel, idx, timeoutS, label) => {
      const deadline = Date.now() + timeoutS * 1000;
      for (;;) {
        const nodes = await doDump(label);
        const hits = nodes.filter((n) => nodeMatches(n, sel));
        if (hits[idx]) return hits[idx];
        if (Date.now() > deadline || signal?.aborted) return undefined;
        await sleep(1000, signal);
      }
    };

    try {
      let i = 0;
      for (const st of p.steps) {
        i++;
        if (signal?.aborted) break;
        const tag = `s${i}`;
        switch (st.do) {
          case "launch": {
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
            await dev.sh(`am force-stop ${p.app.package}`, 10);
            mark("force-stop");
            break;
          case "sleep":
            await sleep((st.s ?? 1) * 1000, signal);
            break;
          case "wait": {
            const n = await findNode({ text: st.text, id: st.id }, 0, st.timeout ?? 20, `${tag}-wait`);
            if (!n) { if (signal?.aborted) break; res.passed = false; res.aborted = `wait failed at step ${i}: ${st.text ?? st.id}`; mark(`!! ${res.aborted}`); break; }
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
            if (!n) { if (signal?.aborted) break; res.passed = false; res.aborted = `tap target not found at step ${i}: ${st.text ?? st.id}`; mark(`!! ${res.aborted}`); break; }
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
              await sleep(Math.max(0, every - (Date.now() - began)), signal);
            }
            break;
          }
          case "assert": {
            const nodes = await doDump(st.label ?? `${tag}-assert`, true);
            res.assertions.push(...evaluateAssert(nodes, st, st.label ?? `assert@s${i}`));
            break;
          }
          case "fixture": {
            let state;
            try {
              state = requireProxy();
            } catch (e) {
              throw new Error(`fixture step needs a running proxy (android-vqa proxy start): ${errText(e)}`);
            }
            writeFileSync(state.currentFile, st.value ?? st.name ?? "passthrough");
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
        if (res.aborted || signal?.aborted) break;
        say(`${p.name}: step ${i}/${p.steps.length} ${st.do} ok`);
      }
    } catch (e) {
      res.passed = false;
      res.aborted = errText(e);
      mark(`!! ${res.aborted}`);
    }
    if (signal?.aborted) {
      res.passed = false;
      res.aborted = res.aborted ? `interrupted (${res.aborted})` : "interrupted (SIGINT)";
      mark(`!! ${res.aborted}`);
    }

    if (record) {
      await sleep(1000);
      await dev.sh("pkill -INT screenrecord || killall -2 screenrecord", 10);
      await new Promise((r) => {
        const t = setTimeout(() => r(), 10_000);
        if (!recorder || recorder.exitCode !== null || recorder.signalCode !== null) { clearTimeout(t); r(); return; }
        recorder.once("close", () => { clearTimeout(t); r(); });
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
        if (signal?.aborted) {
          res.warnings.push(`interrupted: GIF not built; rebuild with \`android-vqa gif ${mp4}\``);
        } else {
          const gifPath = join(outDir, `${p.name}.gif`);
          const g = await makeGif({ src: mp4, out: gifPath, start: p.start ?? cutAt, end: p.end, title: p.title ?? p.name, desc: p.desc, expect: p.expect, fps: p.fps, width: p.width, hold: p.hold });
          if (g.ok) {
            res.gif = gifPath;
            res.gifInfo = g.info;
            const c = await checkMedia(res.gif);
            if (c) {
              res.check = { frames: Number(c.frames), changedFrames: Number(c.changedFrames) };
              if (res.check.changedFrames === 0) res.warnings.push("GIF is static (0 changed frames): recording probably captured a frozen screen");
            }
          } else res.warnings.push(`gif build failed: ${g.error}`);
        }
      } else {
        res.warnings.push("recording file missing or empty after pull");
      }
    }
  } finally {
    killRecorder();
    process.removeListener("exit", killRecorder);
    await restore();
  }

  res.passed = res.passed && res.assertions.every((a) => a.ok);
  res.elapsedS = Number(el());
  writeFileSync(join(outDir, `${p.name}.timeline.txt`), res.timeline.join("\n") + "\n");
  writeFileSync(join(outDir, `${p.name}.result.json`), JSON.stringify(res, null, 2));
  return res;
}

export function renderResult(r) {
  const bad = r.assertions.filter((a) => !a.ok);
  const out = [
    `${r.passed ? "PASS" : "FAIL"} ${r.name} (${r.elapsedS}s)  assertions ${r.assertions.length - bad.length}/${r.assertions.length}${r.aborted ? `  ABORTED: ${r.aborted}` : ""}`,
  ];
  if (r.gif) out.push(`gif: ${r.gif}  ${r.check ? `frames=${r.check.frames} changed=${r.check.changedFrames}` : ""}  ${r.gifInfo?.bytes ? Math.round(Number(r.gifInfo.bytes) / 1024) + " KB" : ""}`.trimEnd());
  if (r.mp4) out.push(`mp4: ${r.mp4}`);
  for (const a of r.assertions) out.push(`  ${a.ok ? "ok  " : "FAIL"} ${a.label}  ${fix(a.detail, 160)}`);
  for (const w of r.warnings) out.push(`warning: ${w}`);
  out.push("timeline:", ...r.timeline.slice(0, 60).map((l) => "  " + fix(l, 300)));
  if (r.timeline.length > 60) out.push(`  … ${r.timeline.length - 60} more lines in <out-dir>/${r.name}.timeline.txt`);
  if (r.gif) out.push(`note: the GIF itself was NOT viewed. Run \`android-vqa frames ${r.gif}\` and Read the sheet PNG before claiming a visual result.`);
  return out.join("\n");
}
