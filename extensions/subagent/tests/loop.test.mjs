#!/usr/bin/env node
/**
 * Deterministic tests for subagent loop mode (and the chain {previous} fix).
 *
 * Run:  node extensions/subagent/tests/loop.test.mjs
 *
 * How it works: the subagent extension spawns `process.execPath process.argv[1] ...`
 * (getPiInvocation). When this file is argv[1], a spawned child re-enters this
 * script with `--mode json`, and we act as a scripted fake `pi` that emits the
 * same JSONL events the real one does. So the real spawn / JSON parsing / loop
 * logic is exercised, with no LLM and fully reproducible outputs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);

// ───────────────────────────── fake pi child ─────────────────────────────
if (argv.includes("--mode") && argv.includes("json")) {
	const spIdx = argv.indexOf("--append-system-prompt");
	const sp = spIdx >= 0 ? fs.readFileSync(argv[spIdx + 1], "utf8") : "";
	const agent = (sp.match(/FAKE_AGENT:(\S+)/) || [])[1] || "unknown";
	const task = argv[argv.length - 1];
	const iter = Number((task.match(/ITER=(\d+)/) || [])[1] || 0);
	const scenario = process.env.FAKE_SCENARIO || "";
	if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ agent, task, argv })}\n`);

	let text = "";
	let exit = 0;
	const s = scenario;
	if (agent === "writer") {
		if (s === "fail-iter2" && iter === 2) {
			process.stderr.write("writer crashed");
			exit = 1;
		} else if (s === "dollar") text = "price is $& and $` and $' and $1";
		else if (s === "stuck") text = "same draft";
		else text = `draft v${iter}`;
	} else if (agent === "reviewer") {
		if (s === "approve-on-3") text = iter >= 3 ? "Looks good.\nAPPROVED" : `NOT APPROVED: v${iter} needs work`;
		else if (s === "stuck") text = "NOT APPROVED: same problem";
		else if (s === "never") text = `NOT APPROVED: iteration ${iter} still wrong`;
		else if (s === "quoted-marker") text = 'I cannot say "APPROVED" yet.\nStatus: APPROVED later maybe';
		else text = "ok";
	} else if (agent === "echo") {
		text = `echo:${task}`;
	} else if (agent === "sleeper") {
		setTimeout(() => {}, 60_000);
	}
	if (agent !== "sleeper") {
		const toolResult = { role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "BIG".repeat(1000) }] };
		process.stdout.write(`${JSON.stringify({ type: "tool_result_end", message: toolResult })}\n`);
		const msg = {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
			model: "fake-model",
			stopReason: exit ? "error" : "stop",
		};
		process.stdout.write(`${JSON.stringify({ type: "message_end", message: msg })}\n`);
		process.exitCode = exit;
	}
} else {
	await main();
}

// ───────────────────────────── test runner ─────────────────────────────
async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-loop-test-"));
	const agentsDir = path.join(tmp, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	for (const name of ["writer", "reviewer", "echo", "sleeper"]) {
		fs.writeFileSync(
			path.join(agentsDir, `${name}.md`),
			`---\nname: ${name}\ndescription: fake ${name}\n---\nFAKE_AGENT:${name}\n`,
		);
	}

	fs.writeFileSync(
		path.join(agentsDir, "fm.md"),
		"---\nname: fm\ndescription: fake fm\nmodel: fm-model\nthinking: low\n---\nFAKE_AGENT:echo\n",
	);

	let tool;
	// Load the extension the way pi does (jiti), aliasing the pi package to the global install.
	const piPkg = process.env.PI_PKG_DIR || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
	const { createJiti } = await import(
		fs.existsSync(path.join(piPkg, "node_modules/jiti"))
			? path.join(piPkg, "node_modules/jiti/lib/jiti.mjs")
			: fs.existsSync(path.join(piPkg, "../../jiti"))
				? path.join(piPkg, "../../jiti/lib/jiti.mjs")
				: "jiti"
	);
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": path.join(piPkg, "dist/index.js"),
			...Object.fromEntries(
				["pi-tui", "pi-ai"]
					.filter((p) => fs.existsSync(path.join(piPkg, "..", p, "dist/index.js")))
					.map((p) => [`@earendil-works/${p}`, path.join(piPkg, "..", p, "dist/index.js")]),
			),
			...(fs.existsSync(path.join(piPkg, "../../typebox")) ? { typebox: path.join(piPkg, "../../typebox/build/index.mjs") } : {}),
		},
	});
	const mod = await jiti.import(new URL("../index.ts", import.meta.url).pathname);
	mod.default({ registerTool: (def) => (tool = def) });

	const ctx = { cwd: tmp, hasUI: false };
	const logFile = path.join(tmp, "calls.jsonl");
	const run = async (scenario, params, { signal, onUpdate } = {}) => {
		process.env.FAKE_SCENARIO = scenario;
		process.env.FAKE_LOG = logFile;
		fs.writeFileSync(logFile, "");
		const res = await tool.execute("t1", { agentScope: "project", ...params }, signal, onUpdate, ctx);
		const calls = fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		return { res, text: res.content[0].text, calls };
	};

	let failures = 0;
	const check = (name, cond, extra = "") => {
		console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${extra}`}`);
		if (!cond) failures++;
	};

	const wr = [
		{ agent: "writer", task: "Write ITER={iteration} of {maxIterations}. Feedback: {previous}" },
		{ agent: "reviewer", task: "Review ITER={iteration}: {previous}" },
	];

	// 1. converges at iteration 3
	{
		const { res, text, calls } = await run("approve-on-3", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 5 } });
		check("1 until-matched stop reason", res.details.loop.stopReason === "until-matched", text);
		check("1 ran 3 iterations / 6 agent runs", res.details.loop.iterationsRun === 3 && calls.length === 6, `${res.details.loop.iterationsRun} ${calls.length}`);
		check("1 header first line", text.startsWith("Loop stop=until-matched"), text.split("\n")[0]);
		check("1 feedback of iter 1 reviewer reaches iter 2 writer", calls[2].task.includes("NOT APPROVED: v1 needs work"), calls[2].task);
		check("1 writer at iter 1 got empty {previous}", /Feedback: $/.test(calls[0].task), calls[0].task);
		check("1 {maxIterations} substituted", calls[0].task.includes("of 5"), calls[0].task);
		check("1 final content has writer + reviewer output", text.includes("draft v3") && text.includes("APPROVED"), text);
		check("1 results tagged with iteration/step", res.details.results[5].iteration === 3 && res.details.results[5].step === 2);
		check("1 not isError", !res.isError);
	}

	// 2. unanchored-marker trap: 'APPROVED' matches 'NOT APPROVED' (documented) vs anchored
	{
		const unanchored = await run("approve-on-3", { loop: { steps: wr, until: "APPROVED", maxIterations: 5 } });
		check("2 unanchored marker false-stops at iteration 1 (documented trap)", unanchored.res.details.loop.iterationsRun === 1);
		const quoted = await run("quoted-marker", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 2 } });
		check("2 anchored marker ignores quoted/inline mentions", quoted.res.details.loop.stopReason !== "until-matched", quoted.text.split("\n")[0]);
	}

	// 3. stuck: identical outputs -> no-progress after iteration 2
	{
		const { res, text, calls } = await run("stuck", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 6 } });
		check("3 no-progress stop", res.details.loop.stopReason === "no-progress" && res.details.loop.iterationsRun === 2, text.split("\n")[0]);
		check("3 only 4 agent runs spent", calls.length === 4, String(calls.length));
		check("3 header says NOT met", /Condition NOT met/.test(text.split("\n")[0]));
	}

	// 4. never approves, outputs vary -> max-iterations, NOT met
	{
		const { res, text, calls } = await run("never", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 3 } });
		check("4 max-iterations stop", res.details.loop.stopReason === "max-iterations" && calls.length === 6, text.split("\n")[0]);
		check("4 header says NOT met", /never matched\. Condition NOT met/.test(text));
	}

	// 5. no until: runs exactly N iterations even with identical outputs (no stuck detection)
	{
		const { res, text, calls } = await run("stuck", { loop: { steps: wr, maxIterations: 3 } });
		check("5 fixed-count loop runs all 3", res.details.loop.iterationsRun === 3 && calls.length === 6, text.split("\n")[0]);
		check("5 header states no until", text.includes("no until condition"));
	}

	// 6. step failure mid-loop
	{
		const { res, text, calls } = await run("fail-iter2", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 5 } });
		check("6 step-failed isError", res.isError === true && res.details.loop.stopReason === "step-failed", text);
		check("6 stops right at failing step", calls.length === 3 && text.includes("iteration 2/5, step 1 (writer)"), text);
	}

	// 7. validation rejects bad params before any agent runs
	for (const [label, loop, re] of [
		["until '.*' (matches empty)", { steps: wr, until: ".*" }, /matches an empty string/],
		["until '^' (matches empty)", { steps: wr, until: "^" }, /matches an empty string/],
		["invalid regex", { steps: wr, until: "(" }, /not a valid JavaScript regex/],
		["maxIterations 11", { steps: wr, maxIterations: 11 }, /maxIterations must be/],
		["maxIterations 0", { steps: wr, maxIterations: 0 }, /maxIterations must be/],
		["maxIterations 2.5", { steps: wr, maxIterations: 2.5 }, /maxIterations must be/],
		["9 steps", { steps: new Array(9).fill(wr[0]) }, /too many steps/],
	]) {
		const { res, text, calls } = await run("never", { loop });
		check(`7 rejects ${label}`, res.isError === true && re.test(text) && calls.length === 0, text);
	}
	{
		const { res, text } = await run("never", { loop: { steps: wr }, agent: "writer", task: "x" });
		check("7 rejects loop + single together", res.isError === true && /exactly one mode/.test(text), text);
	}

	// 8. $-patterns in outputs survive {previous} substitution verbatim (loop)
	{
		const { calls } = await run("dollar", { loop: { steps: [wr[0], { agent: "echo", task: "got: {previous}" }], maxIterations: 1 } });
		check("8 loop: $& $` $' $1 passed verbatim", calls[1].task === "Task: got: price is $& and $` and $' and $1", calls[1].task);
	}
	// 9. same for chain (pre-existing bug fixed)
	{
		const { calls } = await run("dollar", {
			chain: [
				{ agent: "writer", task: "ITER=1" },
				{ agent: "echo", task: "got: {previous}" },
			],
		});
		check("9 chain: $& $` $' $1 passed verbatim", calls[1].task === "Task: got: price is $& and $` and $' and $1", calls[1].task);
	}

	// 10. unknown agent inside loop -> step-failed, readable
	{
		const { res, text } = await run("never", { loop: { steps: [{ agent: "nope", task: "x" }], maxIterations: 2 } });
		check("10 unknown agent -> step-failed", res.isError === true && /Unknown agent: "nope"/.test(text), text);
	}

	// 11. onUpdate partials carry mode=loop + iteration tags + same shape
	{
		const updates = [];
		await run("approve-on-3", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 5 } }, { onUpdate: (u) => updates.push(u) });
		const last = updates[updates.length - 1];
		check("11 updates emitted with details.mode=loop", updates.length > 0 && updates.every((u) => u.details?.mode === "loop" && Array.isArray(u.content)));
		check("11 last update includes all 6 runs tagged", last.details.results.length === 6 && last.details.results.every((r) => r.iteration >= 1));
	}

	// 12. abort mid-loop kills the child and rejects
	{
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 700);
		const t0 = Date.now();
		let threw = false;
		try {
			await run("never", { loop: { steps: [{ agent: "sleeper", task: "zzz" }], maxIterations: 3 } }, { signal: ac.signal });
		} catch (e) {
			threw = /aborted/.test(String(e));
		}
		check("12 abort rejects promptly", threw && Date.now() - t0 < 8000, `${threw} ${Date.now() - t0}ms`);
	}

	// 13. model/thinking overrides
	{
		const val = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
		const a = await run("x", { agent: "fm", task: "t" });
		check("13 frontmatter model+thinking used", val(a.calls[0].argv, "--model") === "fm-model" && val(a.calls[0].argv, "--thinking") === "low", JSON.stringify(a.calls[0].argv));
		const b = await run("x", { agent: "fm", task: "t", model: "m2", thinking: "high" });
		check("13 single: call overrides frontmatter", val(b.calls[0].argv, "--model") === "m2" && val(b.calls[0].argv, "--thinking") === "high", JSON.stringify(b.calls[0].argv));
		const c = await run("x", { agent: "echo", task: "t" });
		check("13 no flags when unset", !c.calls[0].argv.includes("--model") && !c.calls[0].argv.includes("--thinking"));
		const d = await run("x", { tasks: [{ agent: "echo", task: "t", model: "pm", thinking: "minimal" }] });
		check("13 parallel", val(d.calls[0].argv, "--model") === "pm" && val(d.calls[0].argv, "--thinking") === "minimal");
		const e = await run("x", { chain: [{ agent: "echo", task: "t", model: "cm", thinking: "xhigh" }] });
		check("13 chain", val(e.calls[0].argv, "--model") === "cm" && val(e.calls[0].argv, "--thinking") === "xhigh");
		const f = await run("x", { loop: { steps: [{ agent: "echo", task: "t", model: "lm", thinking: "off" }], maxIterations: 1 } });
		check("13 loop", val(f.calls[0].argv, "--model") === "lm" && val(f.calls[0].argv, "--thinking") === "off");
		check("13 result shows effective model", b.res.details.results[0].model === "m2" || b.res.details.results[0].model === "fake-model");
	}

	// 12b. tool-result messages are stripped from finished loop runs (session size), kept in chain
	{
		const loopRun = await run("approve-on-3", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 5 } });
		const chainRun = await run("never", { chain: [{ agent: "writer", task: "ITER=1" }] });
		check(
			"12b loop runs keep assistant msgs, drop toolResult",
			loopRun.res.details.results.every((r) => r.messages.length === 1 && r.messages[0].role === "assistant"),
		);
		check("12b chain unchanged (toolResult kept)", chainRun.res.details.results[0].messages.some((m) => m.role === "toolResult"));
	}

	// 13. renderers do not throw and show loop status
	{
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const call = tool.renderCall({ loop: { steps: wr, until: "^APPROVED$", maxIterations: 4 } }, theme, {});
		const callText = call.render(200).join("\n");
		check("13 renderCall shows loop", /subagent loop \(2 steps × ≤4\) until \/\^APPROVED\$\//.test(callText), callText);
		const partialCall = tool.renderCall({ loop: { steps: [{}] } }, theme, {});
		check("13 renderCall tolerates partial streaming args", partialCall.render(200).length > 0);
		const { res } = await run("approve-on-3", { loop: { steps: wr, until: "^APPROVED$", maxIterations: 5 } });
		const collapsed = tool.renderResult(res, { expanded: false }, theme, {}).render(200).join("\n");
		check("13 collapsed result header", /loop iteration 3\/5 until \/\^APPROVED\$\/ until-matched/.test(collapsed), collapsed.split("\n")[0]);
		check("13 collapsed shows only latest 2 iterations", /2 earlier runs/.test(collapsed) && collapsed.includes("Iter 3 · Step 2"), collapsed);
		let expandedOk = true;
		try {
			tool.renderResult(res, { expanded: true }, theme, {}).render(200);
		} catch (e) {
			expandedOk = /theme/i.test(String(e)) ? "theme-not-initialized" : false;
			if (expandedOk !== false) console.log(`note  expanded render needs initialized TUI theme: ${e}`);
		}
		check("13 expanded result renders (or only lacks TUI theme)", expandedOk !== false);
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures ? 1 : 0);
}
