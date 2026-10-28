// Fake `adb` for tests. State lives in $FAKE_ADB_DIR:
//   calls.jsonl     every invocation (argv) appended as JSON
//   devices.txt     optional `adb devices` output (default: one emulator)
//   settings.json   {"global.window_animation_scale": "0.5", ...}; `settings get` prints "null" when absent
//   ui.xml          UI dump served by `exec-out cat /sdcard/vqa-ui.xml`
//   after-tap.xml   optional: becomes the current screen after any `input tap`; KEYCODE_BACK returns to ui.xml
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_ADB_DIR;
if (!dir) process.exit(0); // imported by the test runner glob: do nothing
const f = (n) => join(dir, n);
let args = process.argv.slice(2);
appendFileSync(f("calls.jsonl"), JSON.stringify(args) + "\n");
if (args[0] === "-s") args = args.slice(2);

const readJson = (n, d) => (existsSync(f(n)) ? JSON.parse(readFileSync(f(n), "utf8")) : d);
const screen = () => readJson("state.json", {}).screen ?? "ui.xml";
const setScreen = (s) => writeFileSync(f("state.json"), JSON.stringify({ ...readJson("state.json", {}), screen: s }));

const [cmd, ...rest] = args;
if (cmd === "devices") {
  process.stdout.write(existsSync(f("devices.txt")) ? readFileSync(f("devices.txt"), "utf8") : "List of devices attached\nemulator-5554\tdevice\n\n");
} else if (cmd === "exec-out") {
  if (rest[0] === "cat") process.stdout.write(existsSync(f(screen())) ? readFileSync(f(screen())) : "");
  else if (rest[0] === "screencap") process.stdout.write(Buffer.from("\x89PNG fake"));
} else if (cmd === "pull") {
  if (existsSync(f("recorded"))) {
    writeFileSync(rest[1], "FAKEMP4");
    process.stdout.write("1 file pulled\n");
  } else {
    process.stderr.write("adb: error: remote object does not exist\n");
    process.exit(1);
  }
} else if (cmd === "push") {
  process.stdout.write("1 file pushed\n");
} else if (cmd === "shell") {
  const sh = rest.join(" ");
  let m;
  if (/^uiautomator dump/.test(sh)) process.stdout.write("UI hierchary dumped to: /sdcard/vqa-ui.xml\n");
  else if ((m = sh.match(/^settings get (\S+) (\S+)$/))) {
    const s = readJson("settings.json", {});
    process.stdout.write(`${s[`${m[1]}.${m[2]}`] ?? "null"}\n`);
  } else if ((m = sh.match(/^settings put (\S+) (\S+) (.*)$/))) {
    const s = readJson("settings.json", {});
    s[`${m[1]}.${m[2]}`] = m[3];
    writeFileSync(f("settings.json"), JSON.stringify(s));
  } else if (/^dumpsys activity activities/.test(sh)) {
    process.stdout.write("  topResumedActivity=ActivityRecord{1a2b3c u0 com.example.app/.MainActivity t42}\n");
  } else if ((m = sh.match(/^cmd package resolve-activity .* (\S+)$/))) {
    process.stdout.write(m[1] === "com.example.app" ? "priority=0 preferredOrder=0 match=0x108000\ncom.example.app/.MainActivity\n" : "No activity found\n");
  } else if (/^input tap /.test(sh)) {
    if (existsSync(f("after-tap.xml"))) setScreen("after-tap.xml");
  } else if (sh === "input keyevent KEYCODE_BACK") {
    setScreen("ui.xml");
  } else if (/^screenrecord /.test(sh)) {
    writeFileSync(f("recorded"), "1");
    rmSync(f("screenrecord.stop"), { force: true });
    const end = Date.now() + 30_000;
    const tick = () => (existsSync(f("screenrecord.stop")) || Date.now() > end ? process.exit(0) : setTimeout(tick, 100));
    tick();
  } else if (/^pkill -INT screenrecord/.test(sh)) {
    writeFileSync(f("screenrecord.stop"), "1");
  } else if (sh === "pgrep screenrecord") {
    process.exit(1);
  }
} else {
  process.stderr.write(`fake adb: unsupported ${args.join(" ")}\n`);
  process.exit(1);
}
