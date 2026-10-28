import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyMatch, center, evaluateAssert, fmtNode, listNodes, nodeMatches, parseNodes } from "../ui.mjs";
import { parseScenarios, validateScenario } from "../scenario.mjs";
import { buildScenarios, num } from "../cli.mjs";
import { findAdb, legacyVenv, resolveOut, venvDir } from "../paths.mjs";
import { isOurMitmdump } from "../proxy.mjs";
import { XML } from "./fakes/screens.mjs";



const nodes = parseNodes(XML);

test("parseNodes: attributes, entity decoding, bounds, visibility", () => {
  assert.equal(nodes.length, 6);
  const banner = nodes[2];
  assert.equal(banner.text, "QA single copy & more");
  assert.equal(banner.id, "com.example.app:id/banner_title");
  assert.deepEqual(banner.bounds, [40, 300, 1040, 380]);
  assert.equal(banner.visible, true);
  assert.equal(nodes[1].checked, true);
  assert.equal(nodes[1].clickable, true);
  assert.equal(nodes[4].visible, false, "zero-size node is invisible");
  assert.equal(nodes[5].desc, 'Open "menu"');
  assert.deepEqual(parseNodes("garbage"), []);
});

test("center and fmtNode", () => {
  assert.deepEqual(center(nodes[3]), [900, 450]);
  assert.equal(fmtNode(nodes[3]), '[800,400,1000,500] id=cta t="Join" clickable');
  assert.equal(fmtNode(nodes[5]), '[980,100,1080,200] id=menu d="Open \\"menu\\"" clickable');
});

test("nodeMatches: text regex on text/desc, id suffix or full id, visible only", () => {
  assert.ok(nodeMatches(nodes[3], { text: "^join$" }), "case-insensitive");
  assert.ok(!nodeMatches(nodes[3], { text: "^Joi$" }));
  assert.ok(nodeMatches(nodes[5], { text: "menu" }), "matches content-desc");
  assert.ok(nodeMatches(nodes[3], { id: "cta" }));
  assert.ok(nodeMatches(nodes[3], { id: "com.example.app:id/cta" }));
  assert.ok(!nodeMatches(nodes[3], { id: "ta" }), "id must be whole suffix after /");
  assert.ok(nodeMatches(nodes[3], { id: "cta", text: "Join" }));
  assert.ok(!nodeMatches(nodes[3], { id: "cta", text: "Nope" }), "both must hold");
  assert.ok(!nodeMatches(nodes[4], { id: "cashback_info_icon" }), "invisible never matches");
  assert.ok(!nodeMatches(nodes[3], {}), "empty selector matches nothing");
});

test("anyMatch also searches resource-id but skips invisible nodes", () => {
  assert.equal(anyMatch(nodes, "banner_title"), nodes[2]);
  assert.equal(anyMatch(nodes, "cashback_info_icon"), undefined);
  assert.equal(anyMatch(nodes, "QA SINGLE"), nodes[2]);
});

test("evaluateAssert: present/absent semantics and details", () => {
  const r = evaluateAssert(nodes, { present: ["QA single copy", "^Join$", "Checkout"], absent: ["info_icon", "^Delivery$"] }, "bar");
  assert.deepEqual(r.map((a) => [a.label, a.ok]), [
    ["bar: present /QA single copy/", true],
    ["bar: present /^Join$/", true],
    ["bar: present /Checkout/", false],
    ["bar: absent /info_icon/", true],
    ["bar: absent /^Delivery$/", false],
  ]);
  assert.equal(r[2].detail, "no visible node matched");
  assert.match(r[4].detail, /^found \[0,100,540,200\] id=tab_delivery/);
  assert.equal(r[3].detail, "no node matched");
});

test("listNodes filters by regex over text/desc/id", () => {
  const { all, sel } = listNodes(nodes, "cta|menu");
  assert.equal(all.length, 4);
  assert.deepEqual(sel.map((n) => n.id.split("/").pop()), ["cta", "menu"]);
});

const EXAMPLE = {
  name: "G03-single", app: { package: "com.x.app" }, title: "G03 single copy", desc: "toggle ON, tap bar, Back", expect: "bar with CTA, tap opens checkout",
  steps: [{ do: "force_stop" }, { do: "launch" }, { do: "wait", text: "Delivery", timeout: 30 }, { do: "cut" },
    { do: "assert", present: ["QA single copy", "^Join$"], absent: ["info_icon"] }, { do: "tap", text: "^Join$" }, { do: "sleep", s: 3 },
    { do: "assert", present: ["Checkout"] }, { do: "back" }, { do: "sleep", s: 2 }],
};

test("validateScenario accepts the documented example", () => {
  assert.equal(validateScenario(structuredClone(EXAMPLE)).name, "G03-single");
});

test("validateScenario rejects bad input with usage errors", () => {
  const bad = (mut, re) => {
    const sc = structuredClone(EXAMPLE);
    mut(sc);
    assert.throws(() => validateScenario(sc), (e) => e.code === "usage" && re.test(e.message), re.toString());
  };
  bad((s) => delete s.name, /'name' is required/);
  bad((s) => (s.name = "a b"), /may only contain/);
  bad((s) => (s.name = "x;rm -rf /"), /may only contain/);
  bad((s) => (s.steps = []), /'steps' is required/);
  bad((s) => (s.foo = 1), /unknown field 'foo'/);
  bad((s) => (s.steps[0].do = "explode"), /'do' must be one of/);
  bad((s) => (s.steps[2].timeout = "30"), /'timeout' must be a number/);
  bad((s) => (s.steps[4].present = "x"), /'present' must be a string\[\]/);
  bad((s) => (s.steps[4].present = ["("]), /invalid regex/);
  bad((s) => (s.steps[2] = { do: "wait" }), /wait needs text or id/);
  bad((s) => (s.steps[5] = { do: "tap", x: 1 }), /tap needs text, id, or x and y/);
  bad((s) => (s.steps[4] = { do: "assert" }), /assert needs present/);
  bad((s) => (s.steps[0] = { do: "setting", value: "1" }), /setting needs key/);
  bad((s) => delete s.app, /force_stop needs a top-level 'app'/);
  bad((s) => (s.app = { activity: ".Main" }), /app must be/);
  bad((s) => (s.steps[0].bogus = 1), /step 1: unknown field 'bogus'/);
  bad((s) => (s.noRecord = "yes"), /'noRecord' must be a boolean/);
  assert.throws(() => validateScenario([]), /must be a JSON object/);
});

test("parseScenarios: object, list, invalid JSON", () => {
  assert.equal(parseScenarios('{"name":"a"}').length, 1);
  assert.equal(parseScenarios('[{"name":"a"},{"name":"b"}]').length, 2);
  assert.throws(() => parseScenarios("{", "f.json"), (e) => e.code === "usage" && /f.json: invalid JSON/.test(e.message));
  assert.throws(() => parseScenarios("[]"), /empty scenario list/);
});

test("buildScenarios: CLI flags override scenario fields", () => {
  const read = () => JSON.stringify(EXAMPLE);
  const [sc] = buildScenarios({ scenario: "x.json", name: "G04", "no-record": true, "no-touches": true, fps: "8", package: "com.y", activity: ".Main" }, read);
  assert.equal(sc.name, "G04");
  assert.equal(sc.noRecord, true);
  assert.equal(sc.touches, false);
  assert.equal(sc.animations, undefined);
  assert.equal(sc.fps, 8);
  assert.deepEqual(sc.app, { package: "com.y", activity: ".Main" });
  assert.equal(sc.title, "G03 single copy");
  assert.throws(() => buildScenarios({}, read), /--scenario/);
  assert.throws(() => buildScenarios({ scenario: "x", fps: "1.5" }, read), /--fps must be an integer/);
  assert.throws(() => buildScenarios({ scenario: "x", name: "n" }, () => JSON.stringify([EXAMPLE, EXAMPLE])), /--name cannot be used/);
  assert.throws(() => buildScenarios({ scenario: "missing" }, () => { throw new Error("ENOENT"); }), (e) => e.code === "usage" && /cannot read/.test(e.message));
  assert.equal(buildScenarios({ scenario: "x" }, () => JSON.stringify([EXAMPLE, { ...EXAMPLE, name: "two" }])).length, 2);
});

test("num validates numeric flags", () => {
  assert.equal(num(undefined, "x"), undefined);
  assert.equal(num("3.5", "x"), 3.5);
  assert.throws(() => num("abc", "x"), /--x must be a number/);
  assert.throws(() => num("-1", "x", { min: 0 }), />= 0/);
  assert.throws(() => num("", "x"), /must be/);
});

test("paths: ANDROID_VQA_HOME, legacy Pi venv reuse, adb discovery, out dir", () => {
  const home = mkdtempSync(join(tmpdir(), "vqa-home-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const def = join(home, ".local", "share", "android-vqa", "venv");
    assert.equal(venvDir({}), def);
    mkdirSync(join(legacyVenv(), "bin"), { recursive: true });
    writeFileSync(join(legacyVenv(), "bin", "python"), "");
    assert.equal(venvDir({}), legacyVenv(), "legacy venv reused when the new one is missing");
    assert.equal(venvDir({ ANDROID_VQA_HOME: "/x" }), "/x/venv", "explicit home never falls back");
    mkdirSync(join(def, "bin"), { recursive: true });
    writeFileSync(join(def, "bin", "python"), "");
    assert.equal(venvDir({}), def, "new venv wins once it exists");
    const adb = join(home, "adb");
    writeFileSync(adb, "");
    assert.equal(findAdb({ ADB: adb }), adb);
    assert.equal(findAdb({ ADB: join(home, "nope") }), "adb");
    assert.equal(resolveOut(undefined, "/w"), "/w/.vqa");
    assert.equal(resolveOut("gifs", "/w"), "/w/gifs");
    assert.equal(resolveOut("/abs", "/w"), "/abs");
  } finally {
    process.env.HOME = oldHome;
  }
});

test("isOurMitmdump requires a live pid AND a mitmdump command line with our addon", () => {
  assert.equal(isOurMitmdump(process.pid, "/v/bin/python /v/bin/mitmdump -q -s /s/mock_addon.py --listen-port 8080"), true);
  assert.equal(isOurMitmdump(process.pid, "/usr/bin/node something"), false);
  assert.equal(isOurMitmdump(process.pid, "/v/bin/mitmdump -q --listen-port 8080"), false, "someone else's mitmdump");
  assert.equal(isOurMitmdump(2 ** 22 + 12345, "mitmdump mock_addon.py"), false, "dead pid");
});
