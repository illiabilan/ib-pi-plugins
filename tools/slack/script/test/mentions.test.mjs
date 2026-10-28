/**
 * Mention linking (pure, offline). A known name must become real `<@U…>` markup, and a token
 * we are not sure about must never become a mention of the wrong person.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { substitute } from "../mentions.mjs";

const DIR = {
  at: Date.now(),
  handles: {
    ostap: "U001",
    "ostap.bender": "U001",
    "ostap bender": "U001",
    ostapbender: "U001",
    ana: "U002",
    "ana silva": "U002",
    chris: "U003",
  },
  ambiguous: { alex: true },
  groups: { design: "S900", oncall: "S901" },
  chans: { backend: "C100", "api-team": "C101" },
  labels: { U001: "Ostap Bender", U002: "Ana Silva", U003: "Chris" },
};
const run = (t) => substitute(t, DIR);

const LINKING = [
  ["plain handle", "hey @ostap can you look", "hey <@U001> can you look"],
  ["dotted handle", "@ostap.bender ping", "<@U001> ping"],
  ["quoted display name", 'cc @"Ana Silva" please', "cc <@U002> please"],
  ["trailing comma kept outside the link", "@ostap, @ana: done", "<@U001>, <@U002>: done"],
  ["sentence-final period", "thanks @chris.", "thanks <@U003>."],
  ["two mentions in one line", "@ostap and @ana", "<@U001> and <@U002>"],
  ["broadcast here", "@here deploy is out", "<!here> deploy is out"],
  ["broadcast channel", "@channel heads up", "<!channel> heads up"],
  ["user group", "@design review needed", "<!subteam^S900> review needed"],
  ["channel link", "see #backend for logs", "see <#C100> for logs"],
  ["hyphenated channel", "#api-team owns it", "<#C101> owns it"],
  ["parenthesised mention", "(@ostap)", "(<@U001>)"],
  ["start of string", "@ostap hi", "<@U001> hi"],
  ["newline boundary", "line1\n@ana line2", "line1\n<@U002> line2"],
];
for (const [name, input, want] of LINKING) test(`links: ${name}`, () => assert.equal(run(input).text, want));

const NEVER = [
  ["email address", "write to ostap@company.com"],
  ["email with known handle", "ana@corp.io bounced"],
  ["already-linked user", "hey <@U001> again"],
  ["already-linked channel", "in <#C100>"],
  ["inline code", "run `ssh user@ostap` now"],
  ["fenced code", "```\ndocker run @ostap\n#backend\n```"],
  ["unknown person stays literal", "ping @nobody"],
  ["ambiguous name stays literal", "ping @alex"],
  ["unknown channel stays literal", "issue #1234 is open"],
  ["markdown heading", "# Backend notes"],
  ["url with @", "https://x.io/@ostap/post"],
  ["bare @", "email me @ work"],
];
for (const [name, input] of NEVER) test(`never a mention: ${name}`, () => assert.equal(run(input).text, input));

test("reporting: linked codes, labels, unknown and ambiguous", () => {
  const r = run("@ostap @nobody @alex @here #backend");
  assert.equal(r.linked.map((l) => l.code).join(","), "<@U001>,<!here>,<#C100>");
  assert.equal(r.linked[0].label, "Ostap Bender");
  assert.ok(r.unresolved.includes("@nobody"));
  assert.match(r.unresolved.join("|"), /@alex \(matches more than one person/);
});

test("clean text is untouched and links nothing", () => {
  const r = run("no mentions here at all");
  assert.equal(r.text, "no mentions here at all");
  assert.equal(r.linked.length + r.unresolved.length, 0);
});
