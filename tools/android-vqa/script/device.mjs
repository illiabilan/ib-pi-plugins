import { VqaError, run, runBuf } from "./proc.mjs";
import { findAdb } from "./paths.mjs";

export const ANIM_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

export class Device {
  constructor(adbPath, serial) {
    this.adbPath = adbPath;
    this.serial = serial;
  }
  args(a) {
    return ["-s", this.serial, ...a];
  }
  sh(cmd, timeout = 30) {
    return run(this.adbPath, this.args(["shell", cmd]), { timeout });
  }
  adb(a, timeout = 60) {
    return run(this.adbPath, this.args(a), { timeout });
  }
  async dumpXml() {
    await this.sh("uiautomator dump /sdcard/vqa-ui.xml", 20);
    const r = await runBuf(this.adbPath, this.args(["exec-out", "cat", "/sdcard/vqa-ui.xml"]));
    return r.data.toString("utf8");
  }
  async topActivity() {
    const r = await this.sh("dumpsys activity activities | grep topResumedActivity | head -1", 15);
    const m = r.stdout.match(/ u\d+ ([^\s}]+)/);
    return m ? m[1] : "?";
  }
  async getSetting(ns, key) {
    return (await this.sh(`settings get ${ns} ${key}`, 10)).stdout.trim();
  }
  async putSetting(ns, key, value) {
    await this.sh(`settings put ${ns} ${key} ${value}`, 10);
  }
}

/** --serial, else ANDROID_SERIAL, else the only device in `adb devices` "device" state. Never starts an emulator. */
export async function resolveDevice(serialParam, env = process.env) {
  const adbPath = findAdb(env);
  const serial = serialParam ?? env.ANDROID_SERIAL;
  if (serial) return new Device(adbPath, serial);
  const r = await run(adbPath, ["devices"], { timeout: 15 });
  if (r.code !== 0) throw new VqaError(`adb not usable: ${(r.stderr || r.stdout).trim() || "adb missing (set ADB or ANDROID_HOME)"}`);
  const devs = r.stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  if (devs.length === 0) throw new VqaError("no adb device in 'device' state; start an emulator (the user must start it) and retry");
  if (devs.length > 1) throw new VqaError(`several devices connected (${devs.join(", ")}); pass --serial`);
  return new Device(adbPath, devs[0]);
}
