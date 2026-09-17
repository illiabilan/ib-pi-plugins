/**
 * Validation-only helper extension for sound-notify. NOT part of the product.
 *
 * Provides:
 *   - tool `harness_ask`: opens a real blocking ctx.ui dialog (so `ui_prompt_start`
 *     fires exactly like git/file_ops/gh do), optionally sleeping afterwards so a
 *     pty test can observe that the "ask" sound already rang WHILE Pi was blocked.
 *   - tool `harness_noop`: cheap tool to generate multi-tool-call runs.
 *   - provider `harness-broken`: points at a dead port so a run ends with
 *     stopReason "error" (exercises the error-sound path without burning tokens).
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

function log(line: string) {
	const p = process.env.PI_SOUND_HARNESS_LOG;
	if (!p) return;
	try {
		appendFileSync(p, `${Date.now()} ${line}\n`);
	} catch {}
}

export default function harness(pi: ExtensionAPI) {
	pi.registerProvider("harness-broken", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "nope",
		api: "openai-completions",
		models: [
			{
				id: "dead-model",
				name: "dead-model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8000,
				maxTokens: 512,
			},
		],
	});

	pi.registerTool({
		name: "harness_ask",
		label: "Harness Ask",
		description: "Test-only: opens a blocking confirmation dialog and reports what the user chose.",
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.Optional(Type.String({ description: "Question to show" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			log(`harness_ask:before-confirm hasUI=${ctx.hasUI} mode=${ctx.mode}`);
			const answer = await ctx.ui.confirm("Harness", params.question ?? "Proceed?");
			log(`harness_ask:after-confirm answer=${answer}`);
			// Hold the turn open a moment so a pty observer can diff timings.
			await new Promise((r) => setTimeout(r, 1500));
			return { content: [{ type: "text", text: `user answered: ${answer}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "harness_noop",
		label: "Harness Noop",
		description: "Test-only: returns the number you pass. Call it when asked to.",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(_id, params) {
			log(`harness_noop n=${params.n}`);
			return { content: [{ type: "text", text: `n=${params.n}` }], details: {} };
		},
	});
}
