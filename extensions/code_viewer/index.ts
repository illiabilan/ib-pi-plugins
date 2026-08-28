/**
 * code_viewer — auto-highlights un-tagged fenced code blocks.
 *
 * Pi's built-in Markdown renderer already syntax-highlights fenced code
 * blocks when the fence carries a recognized language (```typescript,
 * ```python, etc. — see pi's theme.highlightCode()). But LLMs very often
 * emit fences with NO language tag at all (```` ``` ````), and pi
 * deliberately does not attempt to auto-detect the language for those,
 * because generic statistical auto-detection is unreliable on short
 * snippets (it can, and does, misidentify prose or ASCII diagrams as
 * random languages). The net effect the user sees: language-less code
 * blocks render as plain, uncolored text.
 *
 * This extension closes that gap conservatively: on each finalized
 * assistant message it scans fenced code blocks that have NO language
 * tag, and — only when a small set of high-precision deterministic
 * sniffers (see detect.ts) confidently recognizes the language — rewrites
 * the fence header to include it. Pi's existing renderer then highlights
 * it exactly as if the model had tagged it correctly itself. Blocks that
 * already carry a tag (even one pi doesn't recognize) are left completely
 * untouched, and blocks we're not confident about are left exactly as
 * they render today — this can only add coloring, never remove or change
 * it incorrectly relative to the current baseline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { annotateUntaggedFences, extractSoleFence } from "./fences.js";
import { detectLanguage } from "./detect.js";

interface BoxedFenceData {
	lang?: string;
	code: string;
}

interface TextPart {
	type: "text";
	text: string;
	[key: string]: unknown;
}

function isTextPart(part: unknown): part is TextPart {
	return (
		typeof part === "object" &&
		part !== null &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

export default function (pi: ExtensionAPI) {
	// Boxed, fence-free rendering for the narrow case where an assistant
	// message's ENTIRE content is a single fenced code block with no other
	// prose. See fences.ts (extractSoleFence) for why this must stay narrow:
	// pi.appendEntry() calls made during message_end are persisted BEFORE the
	// message itself (verified empirically against a live session trace), so
	// a box entry always renders immediately ABOVE the message slot it came
	// from. That is only visually correct when the message has nothing else
	// in it to be displaced out of order.
	pi.registerEntryRenderer<BoxedFenceData>("code_viewer-fence", (entry, _options, theme) => {
		const data = entry.data ?? { code: "" };
		const box = new Box(1, 0, (s) => theme.bg("customMessageBg", s));
		const highlighted = highlightCode(data.code, data.lang);
		for (const line of highlighted) box.addChild(new Text(line, 0, 0));
		return box;
	});

	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

		// Narrow, order-safe case: exactly one content part, and it is nothing
		// but a single fenced code block (modulo whitespace). Strip it from the
		// message and render it as a boxed custom entry instead.
		if (message.content.length === 1 && isTextPart(message.content[0])) {
			const sole = extractSoleFence(message.content[0].text);
			if (sole) {
				const lang = sole.lang || detectLanguage(sole.code) || undefined;
				pi.appendEntry<BoxedFenceData>("code_viewer-fence", { lang, code: sole.code });
				return {
					message: {
						...message,
						content: [{ ...message.content[0], text: "" }],
					},
				};
			}
		}

		// Otherwise: fall back to the conservative, always-order-safe behavior —
		// just fill in a detected language on untagged fences so pi's built-in
		// Markdown renderer syntax-highlights them (fences remain visible; this
		// only ever adds coloring, never reorders anything).
		let changedAny = false;
		const newContent = message.content.map((part) => {
			if (!isTextPart(part)) return part;
			const annotated = annotateUntaggedFences(part.text);
			if (annotated === part.text) return part;
			changedAny = true;
			return { ...part, text: annotated };
		});

		if (!changedAny) return undefined;

		return {
			message: {
				...message,
				content: newContent,
			},
		};
	});
}
