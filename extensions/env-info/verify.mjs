/**
 * verify.mjs — direct (no-LLM) assertions against env_info's execute().
 * Covers ground truth for tool detection, the redaction contract, and the
 * adversarial cases from the build task.
 *
 * Usage: node verify.mjs
 * Requires the fixtures in /tmp/envx-bin (created by this script if missing).
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const here = new URL(".", import.meta.url).pathname;

// ---------- fixtures ----------
const BIN = "/tmp/envx-bin";
mkdirSync(BIN, { recursive: true });
mkdirSync("/tmp/envx-nopkg", { recursive: true });
const fixtures = {
  "envx-hangtool": "#!/bin/sh\nsleep 60\n",
  "envx-noversion": "#!/bin/sh\nexit 0\n",
  "envx-stderrversion": "#!/bin/sh\necho \"weirdtool version 3.14.1 (build xyz)\" 1>&2\nexit 1\n",
  "envx-notexec": "#!/bin/sh\necho nope\n",
  // 5MB of output after the version line: must not flood the tool result.
  "envx-flood": "#!/bin/sh\necho \"floodtool version 9.9.9\"\nhead -c 5000000 /dev/zero | tr '\\0' 'x'\n",
};
for (const [name, body] of Object.entries(fixtures)) {
  const p = join(BIN, name);
  if (existsSync(p)) chmodSync(p, 0o755); // may have been left non-writable by a previous run
  writeFileSync(p, body);
  chmodSync(p, name === "envx-notexec" ? 0o000 : 0o755);
}
process.env.PATH = `${BIN}:${process.env.PATH}`;

// ---------- secrets under test (must never appear in output) ----------
const SECRETS = {
  ENVX_FAKE_API_KEY: "ZZQQ-fake-secret-value-9F3Kx1-do-not-leak",
  ENVX_SHORT_TOKEN: "ab12",
  ENVX_EMPTY_TOKEN: "",
  ENVX_PLAIN_NOTE: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
  ENVX_UNICODE: "héllo wörld — ünïcode ✅ 日本語",
  ENVX_HIGH_ENTROPY: "aB3xQ9zLmN2pR7sT4vW1yU8kJ6hG5fD4",
  ENVX_DB_URL: "postgres://appuser:tOpS3cretPassw0rd@db.example.com:5432/app",
  ENVX_CONTROL_CHARS: "line1\nline2\ttabbed\u0007bell",
};
Object.assign(process.env, SECRETS);
const MUST_NOT_LEAK = [
  SECRETS.ENVX_FAKE_API_KEY,
  SECRETS.ENVX_FAKE_API_KEY.slice(2),
  SECRETS.ENVX_SHORT_TOKEN,
  SECRETS.ENVX_PLAIN_NOTE,
  SECRETS.ENVX_HIGH_ENTROPY,
  "tOpS3cretPassw0rd",
];

const factory = await jiti.import(join(here, "index.ts"), { default: true });
let tool;
factory({ registerTool: (t) => (tool = t), on() {}, registerCommand() {} });

let pass = 0;
const fails = [];
function check(name, cond, info = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name} ${info}`);
  }
}

const ctx = { cwd: process.cwd(), mode: "print", hasUI: false };
async function call(args, opts = {}) {
  const res = await tool.execute("id", args, opts.signal, opts.onUpdate, opts.ctx ?? ctx);
  return { text: res.content[0].text, details: res.details, res };
}
async function expectThrow(args) {
  try {
    await call(args);
    return null;
  } catch (e) {
    return e;
  }
}

// ================= 1. tools: ground truth vs `command -v` =================
const groundTruthNames = ["gh", "node", "npm", "python3", "rg", "javap", "adb", "gradle", "kubectl", "terraform", "deno"];
const truth = {};
for (const n of groundTruthNames) {
  try {
    truth[n] = execFileSync("/bin/sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).trim();
  } catch {
    truth[n] = "";
  }
}
{
  const { text, details } = await call({ action: "tools", tools: groundTruthNames, versionTimeoutMs: 8000 });
  for (const n of groundTruthNames) {
    const r = details.tools.find((t) => t.name === n);
    const expectPresent = !!truth[n];
    check(`tools/ground-truth ${n} presence`, r.present === expectPresent, `tool=${r.present} command -v=${expectPresent}`);
    if (expectPresent) check(`tools/ground-truth ${n} path`, r.path === truth[n], `${r.path} vs ${truth[n]}`);
  }
  check("tools/at-least-one-absent", groundTruthNames.some((n) => !truth[n]), "test list must include an absent tool");
  check("tools/version-ok-for-node", details.tools.find((t) => t.name === "node").versionStatus === "ok");
  check("tools/text-mentions-ABSENT", text.includes("ABSENT"));
  check("tools/no redaction footer noise on non-env actions", !text.includes("secret_redaction: always-on"));
}

// ================= 2. tools: adversarial =================
{
  const t0 = Date.now();
  const { details } = await call({
    action: "tools",
    tools: ["envx-hangtool", "envx-notexec", "envx-noversion", "envx-stderrversion", "cd", "../evil", "/bin/ls"],
    versionTimeoutMs: 1500,
  });
  const ms = Date.now() - t0;
  const g = (n) => details.tools.find((t) => t.name === n);
  check("adv/hang timeout fires", g("envx-hangtool").versionStatus === "timeout", JSON.stringify(g("envx-hangtool")));
  check("adv/hang still reported present", g("envx-hangtool").present === true);
  check("adv/parallel (no serialization)", ms < 6000, `${ms}ms for 7 tools incl. 1 hang @1.5s`);
  check("adv/not-executable detected", g("envx-notexec").versionStatus === "not-executable" && g("envx-notexec").present === true, JSON.stringify(g("envx-notexec")));
  check("adv/no-version-output", g("envx-noversion").versionStatus === "no-version-output", JSON.stringify(g("envx-noversion")));
  check(
    "adv/version on stderr + nonzero exit still parsed",
    g("envx-stderrversion").version === "3.14.1",
    JSON.stringify(g("envx-stderrversion")),
  );
  check(
    "adv/shell builtin reported as builtin (macOS also has /usr/bin/cd)",
    g("cd").kind === "shell-builtin+binary" && g("cd").present === true,
    JSON.stringify(g("cd")),
  );
  check("adv/path-like name rejected", g("../evil").versionStatus === "skipped" && g("../evil").present === false);
  check("adv/absolute path rejected", g("/bin/ls").present === false);

  const flood = await call({ action: "tools", tools: ["envx-flood"], versionTimeoutMs: 4000 });
  check(
    "adv/5MB version output does not flood the result",
    flood.text.length < 700 && flood.details.tools[0].version === "9.9.9",
    `${flood.text.length} chars, version=${flood.details.tools[0].version}`,
  );
  check("adv/version line capped at 160 chars", (flood.details.tools[0].versionLine ?? "").length <= 160);
}

// ================= 3. env: redaction contract =================
{
  const { text, details } = await call({ action: "env", envPattern: "^ENVX_" });
  const all = JSON.stringify(details) + text;
  for (const s of MUST_NOT_LEAK) check(`env/no-leak ${s.slice(0, 12)}...`, !all.includes(s), "LEAKED");
  const v = (n) => details.vars.find((x) => x.name === n);
  check("env/api-key redacted by name", v("ENVX_FAKE_API_KEY").redacted && v("ENVX_FAKE_API_KEY").reason === "secret-name");
  check("env/api-key reports length", v("ENVX_FAKE_API_KEY").chars === SECRETS.ENVX_FAKE_API_KEY.length);
  check("env/api-key has fingerprint", /^[0-9a-f]{8}$/.test(v("ENVX_FAKE_API_KEY").fingerprint));
  check("env/api-key no value field", v("ENVX_FAKE_API_KEY").value === undefined);
  check("env/short secret gets NO prefix", v("ENVX_SHORT_TOKEN").prefix === undefined, JSON.stringify(v("ENVX_SHORT_TOKEN")));
  check("env/short secret still marked set", v("ENVX_SHORT_TOKEN").set === true && v("ENVX_SHORT_TOKEN").redacted === true);
  check("env/empty secret reported empty, no fp", v("ENVX_EMPTY_TOKEN").empty === true && !v("ENVX_EMPTY_TOKEN").fingerprint);
  check("env/token-shaped value in non-secret name redacted", v("ENVX_PLAIN_NOTE").redacted && v("ENVX_PLAIN_NOTE").reason.startsWith("credential-pattern:github"), JSON.stringify(v("ENVX_PLAIN_NOTE")));
  check("env/high-entropy value redacted", v("ENVX_HIGH_ENTROPY").redacted && v("ENVX_HIGH_ENTROPY").reason === "high-entropy-value");
  check("env/url-with-password redacted", v("ENVX_DB_URL").redacted && v("ENVX_DB_URL").reason.includes("url-embedded-credentials"), JSON.stringify(v("ENVX_DB_URL")));
  check("env/unicode value shown with correct char count", v("ENVX_UNICODE").value?.includes("日本語") && v("ENVX_UNICODE").chars === [...SECRETS.ENVX_UNICODE].length);
  check("env/unicode byte count differs from char count", v("ENVX_UNICODE").bytes > v("ENVX_UNICODE").chars);
  check("env/control chars escaped", v("ENVX_CONTROL_CHARS").value === "line1\\nline2\\ttabbed\\x07bell", JSON.stringify(v("ENVX_CONTROL_CHARS").value));
  check("env/no raw newline injected into text", !text.split("\n").some((l) => l.trim() === "line2\ttabbed"));
  check("env/prefix only 2 chars", v("ENVX_FAKE_API_KEY").prefix === "ZZ");
  check("env/redaction marker in details", details.redaction === "always-on");
}

// ================= 4. env: safe vars still useful =================
{
  const { details, text } = await call({ action: "env", envVars: ["PATH", "HOME", "SHELL", "ENVX_DOES_NOT_EXIST", "LANG"] });
  const v = (n) => details.vars.find((x) => x.name === n);
  check("env/PATH shown in full-ish", v("PATH").redacted === false && v("PATH").value.includes(BIN));
  check("env/HOME shown", v("HOME").value === process.env.HOME);
  check("env/unset reported", v("ENVX_DOES_NOT_EXIST").set === false && text.includes("unset"));
}

// ================= 5. env: no-parameter-disables-redaction =================
{
  const schemaKeys = Object.keys(tool.parameters.properties);
  check(
    "env/no redaction-disabling parameter exists",
    !schemaKeys.some((k) => /reveal|plain|raw|unmask|unredact|showSecrets|insecure/i.test(k)),
    schemaKeys.join(","),
  );
  // Even a hostile extra argument must not change behavior.
  const { details } = await call({ action: "env", envVars: ["ENVX_FAKE_API_KEY"], revealSecrets: true, redact: false, raw: true });
  check("env/hostile extra args ignored", details.vars[0].redacted === true && details.vars[0].value === undefined);
}

// ================= 6. env: adversarial pattern =================
{
  const err = await expectThrow({ action: "env", envPattern: "([unclosed" });
  check("env/invalid regex throws", !!err && /invalid envPattern/.test(err.message), String(err));
  const { details } = await call({ action: "env", envPattern: "." });
  check("env/match-everything is capped", details.vars.length <= 200);
  const leaked = details.vars.filter((v) => v.value !== undefined).flatMap((v) => MUST_NOT_LEAK.filter((s) => v.value.includes(s)));
  check("env/match-everything leaks nothing", leaked.length === 0, leaked.join(","));
}

// ================= 7. runtime =================
{
  const { text, details } = await call({ action: "runtime" });
  check("runtime/node version", details.runtime.version === process.version);
  check("runtime/platform", details.platform === process.platform);
  check("runtime/cwd", details.cwd === ctx.cwd);
  check("runtime/envSource classified", ["login-shell-like", "uncertain", "minimal-like"].includes(details.envSource));
  check("runtime/credential vars set/unset only", details.credentialVarsSet.every((c) => Object.keys(c).join(",") === "name,set"));
  check("runtime/mentions config_source alignment", /config_source/.test(text));
  const all = JSON.stringify(details) + text;
  check("runtime/no secret leak", !MUST_NOT_LEAK.some((s) => all.includes(s)));
}

// ================= 8. pi =================
{
  const { text, details } = await call({ action: "pi" });
  check("pi/version resolved", /^\d+\.\d+\.\d+/.test(details.version), details.version);
  check("pi/version provenance tagged", ["running-process", "imported-module"].includes(details.versionSource), details.versionSource);
  check("pi/config dir", details.configDir.endsWith("/agent"), details.configDir);
  check("pi/extensions listed", Array.isArray(details.globalExtensions) && details.globalExtensions.length > 0);
  const grepExt = details.globalExtensions?.find((e) => e.name === "grep");
  check("pi/symlink target resolved (replaces readlink)", !!grepExt?.target && grepExt.target.includes("pi-plugins/extensions/grep"), JSON.stringify(grepExt));
  check("pi/entry point detected", grepExt?.entry === "index.ts");
  check("pi/skills+agents listed", (details.skills?.length ?? 0) > 0 && (details.agents?.length ?? 0) > 0);
  check("pi/text shows dirs", text.includes("config dir") && text.includes("Extensions:"));
}

// ================= 9. package =================
{
  const { text, details } = await call({ action: "package", projectDir: here, packages: ["typescript", "jiti", "not-a-real-dep-xyz"] });
  const d = (n) => details.deps.find((x) => x.name === n);
  check("pkg/self identified", details.packageName === "env-info");
  check("pkg/declared range reported", d("typescript").declared === "^7.0.2" && d("typescript").section === "devDependencies");
  check("pkg/installed version resolved from node_modules", /^\d+\./.test(d("typescript").installed ?? ""), JSON.stringify(d("typescript")));
  check("pkg/installed provenance tagged", d("typescript").installedSource === "node_modules");
  check("pkg/range check ok", d("typescript").rangeCheck === "ok", JSON.stringify(d("typescript")));
  check("pkg/missing dep flagged", d("not-a-real-dep-xyz").rangeCheck === "not-installed" || d("not-a-real-dep-xyz").rangeCheck === "unknown", JSON.stringify(d("not-a-real-dep-xyz")));
  check("pkg/text distinguishes declared vs installed", text.includes("declared") && text.includes("installed"));
}
{
  const { text, details } = await call({ action: "package", projectDir: "/tmp/envx-nopkg" });
  check("pkg/no package.json is a clear message, not a crash", details.packageJson === null && /no package.json found/.test(text));
}
{
  // Nearest-ancestor fallback must be explicit about what it did.
  const sub = join(here, "node_modules", "jiti");
  if (existsSync(sub)) {
    const { text } = await call({ action: "package", projectDir: sub, packages: ["jiti"] });
    check("pkg/walk-up is disclosed or exact", /package.json/.test(text));
  }
  const { details } = await call({ action: "package", projectDir: join(here, "does-not-exist-subdir") });
  check("pkg/nonexistent dir walks up and discloses", details.packageJson?.endsWith("env-info/package.json") === true, JSON.stringify(details.packageJson));
}

// ================= 10. renderers + abort =================
{
  const theme = { fg: (_c, s) => s, bold: (s) => s };
  const rc = tool.renderCall({ action: "tools", tools: ["gh"] }, theme);
  check("render/renderCall returns component", typeof rc?.render === "function" || typeof rc === "object");
  const rr = tool.renderResult({ content: [{ type: "text", text: "a\n".repeat(40) }], details: {} }, { expanded: false, isPartial: false }, theme, {});
  check("render/renderResult truncates when collapsed", JSON.stringify(rr).includes("more lines"));
  const rp = tool.renderResult({ content: [{ type: "text", text: "x" }], details: {} }, { expanded: false, isPartial: true }, theme, {});
  check("render/partial handled", JSON.stringify(rp).includes("Probing"));
  const ac = new AbortController();
  ac.abort();
  const { details } = await call({ action: "tools", tools: ["node"], versionTimeoutMs: 2000 }, { signal: ac.signal });
  check("render/aborted signal handled gracefully", details.tools[0].versionStatus === "aborted", JSON.stringify(details.tools[0]));
}

// ================= 11. fingerprint stability =================
{
  const a = await call({ action: "env", envVars: ["ENVX_FAKE_API_KEY"] });
  const b = await call({ action: "env", envVars: ["ENVX_FAKE_API_KEY"] });
  check("fp/stable within process", a.details.vars[0].fingerprint === b.details.vars[0].fingerprint);
  process.env.ENVX_FAKE_API_KEY = SECRETS.ENVX_FAKE_API_KEY + "x";
  const c = await call({ action: "env", envVars: ["ENVX_FAKE_API_KEY"] });
  check("fp/changes when value changes", c.details.vars[0].fingerprint !== a.details.vars[0].fingerprint);
  process.env.ENVX_FAKE_API_KEY = SECRETS.ENVX_FAKE_API_KEY;
}

// ================= 12. oversized / pathological values =================
{
  process.env.ENVX_HUGE = "A1".repeat(60_000); // 120KB, letters+digits
  process.env.ENVX_HUGE_PLAIN = "lorem ipsum dolor sit amet ".repeat(4000);
  const { text, details } = await call({ action: "env", envVars: ["ENVX_HUGE", "ENVX_HUGE_PLAIN"] });
  const v = (n) => details.vars.find((x) => x.name === n);
  check("huge/entropy-ish huge value redacted or capped", v("ENVX_HUGE").redacted || v("ENVX_HUGE").value.length <= 500, String(v("ENVX_HUGE").value?.length));
  check("huge/plain huge value capped", (v("ENVX_HUGE_PLAIN").value ?? "").length <= 500, String(v("ENVX_HUGE_PLAIN").value?.length));
  check("huge/text stays small", text.length < 3000, `${text.length} chars`);
  check("huge/exact length still reported", v("ENVX_HUGE").chars === 120_000);
  delete process.env.ENVX_HUGE;
  delete process.env.ENVX_HUGE_PLAIN;
}

// ================= 13. envPattern with no matches =================
{
  const { text, details } = await call({ action: "env", envPattern: "^NOTHING_MATCHES_THIS_XYZ$" });
  check("pattern/no matches is explicit", details.vars.length === 0 && /0 match/.test(text), text.slice(0, 120));
}

// ================= 14. package: mid-session file change (no stale cache) =================
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join("/tmp", "envx-pkg-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "envx-fixture", version: "1.0.0", dependencies: { left: "^1.2.3" } }));
  const a = await call({ action: "package", projectDir: dir });
  check("pkg/reads fixture", a.details.deps.find((d) => d.name === "left")?.declared === "^1.2.3");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "envx-fixture", version: "2.0.0", dependencies: { left: "^9.9.9", right: "~2.0.0" } }));
  const b = await call({ action: "package", projectDir: dir });
  check(
    "pkg/mid-session edit reflected (no stale cache)",
    b.details.packageVersion === "2.0.0" && b.details.deps.find((d) => d.name === "left")?.declared === "^9.9.9" && b.details.deps.length === 2,
    JSON.stringify(b.details.deps),
  );
  // range-check semantics on a controlled fixture
  const cases = [
    ["^1.2.3", "1.9.0", "ok"],
    ["^1.2.3", "2.0.0", "mismatch"],
    ["~2.0.0", "2.0.7", "ok"],
    ["~2.0.0", "2.1.0", "mismatch"],
    ["3.1.4", "3.1.4", "ok"],
    ["3.1.4", "3.1.5", "mismatch"],
    [">=1.0.0 <2", "1.5.0", "unknown"],
    ["workspace:*", "1.0.0", "unknown"],
  ];
  const mod = await jiti.import(join(here, "index.ts"));
  for (const [range, installed, want] of cases) {
    const nm = join(dir, "node_modules", "fixdep");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "fixdep", version: installed }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "envx-fixture", version: "1.0.0", dependencies: { fixdep: range } }));
    const r = await call({ action: "package", projectDir: dir, packages: ["fixdep"] });
    const got = r.details.deps[0].rangeCheck;
    check(`pkg/rangeCheck ${range} vs ${installed} => ${want}`, got === want, `got ${got}`);
  }
}

// ================= 15. package: includeLatest (network, tagged) =================
{
  const { details } = await call({ action: "package", projectDir: here, packages: ["jiti", "@earendil-works/pi-tui", "envx-definitely-not-a-package-9f3k"], includeLatest: true });
  const d = (n) => details.deps.find((x) => x.name === n);
  check(
    "latest/real package resolved or clearly errored",
    (d("jiti").latest && d("jiti").latestSource === "registry.npmjs.org") || !!d("jiti").latestError,
    JSON.stringify(d("jiti")),
  );
  check("latest/scoped package handled", !!d("@earendil-works/pi-tui").latest || !!d("@earendil-works/pi-tui").latestError, JSON.stringify(d("@earendil-works/pi-tui")));
  check("latest/bogus package reports error not version", !d("envx-definitely-not-a-package-9f3k").latest && !!d("envx-definitely-not-a-package-9f3k").latestError, JSON.stringify(d("envx-definitely-not-a-package-9f3k")));
}

// ================= 16. free-text scrubbing (non-env output paths) =================
{
  const mod = await jiti.import(join(here, "index.ts"));
  const cases = [
    ["git:x-access-token:ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/u/r", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["npm:@foo/bar https://user:hunter2pass@example.com/x", "hunter2pass"],
    ["tool 1.2.3 licensed to sk-ant-api03-AAAABBBBCCCCDDDDEEEE", "sk-ant-api03-AAAABBBBCCCCDDDDEEEE"],
  ];
  for (const [input, secret] of cases) {
    const out = mod.scrubText(input);
    check(`scrub/${secret.slice(0, 10)}... removed from free text`, !out.includes(secret), out);
  }
  check("scrub/plain text untouched", mod.scrubText("nothing secret here 1.2.3") === "nothing secret here 1.2.3");
  // The pi action prints settings.json entries; make sure that path is scrubbed too.
  const { text } = await call({ action: "pi" });
  check("scrub/pi action output has no ghp_/sk- literals", !/\bghp_[A-Za-z0-9]{16,}|\bsk-[A-Za-z0-9_-]{16,}/.test(text));
}

// ================= 17. unknown action =================
{
  const err = await expectThrow({ action: "bogus" });
  check("misc/unknown action throws with valid list", !!err && /Valid actions: tools, env, runtime, pi, package/.test(err.message), String(err));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:", fails.join(" | "));
  process.exit(1);
}
