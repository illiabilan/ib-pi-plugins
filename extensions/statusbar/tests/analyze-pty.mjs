// Extract footer paints from a pty capture produced by pty-smoke.py, per phase.
//   node tests/analyze-pty.mjs /tmp/sbar-pty/capture.raw
import { readFileSync } from "node:fs";
import { visibleWidth } from "./helpers.mjs";

const path = process.argv[2] ?? "/tmp/sbar-pty/capture.raw";
const buf = readFileSync(path);
const marks = readFileSync(`${path}.marks`, "utf8")
	.trim()
	.split("\n")
	.map((l) => {
		const [label, off] = l.split("\t");
		return { label, off: Number(off) };
	});

// Strip OSC/CSI/private-mode sequences (stripTerminalSequences leaves `\e[?25l`).
const clean = (s) =>
	s
		.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\u001b[()][A-Z0-9]/g, "");

const ERR_RE = /(Extension error|TypeError|ReferenceError|Cannot read|is not a function|UnhandledPromise)/g;
let prev = 0;
let errors = 0;
for (const { label, off } of marks) {
	const window = buf.subarray(prev, off).toString("utf8");
	prev = off;
	const lines = clean(window)
		.split(/[\r\n]+/)
		.map((l) => l.replace(/\s+$/, ""));
	const bars = [...new Set(lines.filter((l) => l.includes("π")))];
	const builtin = lines.filter((l) => /↑\d|\(main\)$/.test(l));
	const notify = [...new Set(lines.filter((l) => /statusbar (enabled|disabled)|statusbar segment /.test(l)))];
	console.log(`\n== ${label} ==`);
	for (const l of bars.slice(-3)) console.log(`   bar>     ${JSON.stringify(l)} w=${visibleWidth(l)}`);
	if (builtin.length) console.log(`   builtin> ${JSON.stringify(builtin[builtin.length - 1])}`);
	for (const n of notify) console.log(`   notify>  ${JSON.stringify(n)}`);
	const errs = window.match(ERR_RE);
	if (errs) {
		errors += errs.length;
		console.log(`   !! errors: ${[...new Set(errs)].join(", ")}`);
	}
}
console.log(`\nerror-ish matches in capture: ${errors}`);
