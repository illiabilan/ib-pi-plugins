import { detectLanguage } from "../detect.ts";
import { annotateUntaggedFences } from "../fences.ts";

const cases = [
  // The exact screenshot content: an ASCII architecture diagram with real
  // shell-looking tokens (podman run --rm, -e, git clone) embedded in a
  // clearly non-code tree/prose structure. Must NOT be highlighted as bash.
  ["screenshot-diagram", `Host\n  1. Trigger: /dev-cycle ADA-123 "additional prompt"\n  2. jira show ADA-123 -> summary/description/AC\n  3. Build task prompt from ticket + user prompt\n  4. podman run --rm \\\n       -e ANTHROPIC_API_KEY=... (copied key)\n       -e GIT_TOKEN=<scoped token>\n       -v /tmp/run-ADA-123-out:/out \\\n       dev-cycle-image\n     entrypoint.sh inside container:\n       git clone <repo> /work\n       cd /work && git checkout -b ADA-123-fix\n       pi -p "<task>" --no-session ... (autonomously)\n       git push, gh pr create --draft\n       echo '{"prUrl":...}' > /out/result.json\n  5. Host reads /out/result.json, shows PR link\n  6. (optional) comment in Jira with PR link\n  7. Container already removed (--rm), nothing left`, undefined],

  // A message mixing prose, an already-tagged block, and an untagged one,
  // to make sure per-block independence holds (tagging one must not affect
  // the other, order must be preserved, non-fence text must be untouched).
  ["mixed-message", null, null],

  // JSON that looks almost valid but has a trailing comma (invalid JSON) -
  // must not be force-coerced into "json" by a loose parser.
  ["json-trailing-comma", `{\n  "a": 1,\n  "b": 2,\n}`, undefined],

  // A code block that is real code but deliberately extremely short (near
  // the length gate) to check the gate doesn't accidentally admit garbage.
  ["tiny-snippet", `x=1`, undefined],

  // A block containing both Python-like and Bash-like signals at once
  // (a python heredoc invoked from a shell prompt) - ambiguous; either a
  // safe miss or one specific consistent answer is acceptable, but it must
  // not crash.
  ["ambiguous-py-in-bash", `cat <<'EOF' | python3\nfor i in range(3):\n    print(i)\nEOF`, "ambiguous"],

  // Pathological input: extremely long single line (no newlines) to check
  // regex performance doesn't blow up (catastrophic backtracking check).
  ["long-single-line", "x".repeat(200000), undefined],

  // Fence with a language token that has trailing garbage/metadata after
  // whitespace (should be treated as "already tagged", left untouched).
  ["fence-with-metadata", null, null],
];

let failures = 0;

// screenshot-diagram
{
  const [label, code, expected] = cases[0];
  const got = detectLanguage(code);
  console.log(`${got === expected ? "OK" : "FAIL"} ${label}: got=${got}`);
  if (got !== expected) failures++;
}

// mixed-message
{
  const msg = [
    "Some prose before.",
    "```",
    "console.log('hi')",
    "const x = 1;",
    "```",
    "Some prose between.",
    "```ruby",
    "puts 'already tagged, leave me alone'",
    "```",
    "Trailing prose.",
  ].join("\n");
  const out = annotateUntaggedFences(msg);
  const ok =
    out.includes("```javascript\nconsole.log") &&
    out.includes("```ruby\nputs") &&
    out.startsWith("Some prose before.") &&
    out.endsWith("Trailing prose.");
  console.log(`${ok ? "OK" : "FAIL"} mixed-message (independence + order + non-fence text preserved)`);
  if (!ok) { failures++; console.log(out); }
}

// json-trailing-comma
{
  const [label, code, expected] = cases[2];
  const got = detectLanguage(code);
  console.log(`${got === expected ? "OK" : "FAIL"} ${label}: got=${got}`);
  if (got !== expected) failures++;
}

// tiny-snippet
{
  const [label, code, expected] = cases[3];
  const got = detectLanguage(code);
  console.log(`${got === expected ? "OK" : "FAIL"} ${label}: got=${got}`);
  if (got !== expected) failures++;
}

// ambiguous-py-in-bash: just must not throw, and must not silently return something wildly wrong repeatedly (informational)
{
  const [label, code] = cases[4];
  let got;
  let threw = false;
  try { got = detectLanguage(code); } catch { threw = true; }
  console.log(`${!threw ? "OK" : "FAIL"} ${label}: got=${got} (informational, no hard requirement)`);
  if (threw) failures++;
}

// long-single-line: must complete quickly and not crash
{
  const [label, code, expected] = cases[5];
  const start = Date.now();
  const got = detectLanguage(code);
  const ms = Date.now() - start;
  const ok = got === expected && ms < 1000;
  console.log(`${ok ? "OK" : "FAIL"} ${label}: got=${got} in ${ms}ms`);
  if (!ok) failures++;
}

// fence-with-metadata
{
  const msg = "```js title=\"example.js\" showLineNumbers\nconsole.log(1)\n```";
  const out = annotateUntaggedFences(msg);
  const ok = out === msg; // must be a true no-op (already has a token after the fence)
  console.log(`${ok ? "OK" : "FAIL"} fence-with-metadata (already-tagged fence with extra metadata left untouched)`);
  if (!ok) { failures++; console.log(out); }
}

console.log(`\n${failures === 0 ? "ALL ADVERSARIAL CASES PASSED" : `${failures} ADVERSARIAL CASE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
