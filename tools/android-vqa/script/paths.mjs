import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding this script and the python helpers (gif.py, frames.py, mock_addon.py). */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** Tool home: ANDROID_VQA_HOME, else ~/.local/share/android-vqa. Holds the venv and proxy state. */
export function vqaHome(env = process.env) {
  return env.ANDROID_VQA_HOME || join(homedir(), ".local", "share", "android-vqa");
}

export const legacyVenv = () => join(homedir(), ".pi", "agent", "android-vqa", "venv");

/**
 * Private venv. Default <home>/venv. Without ANDROID_VQA_HOME, an existing venv from the Pi extension
 * (~/.pi/agent/android-vqa/venv) is reused when the new one does not exist yet.
 */
export function venvDir(env = process.env) {
  const v = join(vqaHome(env), "venv");
  if (!env.ANDROID_VQA_HOME && !existsSync(join(v, "bin", "python"))) {
    const legacy = legacyVenv();
    if (existsSync(join(legacy, "bin", "python"))) return legacy;
  }
  return v;
}

export const pyPath = (env = process.env) => join(venvDir(env), "bin", "python");
export const mitmdumpPath = (env = process.env) => join(venvDir(env), "bin", "mitmdump");
export const hasVenv = (env = process.env) => existsSync(pyPath(env));
export const proxyStateFile = (env = process.env) => join(vqaHome(env), "proxy.json");

export function findAdb(env = process.env) {
  const candidates = [
    env.ADB,
    env.ANDROID_HOME && join(env.ANDROID_HOME, "platform-tools", "adb"),
    env.ANDROID_SDK_ROOT && join(env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    join(homedir(), "Android", "Sdk", "platform-tools", "adb"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "adb";
}

/** Artifact directory: --out-dir (relative to cwd) or <cwd>/.vqa. */
export function resolveOut(outDir, cwd = process.cwd()) {
  const d = outDir ?? ".vqa";
  return isAbsolute(d) ? d : resolve(cwd, d);
}

export const absPath = (f, cwd = process.cwd()) => (isAbsolute(f) ? f : resolve(cwd, f));
