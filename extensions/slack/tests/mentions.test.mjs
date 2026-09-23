/**
 * Mention-linking tests.
 *
 *   node tests/mentions.test.mjs
 *
 * The substitution is pure (text + directory -> text), so these run offline.
 * Two things must hold: a name we know becomes real `<@U…>` markup, and a token
 * we are not sure about is never turned into a mention of the wrong person.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// substitute() is internal on purpose; load the module source and evaluate the
// pure part of it, so the test needs no credentials and no network.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "index.ts"), "utf8");
const start = src.indexOf("const BROADCASTS");
const end = src.indexOf("/** The bare names still unresolved");
if (start < 0 || end < 0) {
  console.log("FAIL could not locate the mention-linking block in index.ts");
  process.exit(1);
}
const block = src
  .slice(start, end)
  .replace(/: Record<string, string>/g, "")
  .replace(/: Directory/g, "")
  .replace(/: MentionResult/g, "")
  .replace(/: MentionLink\[\]/g, "")
  .replace(/: string\[\]/g, "")
  .replace(/: string/g, "")
  .replace(/: boolean/g, "")
  .replace(/ as string/g, "");
const helpers = `const normKey = (s) => s.trim().toLowerCase().replace(/^@/, "");\n`;
const { substitute } = await import(
  `data:text/javascript,${encodeURIComponent(`${helpers}${block}\nexport { substitute, hasMentionCandidates };`)}`
);

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

let fails = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`      got:  ${got}\n      want: ${want}`);
};
const run = (t) => substitute(t, DIR);

console.log("--- linking ---");
eq("plain handle", run("hey @ostap can you look").text, "hey <@U001> can you look");
eq("dotted handle", run("@ostap.bender ping").text, "<@U001> ping");
eq("quoted display name", run('cc @"Ana Silva" please').text, "cc <@U002> please");
eq("trailing comma kept outside the link", run("@ostap, @ana: done").text, "<@U001>, <@U002>: done");
eq("sentence-final period", run("thanks @chris.").text, "thanks <@U003>.");
eq("two mentions in one line", run("@ostap and @ana").text, "<@U001> and <@U002>");
eq("broadcast here", run("@here deploy is out").text, "<!here> deploy is out");
eq("broadcast channel", run("@channel heads up").text, "<!channel> heads up");
eq("user group", run("@design review needed").text, "<!subteam^S900> review needed");
eq("channel link", run("see #backend for logs").text, "see <#C100> for logs");
eq("hyphenated channel", run("#api-team owns it").text, "<#C101> owns it");
eq("parenthesised mention", run("(@ostap)").text, "(<@U001>)");
eq("start of string", run("@ostap hi").text, "<@U001> hi");
eq("newline boundary", run("line1\n@ana line2").text, "line1\n<@U002> line2");

console.log("\n--- must NEVER become a mention ---");
eq("email address", run("write to ostap@company.com").text, "write to ostap@company.com");
eq("email with known handle", run("ana@corp.io bounced").text, "ana@corp.io bounced");
eq("already-linked user", run("hey <@U001> again").text, "hey <@U001> again");
eq("already-linked channel", run("in <#C100>").text, "in <#C100>");
eq("inline code", run("run `ssh user@ostap` now").text, "run `ssh user@ostap` now");
eq(
  "fenced code",
  run("```\ndocker run @ostap\n#backend\n```").text,
  "```\ndocker run @ostap\n#backend\n```",
);
eq("unknown person stays literal", run("ping @nobody").text, "ping @nobody");
eq("ambiguous name stays literal", run("ping @alex").text, "ping @alex");
eq("unknown channel stays literal", run("issue #1234 is open").text, "issue #1234 is open");
eq("markdown heading", run("# Backend notes").text, "# Backend notes");
eq("url with @", run("https://x.io/@ostap/post").text, "https://x.io/@ostap/post");
eq("bare @", run("email me @ work").text, "email me @ work");

console.log("\n--- reporting ---");
{
  const r = run("@ostap @nobody @alex @here #backend");
  const codes = r.linked.map((l) => l.code).join(",");
  eq("linked list", codes, "<@U001>,<!here>,<#C100>");
  eq("linked labels carry the real name", r.linked[0].label, "Ostap Bender");
  eq("unknown reported", r.unresolved.includes("@nobody"), true);
  eq("ambiguity reported with a reason", /@alex \(matches more than one person/.test(r.unresolved.join("|")), true);
}
{
  const r = run("no mentions here at all");
  eq("clean text is untouched", r.text, "no mentions here at all");
  eq("clean text links nothing", r.linked.length + r.unresolved.length, 0);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
