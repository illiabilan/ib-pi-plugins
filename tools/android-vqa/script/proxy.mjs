/**
 * mitmproxy fixture mock. mitmdump runs detached and outlives the CLI invocation; its
 * {pid, port, currentFile, logFile, fixturesDir, ...} live in <ANDROID_VQA_HOME>/proxy.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { HERE, mitmdumpPath, proxyStateFile } from "./paths.mjs";
import { VqaError, sleep, usageErr } from "./proc.mjs";

export const ADDON = join(HERE, "mock_addon.py");

export function readState(env = process.env) {
  const f = proxyStateFile(env);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return { corrupt: true };
  }
}

export function writeState(state, env = process.env) {
  const f = proxyStateFile(env);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(state, null, 2) + "\n");
}

export const clearState = (env = process.env) => rmSync(proxyStateFile(env), { force: true });

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Command line of a pid (empty when gone). */
export function pidCommand(pid) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** True only if the pid is a live mitmdump running our addon (guards against pid reuse). */
export function isOurMitmdump(pid, cmdline = pidCommand(pid)) {
  return pidAlive(pid) && /mitmdump/.test(cmdline) && cmdline.includes("mock_addon.py");
}

/**
 * Current proxy: {state, running:true} | {running:false, stale?:string}. Stale state (dead pid,
 * reused pid, corrupt file) is removed so later commands start clean.
 */
export function proxyInfo(env = process.env) {
  const state = readState(env);
  if (!state) return { running: false };
  if (state.corrupt) {
    clearState(env);
    return { running: false, stale: "state file was corrupt; removed" };
  }
  if (!pidAlive(state.pid)) {
    clearState(env);
    return { running: false, stale: `pid ${state.pid} is gone; stale state removed` };
  }
  if (!isOurMitmdump(state.pid)) {
    clearState(env);
    return { running: false, stale: `pid ${state.pid} is alive but is not our mitmdump (pid reused?); stale state removed, process left alone` };
  }
  return { running: true, state };
}

export function requireProxy(env = process.env) {
  const p = proxyInfo(env);
  if (!p.running) throw new VqaError(`proxy not running${p.stale ? ` (${p.stale})` : ""}: run \`android-vqa proxy start\``);
  return p.state;
}

export function waitPort(port, timeoutMs) {
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

export const listFixtures = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : []);

export async function proxyStart({ fixturesDir, match, port = 8080, needles = [], outDir }, env = process.env) {
  const bin = mitmdumpPath(env);
  if (!existsSync(bin)) throw new VqaError("mitmdump missing: run `android-vqa setup` (without --no-proxy)");
  if (!fixturesDir || !match) throw usageErr("proxy start needs --fixtures-dir and --match");
  const cur = proxyInfo(env);
  if (cur.running) throw new VqaError(`proxy already running on :${cur.state.port} (pid ${cur.state.pid}); run \`android-vqa proxy stop\` first`);
  if (await waitPort(port, 0)) throw new VqaError(`port ${port} is already in use by another process; pick --port`);
  mkdirSync(outDir, { recursive: true });
  const currentFile = join(outDir, ".current-fixture");
  const logFile = join(outDir, "proxy.log");
  const stdoutFile = join(outDir, "proxy.stdout.log");
  writeFileSync(currentFile, "passthrough");
  writeFileSync(logFile, "");
  const fd = openSync(stdoutFile, "w");
  const proc = spawn(bin, ["-q", "-s", ADDON, "--listen-port", String(port)], {
    env: { ...env, PYTHONDONTWRITEBYTECODE: "1", VQA_FIXTURES: fixturesDir, VQA_MATCH: match, VQA_CURRENT: currentFile, VQA_LOG: logFile, VQA_NEEDLES: needles.join(",") },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  let exited = false;
  proc.on("exit", () => { exited = true; });
  proc.on("error", () => { exited = true; });
  proc.unref();
  const up = await waitPort(port, 20_000);
  if (!up || exited) {
    try { proc.kill("SIGTERM"); } catch { /* gone */ }
    let tail = "";
    try { tail = readFileSync(stdoutFile, "utf8").trim().split("\n").slice(-10).join("\n"); } catch { /* none */ }
    throw new VqaError(`mitmdump did not open :${port} in 20s${tail ? `\n${tail}` : ""}`);
  }
  const state = { pid: proc.pid, port, match, needles, currentFile, logFile, stdoutFile, fixturesDir, startedAt: new Date().toISOString() };
  writeState(state, env);
  return { state, fixtures: listFixtures(fixturesDir) };
}

export function proxyFixture(name, env = process.env) {
  const state = requireProxy(env);
  if (!name) throw usageErr("proxy fixture needs a name (fixture name | 404 | passthrough)");
  if (!["404", "passthrough"].includes(name) && !existsSync(join(state.fixturesDir, name + ".json"))) {
    throw new VqaError(`fixture '${name}.json' not found in ${state.fixturesDir}`);
  }
  writeFileSync(state.currentFile, name);
  return name;
}

export function proxyLog(lines = 30, env = process.env) {
  const state = requireProxy(env);
  const l = readFileSync(state.logFile, "utf8").split("\n").filter(Boolean);
  return l.slice(-lines);
}

export async function proxyStop(env = process.env) {
  const state = readState(env);
  if (!state) return { stopped: false, message: "proxy was not running" };
  if (state.corrupt || !pidAlive(state.pid)) {
    clearState(env);
    return { stopped: false, message: `proxy was not running (stale state for pid ${state.pid ?? "?"} removed)` };
  }
  if (!isOurMitmdump(state.pid)) {
    clearState(env);
    return { stopped: false, message: `pid ${state.pid} is not our mitmdump (pid reused?); did not kill it, stale state removed` };
  }
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 25 && pidAlive(state.pid); i++) await sleep(200);
  if (pidAlive(state.pid)) {
    try { process.kill(state.pid, "SIGKILL"); } catch { /* gone */ }
  }
  clearState(env);
  return { stopped: true, pid: state.pid, message: "proxy stopped (device proxy setting is unchanged: run `android-vqa proxy device off`)" };
}

export function readCurrentFixture(state) {
  try {
    return readFileSync(state.currentFile, "utf8").trim();
  } catch {
    return "?";
  }
}
