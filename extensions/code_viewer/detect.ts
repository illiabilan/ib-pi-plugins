/**
 * Deterministic language detection for un-tagged fenced code blocks.
 *
 * This intentionally does NOT use highlight.js's statistical highlightAuto()
 * detector. Empirically (see verify-risks.mjs) highlightAuto — even restricted
 * to a curated language subset — misidentifies short/ambiguous snippets
 * constantly (e.g. plain JS scored lower than a false "sql" match; an ASCII
 * tree diagram scored higher as "sql" than real SQL did). That is exactly
 * why pi's own built-in renderer already disables auto-detection for
 * language-less fences. Reintroducing it here would make output *less*
 * trustworthy than the current plain-text baseline.
 *
 * Instead we use a small set of hand-written, high-precision sniffers for
 * the languages that dominate real LLM output (JS/TS, Python, bash, JSON,
 * YAML, SQL, Go, Rust, Java, C#, C/C++, HTML, CSS, Dockerfile). Each rule
 * requires multiple corroborating signals before matching. If nothing
 * matches with confidence we return undefined and leave the block exactly
 * as the baseline renders it today — under-detecting is safe, mis-detecting
 * is not.
 */

export type DetectedLanguage =
	| "json"
	| "bash"
	| "python"
	| "javascript"
	| "typescript"
	| "ruby"
	| "sql"
	| "dockerfile"
	| "go"
	| "rust"
	| "java"
	| "csharp"
	| "cpp"
	| "html"
	| "css"
	| "yaml";

function firstNonEmptyLine(code: string): string {
	return code.split("\n").find((l) => l.trim().length > 0) ?? "";
}

function countMatches(code: string, re: RegExp): number {
	const m = code.match(re);
	return m ? m.length : 0;
}

function isJsonLike(code: string): boolean {
	const trimmed = code.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function isSqlLike(code: string): boolean {
	const head = code.trim().slice(0, 400);
	const startsSql =
		/^(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+TABLE|WITH\s+\w+\s+AS\s*\()/i.test(
			head,
		);
	if (!startsSql) return false;
	return /\b(FROM|WHERE|VALUES|SET|JOIN)\b/i.test(code);
}

function isDockerfileLike(code: string): boolean {
	const lines = code
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return false;
	if (!/^FROM\s+\S+/i.test(lines[0]!)) return false;
	return lines.some((l) => /^(RUN|COPY|ADD|CMD|ENTRYPOINT|EXPOSE|ENV|WORKDIR|ARG|LABEL|USER)\s/i.test(l));
}

function isGoLike(code: string): boolean {
	return /(^|\n)\s*package\s+main\b/.test(code) && /\bfunc\s+\w*\s*\(/.test(code);
}

function isRustLike(code: string): boolean {
	let score = 0;
	if (/\bfn\s+main\s*\(\s*\)/.test(code)) score++;
	if (/println!\s*\(/.test(code)) score++;
	if (/\blet\s+mut\s+\w+/.test(code)) score++;
	if (/\buse\s+std::/.test(code)) score++;
	if (/->\s*\w+.*\{/.test(code) && /\bfn\s+\w+/.test(code)) score++;
	if (/\bimpl\s+\w+/.test(code)) score++;
	return score >= 2;
}

function isJavaLike(code: string): boolean {
	if (/\bpublic\s+static\s+void\s+main\s*\(/.test(code)) return true;
	return /\bpublic\s+class\s+\w+/.test(code) && /;\s*$/m.test(code);
}

function isCSharpLike(code: string): boolean {
	let score = 0;
	if (/\busing\s+System(\.\w+)*;/.test(code)) score++;
	if (/\bnamespace\s+\w+/.test(code)) score++;
	if (/\bConsole\.(WriteLine|Write)\s*\(/.test(code)) score++;
	if (/\bpublic\s+(class|static)\b/.test(code)) score++;
	return score >= 2;
}

function isCppLike(code: string): boolean {
	let score = 0;
	if (/#include\s*<\w+>/.test(code)) score++;
	if (/\bstd::/.test(code)) score++;
	if (/\bint\s+main\s*\(/.test(code)) score++;
	if (/\bcout\s*<</.test(code)) score++;
	return score >= 2;
}

function isHtmlLike(code: string): boolean {
	const t = code.trim();
	if (/^<!DOCTYPE html/i.test(t)) return true;
	return /<html[\s>]/i.test(t) && /<\/html>/i.test(t);
}

function isCssLike(code: string): boolean {
	const t = code.trim();
	if (!/[{};]/.test(t)) return false;
	// Require an actual CSS-shaped selector (class, id, tag, or wildcard) as
	// the very first non-whitespace token, immediately followed (allowing a
	// comma-separated selector list) by "{". Plain identifiers like a TS/JS
	// method name ("void {", "foo {") must NOT match here — that was a real
	// false positive (a TypeScript class was misdetected as CSS because a
	// method body's "{...}" alone satisfied a looser selector pattern).
	const startsWithSelector = /^[.#]?[a-zA-Z][\w-]*(\s*,\s*[.#]?[a-zA-Z][\w-]*)*\s*\{/.test(t);
	if (!startsWithSelector) return false;
	// Reject anything containing common programming-language keywords/syntax
	// that real CSS never has — this is the guard that should have caught
	// the class-with-generics false positive even without the rule above.
	if (/\b(class|interface|function|const|let|var|return|import|public|private|protected|static)\b|=>|<\w+>/.test(t)) {
		return false;
	}
	return /[\w-]+\s*:\s*[^;{}]+;/.test(t);
}

function isYamlLike(code: string): boolean {
	const lines = code.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length < 3) return false;
	if (/[;{}]/.test(code)) return false; // YAML doesn't use these
	if (/\bfunction\b|\bdef\b|=>/.test(code)) return false;
	const kvLines = lines.filter((l) => /^[\s-]*[\w.\/-]+:\s*(.*)$/.test(l));
	if (kvLines.length / lines.length < 0.6) return false;
	// A short flat list of "Key: value" lines with no nesting, no list
	// markers, and no YAML-specific value syntax reads just as easily as
	// plain human notes ("Status: In Progress", "Owner: Alice") — a real
	// false positive found during validation. Require an actual structural
	// signal that this is YAML rather than prose: indentation (nesting),
	// a leading "- " list item, a document marker, or bracket/quote value
	// syntax — or enough lines that a coincidental flat list is unlikely.
	const hasIndentedLine = lines.some((l) => /^\s+\S/.test(l));
	const hasListMarker = lines.some((l) => /^\s*-\s/.test(l));
	const hasDocMarker = /^---/m.test(code);
	const hasYamlValueSyntax = lines.some((l) => /:\s*(\[|\{|['"]|&\w|\*\w)/.test(l));
	return hasIndentedLine || hasListMarker || hasDocMarker || hasYamlValueSyntax || lines.length >= 6;
}

function isBashLike(code: string): boolean {
	let score = 0;
	if (/^#!.*\b(bash|sh|zsh)\b/.test(firstNonEmptyLine(code))) score += 3;
	if (/\bdone\s*$/m.test(code)) score++;
	if (/\bfi\s*$/m.test(code)) score++;
	if (/\becho\s+/.test(code)) score++;
	if (/\$\([^)]+\)/.test(code)) score++;
	if (/^\s*for\s+\w+\s+in\s+.+;\s*do\b/m.test(code)) score++;
	if (/^\s*if\s+\[.+\];\s*then\b/m.test(code)) score++;
	const commandLineMatches = countMatches(
		code,
		/^\s*(sudo|apt-get|npm|yarn|pnpm|git|cd|ls|grep|curl|wget|export|mkdir|rm|mv|cp|chmod|docker|kubectl)\s+\S+/gm,
	);
	score += Math.min(commandLineMatches, 3);
	return score >= 2;
}

function isTypeScriptLike(code: string): boolean {
	let score = 0;
	if (/\binterface\s+\w+/.test(code)) score += 2;
	if (/:\s*(string|number|boolean|void|any|unknown)\b/.test(code)) score++;
	if (/\btype\s+\w+\s*=/.test(code)) score++;
	if (/<\w+>\(/.test(code)) score++;
	if (/\b(private|public|protected|readonly)\s+\w+/.test(code)) score++;
	if (/\w<[\w\s,<>[\]]+>/.test(code)) score++;
	return score >= 2 && /\bfunction\b|=>|\bconst\b|\blet\b|\bclass\b/.test(code);
}

function isJavaScriptLike(code: string): boolean {
	let score = 0;
	if (/\bfunction\s*\w*\s*\(/.test(code)) score++;
	if (/=>/.test(code)) score++;
	if (/\bconst\s+\w+\s*=/.test(code)) score++;
	if (/\blet\s+\w+\s*=/.test(code)) score++;
	if (/console\.(log|error|warn)\s*\(/.test(code)) score++;
	if (/\brequire\s*\(/.test(code) || /\bimport\s+.*\bfrom\b/.test(code)) score++;
	return score >= 2;
}

function isPythonLike(code: string): boolean {
	let score = 0;
	if (/^\s*def\s+\w+\s*\(.*\)\s*:\s*$/m.test(code)) score += 2;
	if (/^\s*class\s+\w+.*:\s*$/m.test(code)) score++;
	if (/^\s*import\s+\w+/m.test(code) || /^\s*from\s+\w+\s+import\b/m.test(code)) score++;
	if (/\bself\./.test(code)) score++;
	if (/^\s*(elif|except|print)\b/m.test(code)) score++;
	// Python legitimately uses `{`/`}` (dict/set literals, f-string
	// interpolation) and `;` (rare but valid) — blanket-rejecting on their
	// presence was too strict and caused real misses (e.g. an f-string
	// inside an otherwise unambiguous `def`+`import`+`if __name__` script).
	// What Python never has is a line ending in `{` the way C-family block
	// syntax does, or a `;`-terminated statement as the dominant style.
	const cLikeBlockOpen = /^\s*(if|for|while|def|class)\b[^:]*\{\s*$/m.test(code);
	return score >= 2 && !cLikeBlockOpen;
}

interface Rule {
	lang: DetectedLanguage;
	test: (code: string) => boolean;
}

const RULES: Rule[] = [
	{ lang: "json", test: isJsonLike },
	{ lang: "bash", test: (c) => /^#!.*\b(?:bash|sh|zsh)\b/.test(firstNonEmptyLine(c)) },
	{ lang: "python", test: (c) => /^#!.*\bpython[0-9.]*\b/.test(firstNonEmptyLine(c)) },
	{ lang: "javascript", test: (c) => /^#!.*\bnode\b/.test(firstNonEmptyLine(c)) },
	{ lang: "ruby", test: (c) => /^#!.*\bruby\b/.test(firstNonEmptyLine(c)) },
	{ lang: "sql", test: isSqlLike },
	{ lang: "dockerfile", test: isDockerfileLike },
	{ lang: "go", test: isGoLike },
	{ lang: "rust", test: isRustLike },
	{ lang: "java", test: isJavaLike },
	{ lang: "csharp", test: isCSharpLike },
	{ lang: "cpp", test: isCppLike },
	{ lang: "html", test: isHtmlLike },
	{ lang: "css", test: isCssLike },
	{ lang: "yaml", test: isYamlLike },
	{ lang: "bash", test: isBashLike },
	{ lang: "typescript", test: isTypeScriptLike },
	{ lang: "javascript", test: isJavaScriptLike },
	{ lang: "python", test: isPythonLike },
];

/** Minimum size (trimmed chars) before we even attempt detection. */
const MIN_CODE_LENGTH = 15;

/**
 * Catches numbered-outline / prose-with-embedded-commands blocks (e.g. an
 * architecture diagram like "1. Trigger: ...", "4. podman run --rm ...",
 * "5. Host reads ...") that individual language sniffers can still
 * false-positive on because a few of its lines genuinely look like shell
 * commands. This was a real bug found during validation: such a block
 * scored high enough on the bash heuristic (git/cd/echo command lines) to
 * get mislabeled, even though most of the block is a numbered prose
 * outline, not a script. A numbered-list structure is a strong, cheap,
 * and very low-risk-of-false-trigger signal that content is prose/outline
 * rather than a single language's source code, so it overrides every
 * other rule.
 */
function looksLikeNumberedProseOutline(code: string): boolean {
	const lines = code.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length < 4) return false;
	const numberedLines = lines.filter((l) => /^\s*\d+[.)]\s+\S/.test(l));
	return numberedLines.length >= 3 && numberedLines.length / lines.length >= 0.25;
}

export function detectLanguage(code: string): DetectedLanguage | undefined {
	const trimmed = code.trim();
	if (trimmed.length < MIN_CODE_LENGTH) return undefined;
	if (looksLikeNumberedProseOutline(trimmed)) return undefined;
	for (const rule of RULES) {
		try {
			if (rule.test(trimmed)) return rule.lang;
		} catch {
			// A rule throwing (e.g. pathological regex input) should never break
			// rendering — just skip it and fall through to the next rule.
		}
	}
	return undefined;
}
