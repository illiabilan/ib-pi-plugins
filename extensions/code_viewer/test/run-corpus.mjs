import { detectLanguage } from "../detect.ts";
import { annotateUntaggedFences } from "../fences.ts";
import { positive, negative } from "./corpus.mjs";

let hits = 0; // correctly detected the exact expected language
let misses = 0; // safely detected nothing (acceptable, just lower recall)
let wrong = 0; // detected the WRONG language (precision failure — bad)

console.log("=== POSITIVE CASES (real code, no tag) ===");
for (const [label, expected, code] of positive) {
	const got = detectLanguage(code);
	if (got === expected) {
		hits++;
		console.log(`HIT   ${label}: ${got}`);
	} else if (got === undefined) {
		misses++;
		console.log(`MISS  ${label}: expected ${expected}, got nothing (safe, just missed opportunity)`);
	} else {
		wrong++;
		console.log(`WRONG ${label}: expected ${expected}, got ${got}  <-- PRECISION BUG`);
	}
}

console.log("\n=== NEGATIVE CASES (should NOT be tagged) ===");
let falsePositives = 0;
for (const [label, code] of negative) {
	const got = detectLanguage(code);
	if (got === undefined) {
		console.log(`OK    ${label}: correctly left untagged`);
	} else {
		falsePositives++;
		console.log(`FALSE-POSITIVE ${label}: incorrectly tagged as ${got}  <-- PRECISION BUG`);
	}
}

console.log("\n=== FENCE REWRITING (end-to-end) ===");
const multiBlockMsg = [
	"Here's the fix:",
	"",
	"```",
	"def add(a, b):",
	"    return a + b",
	"```",
	"",
	"And here's how to run it (already tagged, must stay untouched):",
	"",
	"```text",
	"$ python add.py",
	"```",
	"",
	"Nested-fence edge case (4-backtick outer fence containing a 3-backtick example):",
	"",
	"````markdown",
	"Use a fenced block like:",
	"```js",
	"console.log(1)",
	"```",
	"````",
].join("\n");
const rewritten = annotateUntaggedFences(multiBlockMsg);
const untouchedNoOp = annotateUntaggedFences("no fences here at all") === "no fences here at all";
console.log(rewritten);
console.log("\nno-op-when-nothing-to-change:", untouchedNoOp);
const keepsAlreadyTagged = rewritten.includes("```text\n$ python add.py");
const tagsUntagged = rewritten.includes("```python\ndef add(a, b):");
const preservesNestedFence = rewritten.includes("````markdown") && rewritten.includes("```js\nconsole.log(1)\n```\n````");
console.log("keeps already-tagged fence untouched:", keepsAlreadyTagged);
console.log("tags the untagged python fence:", tagsUntagged);
console.log("preserves nested 4-backtick fence structure:", preservesNestedFence);

console.log("\n=== SUMMARY ===");
console.log(`positive: ${hits} hit, ${misses} safe-miss, ${wrong} WRONG (of ${positive.length})`);
console.log(`negative: ${negative.length - falsePositives} correct, ${falsePositives} FALSE-POSITIVE (of ${negative.length})`);

const failed = wrong > 0 || falsePositives > 0 || !untouchedNoOp || !keepsAlreadyTagged || !tagsUntagged || !preservesNestedFence;
process.exit(failed ? 1 : 0);
