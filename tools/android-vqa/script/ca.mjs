/** mitmproxy user CA install/remove through the Settings UI. Validated on API 33 AOSP only. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VqaError, sleep } from "./proc.mjs";
import { anyMatch, center, nodeMatches, parseNodes } from "./ui.mjs";

async function uiTap(dev, text, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const nodes = parseNodes(await dev.dumpXml());
    const n = nodes.find((x) => nodeMatches(x, { text }));
    if (n) {
      const [cx, cy] = center(n);
      await dev.sh(`input tap ${cx} ${cy}`, 10);
      return true;
    }
    await sleep(1500);
  }
  return false;
}

export async function caInstall(dev, say) {
  const cert = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.cer");
  if (!existsSync(cert)) throw new VqaError("mitm CA not generated yet: run `android-vqa proxy start` first");
  await dev.adb(["push", cert, "/sdcard/Download/"], 30);
  await dev.sh("am force-stop com.android.settings", 10);
  await sleep(800);
  await dev.sh("am start -a android.settings.SECURITY_SETTINGS", 15);
  await sleep(2000);
  const steps = ["^More security settings$", "^Encryption (&|and) credentials$", "^Install a certificate$", "^CA certificate$", "^install anyway$", "^mitmproxy-ca-cert\\.cer$"];
  for (const s of steps) {
    if (s.startsWith("^More") && !(await uiTap(dev, s, 2))) {
      await dev.sh("input swipe 540 1800 540 600 300", 10);
      if (!(await uiTap(dev, s))) throw new VqaError(`ca install: '${s}' not found (UI differs from API 33 AOSP; do it manually)`);
    } else if (!s.startsWith("^More") && !(await uiTap(dev, s))) {
      throw new VqaError(`ca install: '${s}' not found (UI differs from API 33 AOSP; do it manually)`);
    }
    say(`ca install: ${s}`);
    await sleep(1500);
  }
  await sleep(2000);
  await dev.sh("input keyevent KEYCODE_BACK", 10);
  await sleep(1500);
  if (!(await uiTap(dev, "^Trusted credentials$"))) throw new VqaError("ca install: Trusted credentials not found");
  await sleep(1500);
  await uiTap(dev, "^user$");
  await sleep(1500);
  const ok = !!anyMatch(parseNodes(await dev.dumpXml()), "mitmproxy");
  await dev.sh("am force-stop com.android.settings", 10);
  if (!ok) throw new VqaError("ca install: finished the flow but no 'mitmproxy' entry in Trusted credentials > User");
  return "mitmproxy CA present in Trusted credentials > User";
}

export async function caRemove(dev) {
  await dev.sh("am force-stop com.android.settings", 10);
  await sleep(800);
  await dev.sh("am start -a android.settings.SECURITY_SETTINGS", 15);
  await sleep(2000);
  for (const s of ["^More security settings$", "^Encryption (&|and) credentials$", "^Trusted credentials$", "^user$", "mitmproxy"]) {
    if (!(await uiTap(dev, s))) throw new VqaError(`ca remove: '${s}' not found`);
    await sleep(1800);
  }
  if (!(await uiTap(dev, "^(remove|uninstall)$", 2))) {
    await dev.sh("input swipe 540 1700 540 900 300", 10);
    if (!(await uiTap(dev, "^(remove|uninstall)$"))) throw new VqaError("ca remove: Remove button not found");
  }
  await sleep(1500);
  await uiTap(dev, "^ok$");
  await sleep(1500);
  await dev.sh("rm -f /sdcard/Download/mitmproxy-ca-cert.cer", 10);
  const gone = !anyMatch(parseNodes(await dev.dumpXml()), "mitmproxy");
  await dev.sh("am force-stop com.android.settings", 10);
  return gone ? "mitmproxy CA removed" : "Remove flow finished but a 'mitmproxy' entry may still be listed; verify manually";
}
