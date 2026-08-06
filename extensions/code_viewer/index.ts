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
import { annotateUntaggedFences } from "./fences.js";

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
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

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
