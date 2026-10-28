import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HERE, pyPath, hasVenv, venvDir } from "./paths.mjs";
import { VqaError, run } from "./proc.mjs";
import { fix } from "./ui.mjs";

export function needVenv() {
  if (!hasVenv()) throw new VqaError(`GIF tooling missing: run \`android-vqa setup\` first (venv: ${venvDir()})`);
}

/** Captioned GIF from an mp4 via gif.py (ffmpeg + pillow). Lowers fps then width until <= 6 MB. */
export async function makeGif(o, signal) {
  const args = [join(HERE, "gif.py"), "--src", o.src, "--out", o.out, "--start", String(o.start ?? 0)];
  if (o.end) args.push("--end", String(o.end));
  if (o.title) args.push("--title", o.title);
  if (o.desc) args.push("--desc", o.desc);
  if (o.expect) args.push("--expect", o.expect);
  if (o.fps) args.push("--fps", String(o.fps));
  if (o.width) args.push("--width", String(o.width));
  if (o.hold !== undefined) args.push("--hold", String(o.hold));
  mkdirSync(dirname(o.out), { recursive: true });
  const r = await run(pyPath(), args, { timeout: 300, signal });
  if (r.code !== 0) return { ok: false, error: fix((r.stderr || r.stdout).trim(), 600) || `exit ${r.code}` };
  try {
    return { ok: true, info: JSON.parse(r.stdout.trim().split("\n").pop()) };
  } catch {
    return { ok: true, info: {} };
  }
}

/** frames.py --check: {frames, changedFrames, meanFirstMidLast, size, bytes}. changedFrames 0 means static. */
export async function checkMedia(path) {
  const r = await run(pyPath(), [join(HERE, "frames.py"), "--src", path, "--check"], { timeout: 120 });
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return undefined;
  }
}

/** Contact sheet PNG of evenly spaced frames of a gif/mp4. */
export async function contactSheet(src, out, count, signal) {
  mkdirSync(dirname(out), { recursive: true });
  const r = await run(pyPath(), [join(HERE, "frames.py"), "--src", src, "--out", out, "--count", String(count)], { timeout: 180, signal });
  if (r.code !== 0) throw new VqaError(`frames failed: ${fix((r.stderr || r.stdout).trim(), 600)}`);
  let info = {};
  try {
    info = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch { /* keep raw */ }
  return { out, info, raw: r.stdout.trim() };
}
