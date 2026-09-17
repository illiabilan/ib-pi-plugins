import { detectLanguage } from "./detect.js";

// Matches ``` (or longer runs of backticks) fences. Requires the closing
// fence to use the exact same backtick run length as the opening one
// (via backreference), which is the common case for LLM-generated markdown.
const FENCE_RE = /(^|\n)(`{3,})([^\n`]*)\n([\s\S]*?)\n\2(?=\n|$)/g;

/**
 * Scan `text` for fenced code blocks with no language tag and, when a
 * high-confidence deterministic sniff succeeds, insert the detected
 * language into the fence header so pi's built-in Markdown renderer's
 * existing `highlightCode()` picks it up automatically.
 *
 * Fences that already carry ANY language token (even one pi doesn't
 * recognize) are left completely untouched — we only ever fill in a
 * missing tag, never override an author-provided one.
 *
 * Returns the original string unchanged (same reference) if nothing
 * needed to change, so callers can cheaply detect "no-op".
 */
/**
 * Result of extracting a fenced code block that is the ENTIRE content of a
 * text part (i.e. nothing but the fence itself, modulo surrounding
 * whitespace). Only this exact case is safe to render as a boxed/no-fence
 * custom entry: since a message occupies exactly one slot in pi's flat
 * transcript entry list, and custom entries appended via pi.appendEntry()
 * during message_end land BEFORE that slot is persisted (verified against
 * a live session trace — not assumed), replacing a code block with a
 * sibling entry only preserves reading order when there is no other prose
 * in the message to get shuffled out of place. Any prose before or after
 * the fence would end up visually reordered, so this function deliberately
 * returns null unless the whole text is just the one fence.
 */
export interface SoleFence {
	lang: string;
	code: string;
}

const SOLE_FENCE_RE = /^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1$/;

export function extractSoleFence(text: string): SoleFence | null {
	const trimmed = text.trim();
	const match = SOLE_FENCE_RE.exec(trimmed);
	if (!match) return null;
	const [, , header, code] = match;
	return { lang: header.trim(), code };
}

export function annotateUntaggedFences(text: string): string {
	let changed = false;
	const result = text.replace(FENCE_RE, (match, pre: string, fence: string, header: string, code: string) => {
		const headerTrim = header.trim();
		if (headerTrim.length > 0) return match; // already tagged, leave alone

		const lang = detectLanguage(code);
		if (!lang) return match;

		changed = true;
		return `${pre}${fence}${lang}\n${code}\n${fence}`;
	});
	return changed ? result : text;
}
