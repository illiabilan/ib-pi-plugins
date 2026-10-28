// Fake venv python for tests: stands in for gif.py / frames.py so the recording path runs without
// imageio-ffmpeg/pillow. FAKE_CHANGED sets changedFrames reported by `frames.py --check` (default 5).
import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [script, ...args] = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (process.env.FAKE_ADB_DIR) appendFileSync(`${process.env.FAKE_ADB_DIR}/python.jsonl`, JSON.stringify([script, ...args]) + "\n");
const name = basename(script ?? "");
if (name === "gif.py") {
  writeFileSync(opt("--out"), "GIF89a-fake");
  console.log(JSON.stringify({ out: opt("--out"), fps: 10, width: 360, srcFrames: 10, frames: 20, durationS: 2, bytes: 11 }));
} else if (name === "frames.py" && args.includes("--check")) {
  console.log(JSON.stringify({ frames: 20, changedFrames: Number(process.env.FAKE_CHANGED ?? 5), meanFirstMidLast: [1, 2, 3], size: [360, 700], bytes: 11 }));
} else if (name === "frames.py") {
  writeFileSync(opt("--out"), "\x89PNG fake");
  console.log(JSON.stringify({ out: opt("--out"), frames: 20, picked: [1, 20], size: [600, 300] }));
}
