/**
 * file_ops — safe, previewable filesystem mutations for pi.
 *
 * Replaces the shell mutation idioms that dominate real sessions:
 *   rm -rf / rm -f <paths>      -> {action:"remove", paths, recursive, force}
 *   mkdir -p a/b/c              -> {action:"mkdir", paths}
 *   cp / cp -r src dst          -> {action:"copy", from, to, recursive, overwrite}
 *   mv src dst                  -> {action:"move", from, to, overwrite}
 *   ln -s target link           -> {action:"symlink", from:target, to:link}
 *   chmod [-R] 755 path         -> {action:"chmod", paths, mode:"755", recursive}
 *   touch path                  -> {action:"touch", paths}
 *
 * Safety model (see README.md for the full table):
 *   1. Nothing is ever mutated on the first call. Every mutating call returns a
 *      precise preview (resolved absolute paths, entry counts, byte totals).
 *   2. Execution requires explicit approval: an interactive ctx.ui.confirm() when
 *      a UI is available, otherwise the caller must repeat the identical call with
 *      confirm:"<token>" from the preview. The token is a hash of the *observed*
 *      plan, so it becomes invalid if the filesystem changed since the preview.
 *   3. Some operations are refused outright and cannot be confirmed at all
 *      (empty/unexpanded-variable paths, "/", $HOME, ~/.pi, ~/.ssh, ancestors of
 *      cwd, ...). These are hard blocks, not warnings.
 *   4. dryRun is side-effect free for every action (stat/readdir only).
 *   5. Recursive removal never follows symlinks — links are unlinked, never
 *      descended into, and the count is reported.
 */

import {
	formatSize,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	globSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ACTIONS = ["mkdir", "copy", "move", "remove", "symlink", "chmod", "touch"] as const;
type Action = (typeof ACTIONS)[number];

/** Above this many affected entries a plan is flagged HIGH risk. */
const LOUD_ENTRY_THRESHOLD = 25;
/** Above this many affected bytes a plan is flagged HIGH risk. */
const LOUD_BYTE_THRESHOLD = 100 * 1024 * 1024;
/** Hard cap on directory-walk work done for previews (keeps previews fast). */
const MAX_WALK = 20_000;
/** Approval tokens older than this are considered stale. */
const TOKEN_TTL_MS = 15 * 60 * 1000;
/** Max characters of report text returned to the model. */
const MAX_REPORT_CHARS = 20_000;

const HOME = homedir();

/**
 * Directories that must never be mutated destructively.
 *
 * NOTE: "/" deliberately must NOT be listed here. isUnder(x, "/") is true for every
 * absolute path, so including it refused every destructive operation everywhere
 * (caught empirically: `remove node_modules` inside a normal repo was rejected as
 * "inside the protected location /" — the /tmp benchmark fixture hid it because temp
 * roots are exempt). The filesystem root is covered by the exact-path ROOT refusal.
 */
const PROTECTED_PREFIXES: string[] = [
	"/usr",
	"/etc",
	"/System",
	"/bin",
	"/sbin",
	"/var",
	"/private",
	"/dev",
	"/opt",
	"/Library",
	"/Applications",
	join(HOME, ".pi"),
	join(HOME, ".ssh"),
	join(HOME, ".gnupg"),
	join(HOME, "Library"),
];

/** Writing anywhere inside these is refused even for non-destructive actions. */
const NO_WRITE_PREFIXES: string[] = [join(HOME, ".ssh"), join(HOME, ".gnupg")];

/**
 * Scratch roots that are exempt from PROTECTED_PREFIXES.
 *
 * On macOS the OS temp dir is /var/folders/<...>/T and /tmp is a symlink to /private/tmp,
 * i.e. every legitimate scratch path lives under the protected "/var" and "/private" roots.
 * Without this exemption file_ops refuses all temp-directory work — caught empirically:
 * the first guardrail run had every sandbox operation blocked as PROTECTED.
 * The roots themselves are still never removable; only paths INSIDE them are exempt.
 */
const TEMP_ROOTS: string[] = (() => {
	const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders", tmpdir()];
	const out = new Set<string>();
	for (const r of roots) {
		out.add(resolve(r));
		try {
			out.add(realpathSync(r));
		} catch {
			/* not present on this OS */
		}
	}
	return [...out];
})();

/** Exact paths that are refused for any mutating action, no confirmation possible. */
const NEVER: string[] = ["/", HOME, join(HOME, ".pi"), join(HOME, ".pi", "agent")];

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const Params = Type.Object({
	action: StringEnum(ACTIONS, {
		description: "mkdir/remove/touch/chmod use `paths`; copy/move/symlink use `from`+`to` (for symlink, `from` = link target, `to` = the link).",
	}),
	paths: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description:
				"Path(s) for mkdir/remove/touch/chmod. Relative to cwd, `~` expanded, globs expanded by the tool (no shell). Empty or $VAR-containing paths are refused.",
		}),
	),
	from: Type.Optional(Type.String({ description: "copy/move source, or the symlink's target (relative -> relative symlink)." })),
	to: Type.Optional(
		Type.String({
			description: "copy/move/symlink destination. An existing directory means 'put the source inside it' (cp/mv); the preview shows the resolved destination.",
		}),
	),
	recursive: Type.Optional(
		Type.Boolean({
			description: "Required to remove a directory or copy a tree (-r); chmod applies tree-wide; touch/mkdir create missing parents (mkdir is always -p).",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "remove: skip missing paths (rm -f). symlink: replace an existing link at `to`. Never disables a safety check or the approval step.",
		}),
	),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview only, guaranteed side-effect free, returns no token." })),
	overwrite: Type.Optional(
		StringEnum(["never", "ask", "always"], {
			description: "copy/move when the destination exists: 'never' (default, skipped+reported), 'always', or 'ask' (interactive only).",
		}),
	),
	mode: Type.Optional(Type.String({ description: 'chmod mode: octal ("755") or simple symbolic ("+x", "-w", "+rx").' })),
	confirm: Type.Optional(
		Type.String({
			description: "Approval token from a preview of the IDENTICAL call. Pass only after the user approved that preview; bound to filesystem state and expires.",
		}),
	),
});
type ParamsT = Static<typeof Params>;

// ---------------------------------------------------------------------------
// path handling
// ---------------------------------------------------------------------------

type Kind = "missing" | "file" | "dir" | "symlink" | "other";

interface Target {
	raw: string;
	path: string;
	kind: Kind;
	linkTo?: string;
	/** Recursive entry count for directories (excludes the directory itself). */
	entries?: number;
	bytes?: number;
	/** Symlinks encountered inside a directory (never followed). */
	symlinks?: number;
	walkTruncated?: boolean;
	unreadable?: number;
	fromGlob?: boolean;
}

class Refusal extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function stripAt(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

/** Resolve one user-supplied path string, refusing the classic footguns before touching the disk. */
function resolvePathArg(raw: unknown, cwd: string, label: string): string {
	if (raw === undefined || raw === null)
		throw new Refusal("EMPTY_PATH", `${label} is missing. Refusing to guess a path.`);
	if (typeof raw !== "string")
		throw new Refusal("EMPTY_PATH", `${label} must be a string, got ${typeof raw}.`);
	const s = stripAt(raw).trim();
	if (s === "")
		throw new Refusal(
			"EMPTY_PATH",
			`${label} is empty. Refusing: an empty path is the classic \`rm -rf $VAR/\` bug (it would target ${cwd} or /).`,
		);
	if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(s) || s.includes("`"))
		throw new Refusal(
			"UNEXPANDED_VAR",
			`${label} contains an unexpanded shell variable or command substitution (${s}). ` +
				"file_ops never runs a shell, so it cannot expand it. Resolve the value first and pass a literal path.",
		);
	const expanded = s === "~" ? HOME : s.startsWith("~/") ? join(HOME, s.slice(2)) : s;
	const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	return abs;
}

function hasGlobChars(s: string): boolean {
	return /[*?[]/.test(s);
}

function lookup(path: string): { kind: Kind; linkTo?: string } {
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink()) {
			let linkTo: string | undefined;
			try {
				linkTo = readlinkSync(path);
			} catch {
				/* ignore */
			}
			return { kind: "symlink", linkTo };
		}
		if (st.isDirectory()) return { kind: "dir" };
		if (st.isFile()) return { kind: "file" };
		return { kind: "other" };
	} catch {
		return { kind: "missing" };
	}
}

interface WalkStats {
	entries: number;
	bytes: number;
	symlinks: number;
	truncated: boolean;
	unreadable: number;
}

/** Recursively measure a directory WITHOUT following symlinks. Cheap, capped, read-only. */
function walk(root: string): WalkStats {
	const out: WalkStats = { entries: 0, bytes: 0, symlinks: 0, truncated: false, unreadable: 0 };
	const stack = [root];
	while (stack.length > 0) {
		if (out.entries >= MAX_WALK) {
			out.truncated = true;
			break;
		}
		const dir = stack.pop()!;
		let dirents;
		try {
			dirents = readdirSync(dir, { withFileTypes: true });
		} catch {
			out.unreadable++;
			continue;
		}
		for (const d of dirents) {
			const child = join(dir, d.name);
			out.entries++;
			if (d.isSymbolicLink()) {
				out.symlinks++;
				continue; // never followed
			}
			if (d.isDirectory()) {
				stack.push(child);
				continue;
			}
			try {
				out.bytes += lstatSync(child).size;
			} catch {
				out.unreadable++;
			}
		}
	}
	return out;
}

function describe(path: string, raw: string, fromGlob = false): Target {
	const { kind, linkTo } = lookup(path);
	const t: Target = { raw, path, kind, linkTo, fromGlob };
	if (kind === "dir") {
		const w = walk(path);
		t.entries = w.entries;
		t.bytes = w.bytes;
		t.symlinks = w.symlinks;
		if (w.truncated) t.walkTruncated = true;
		if (w.unreadable) t.unreadable = w.unreadable;
	} else if (kind === "file") {
		try {
			t.bytes = lstatSync(path).size;
		} catch {
			/* ignore */
		}
	}
	return t;
}

function isUnder(child: string, parent: string): boolean {
	if (parent === "/") return child !== "/";
	if (child === parent) return true;
	return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function outsideCwd(path: string, cwd: string): boolean {
	const rel = relative(cwd, path);
	return rel === "" ? false : rel.startsWith("..") || isAbsolute(rel);
}

/** True for paths inside an OS scratch root (exempt from protected-prefix rules). */
function inTempRoot(path: string): boolean {
	return TEMP_ROOTS.some((r) => isUnder(path, r) && path !== r);
}

function protectedPrefixFor(path: string): string | undefined {
	if (inTempRoot(path)) return undefined;
	// Longest match wins so the message names the most specific protected root.
	let best: string | undefined;
	for (const p of PROTECTED_PREFIXES) {
		if (isUnder(path, p) && (!best || p.length > best.length)) best = p;
	}
	return best;
}

function gitDirComponent(path: string): boolean {
	return path.split(sep).includes(".git");
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

interface Plan {
	action: Action;
	targets: Target[];
	src?: Target;
	/** copy/move/symlink final destination after cp/mv "into existing dir" resolution. */
	dest?: { raw: string; path: string; kind: Kind; intoDir: boolean };
	conflicts?: { count: number; sample: string[]; truncated: boolean };
	recursive: boolean;
	force: boolean;
	overwrite: "never" | "ask" | "always";
	mode?: string;
	hasGlob: boolean;
	risk: { level: "normal" | "high"; reasons: string[] };
	notes: string[];
	totals: { entries: number; bytes: number };
	/**
	 * Provenance of the entry/byte counts shown in the preview:
	 * "exact"       — the whole tree was walked and measured.
	 * "lower-bound" — the walk hit the ${MAX_WALK} cap or unreadable directories, so the
	 *                 real blast radius is LARGER than the preview says. Machine-visible
	 *                 on purpose so callers can be extra careful instead of trusting prose.
	 */
	counts: "exact" | "lower-bound";
}

/** Destructive = data can be lost. These get the strict protected-path refusals. */
function isDestructive(action: Action): boolean {
	return action === "remove" || action === "move" || action === "chmod";
}

function collectTargets(params: ParamsT, cwd: string, label: string): Target[] {
	const rawList =
		params.paths === undefined ? [] : Array.isArray(params.paths) ? params.paths : [params.paths];
	if (rawList.length === 0)
		throw new Refusal("EMPTY_PATH", `${label} requires 'paths'. Refusing to guess a path.`);
	const out: Target[] = [];
	const seen = new Set<string>();
	for (const raw of rawList) {
		if (typeof raw === "string" && hasGlobChars(stripAt(raw).trim())) {
			// Expand globs ourselves (no shell): keeps spaces/unicode safe and makes the
			// expansion visible in the preview instead of hidden inside a shell word split.
			const pat = stripAt(raw).trim();
			if (pat === "") throw new Refusal("EMPTY_PATH", `${label}: empty glob pattern.`);
			if (/\$\{?[A-Za-z_]/.test(pat))
				throw new Refusal("UNEXPANDED_VAR", `${label}: glob contains an unexpanded variable (${pat}).`);
			const base = isAbsolute(pat) ? undefined : cwd;
			let matches: string[] = [];
			try {
				matches = globSync(pat, base ? { cwd: base } : {}) as string[];
			} catch (e) {
				throw new Refusal("BAD_GLOB", `${label}: glob ${pat} failed: ${(e as Error).message}`);
			}
			if (matches.length === 0) continue; // reported as "no matches" in the preview
			for (const m of matches) {
				const abs = isAbsolute(m) ? resolve(m) : resolve(base ?? cwd, m);
				if (seen.has(abs)) continue;
				seen.add(abs);
				out.push(describe(abs, raw, true));
			}
			continue;
		}
		const abs = resolvePathArg(raw, cwd, `${label} path`);
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push(describe(abs, String(raw)));
	}
	return out;
}

function parseMode(mode: string | undefined): { octal?: number; symbolic?: { add: boolean; bits: string } } {
	if (!mode) throw new Refusal("BAD_MODE", "chmod requires 'mode' (e.g. \"755\" or \"+x\").");
	const m = mode.trim();
	if (/^0?[0-7]{3,4}$/.test(m)) return { octal: parseInt(m, 8) };
	const sym = /^([+-])([rwx]+)$/.exec(m);
	if (sym) return { symbolic: { add: sym[1] === "+", bits: sym[2] } };
	throw new Refusal(
		"BAD_MODE",
		`chmod mode "${mode}" not understood. Use octal ("755", "0644") or simple symbolic ("+x", "-w", "+rx").`,
	);
}

/** Count destination files that already exist for a directory copy/move. */
function countConflicts(src: string, destRoot: string): { count: number; sample: string[]; truncated: boolean } {
	const sample: string[] = [];
	let count = 0;
	let seen = 0;
	let truncated = false;
	const stack: Array<{ dir: string; rel: string }> = [{ dir: src, rel: "" }];
	while (stack.length > 0) {
		if (seen >= MAX_WALK) {
			truncated = true;
			break;
		}
		const { dir, rel } = stack.pop()!;
		let dirents;
		try {
			dirents = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirents) {
			seen++;
			const childRel = rel ? join(rel, d.name) : d.name;
			const destPath = join(destRoot, childRel);
			if (d.isDirectory() && !d.isSymbolicLink()) {
				stack.push({ dir: join(dir, d.name), rel: childRel });
				continue;
			}
			if (existsSync(destPath)) {
				count++;
				if (sample.length < 5) sample.push(destPath);
			}
		}
	}
	return { count, sample, truncated };
}

function buildPlan(params: ParamsT, cwd: string): Plan {
	const action = params.action;
	const recursive = params.recursive === true;
	const force = params.force === true;
	const overwrite = (params.overwrite ?? "never") as Plan["overwrite"];
	const notes: string[] = [];
	const reasons: string[] = [];

	let targets: Target[] = [];
	let src: Target | undefined;
	let dest: Plan["dest"];
	let conflicts: Plan["conflicts"];

	const pairActions: Action[] = ["copy", "move", "symlink"];
	if (pairActions.includes(action)) {
		if (params.paths !== undefined)
			throw new Refusal(
				"BAD_ARGS",
				`action '${action}' uses 'from' and 'to', not 'paths'. Make one call per source.`,
			);
		if (action === "symlink") {
			// `from` is the link target: may be relative-to-link and may legitimately not exist yet.
			const rawFrom = params.from;
			if (rawFrom === undefined || String(rawFrom).trim() === "")
				throw new Refusal("EMPTY_PATH", "symlink requires 'from' (what the link points at).");
			if (/\$\{?[A-Za-z_]/.test(String(rawFrom)))
				throw new Refusal("UNEXPANDED_VAR", `symlink 'from' has an unexpanded variable (${rawFrom}).`);
		}
		const fromAbs = resolvePathArg(params.from, cwd, `${action} 'from'`);
		const toAbs = resolvePathArg(params.to, cwd, `${action} 'to'`);
		src = describe(fromAbs, String(params.from));
		const toInfo = lookup(toAbs);
		const intoDir = toInfo.kind === "dir" && action !== "symlink";
		const finalPath = intoDir ? join(toAbs, basename(fromAbs)) : toAbs;
		const finalInfo = intoDir ? lookup(finalPath) : toInfo;
		dest = { raw: String(params.to), path: finalPath, kind: finalInfo.kind, intoDir };
		targets = [src];

		if (action !== "symlink" && src.kind === "missing")
			throw new Refusal("NO_SOURCE", `${action} source does not exist: ${fromAbs}`);
		if (action !== "symlink" && src.kind === "dir" && !recursive && action === "copy")
			throw new Refusal(
				"NEEDS_RECURSIVE",
				`${fromAbs} is a directory. Pass recursive:true to copy a directory tree.`,
			);
		if (action === "symlink" && src.kind === "missing")
			notes.push(`link target does not exist yet — the link will be dangling: ${fromAbs}`);
		if (dest.kind === "dir" && src.kind === "dir" && action === "copy")
			conflicts = countConflicts(fromAbs, finalPath);
		if (finalInfo.kind !== "missing" && overwrite === "never" && action !== "symlink")
			notes.push(`destination exists and overwrite='never' — it will be SKIPPED, not replaced`);
		if (finalInfo.kind !== "missing" && overwrite === "always")
			reasons.push(`destination already exists and overwrite='always' (it will be replaced)`);
		if (src.kind === "symlink") notes.push("source is a symlink; it is copied/moved as a link, not dereferenced");
	} else {
		targets = collectTargets(params, cwd, action);
		if (targets.length === 0)
			notes.push("no paths matched (glob expanded to nothing) — nothing to do");
	}

	const mode = action === "chmod" ? params.mode : undefined;
	if (action === "chmod") parseMode(mode); // validate early

	// ---- hard refusals -----------------------------------------------------
	const writeTargets: string[] = [];
	for (const t of targets) writeTargets.push(t.path);
	if (dest) writeTargets.push(dest.path);

	for (const t of targets) {
		if (t.path === "/")
			throw new Refusal("ROOT", `Refusing to ${action} the filesystem root (/).`);
		if (isDestructive(action)) {
			if (TEMP_ROOTS.includes(t.path))
				throw new Refusal(
					"PROTECTED",
					`Refusing to ${action} ${t.path}: that is a shared OS temp root. Target a specific subdirectory inside it instead.`,
				);
			if (NEVER.includes(t.path))
				throw new Refusal(
					"PROTECTED",
					`Refusing to ${action} ${t.path} — this path is on the never-touch list (${NEVER.join(", ")}). No confirmation can override this.`,
				);
			const prot = protectedPrefixFor(t.path);
			if (prot)
				throw new Refusal(
					"PROTECTED",
					`Refusing to ${action} ${t.path}: it is inside the protected location ${prot}. ` +
						"file_ops never performs destructive operations there. If this is truly intended, the user must do it manually.",
				);
			if (gitDirComponent(t.path))
				throw new Refusal(
					"GIT_DIR",
					`Refusing to ${action} ${t.path}: it is inside a .git directory (repository history is unrecoverable this way). Use git commands instead.`,
				);
			if (isUnder(cwd, t.path) && t.path !== cwd)
				throw new Refusal(
					"ANCESTOR_OF_CWD",
					`Refusing to ${action} ${t.path}: it is an ancestor of the session cwd (${cwd}).`,
				);
		}
	}
	for (const w of writeTargets) {
		for (const np of NO_WRITE_PREFIXES) {
			if (isUnder(w, np))
				throw new Refusal(
					"PROTECTED",
					`Refusing to write inside ${np} (${w}). Key material and secret stores are off limits to file_ops.`,
				);
		}
		if (w === "/") throw new Refusal("ROOT", `Refusing to ${action} the filesystem root (/).`);
		if (isDestructive(action) === false && NEVER.includes(w) && action !== "mkdir")
			throw new Refusal("PROTECTED", `Refusing to ${action} ${w} — never-touch path.`);
	}
	if (action === "remove") {
		for (const t of targets) {
			if (t.kind === "dir" && !recursive)
				throw new Refusal(
					"NEEDS_RECURSIVE",
					`${t.path} is a directory. Pass recursive:true to remove it (and re-read the preview: it will show the full entry count).`,
				);
			if (t.kind === "missing" && !force && !t.fromGlob)
				throw new Refusal("NO_SOURCE", `${t.path} does not exist. Pass force:true to ignore missing paths.`);
		}
	}

	// ---- risk classification ----------------------------------------------
	let entries = 0;
	let bytes = 0;
	for (const t of targets) {
		entries += 1 + (t.entries ?? 0);
		bytes += t.bytes ?? 0;
	}

	if (action === "remove" && recursive && targets.some((t) => t.kind === "dir"))
		reasons.push("RECURSIVE DELETE of a directory tree (not undoable)");
	if (action === "remove" && targets.some((t) => t.fromGlob))
		reasons.push("glob-expanded delete — the exact set of paths was computed, not typed by a human");
	for (const t of targets) {
		if (outsideCwd(t.path, cwd)) reasons.push(`${t.path} is OUTSIDE the session cwd (${cwd})`);
		const prot = protectedPrefixFor(t.path);
		if (prot) reasons.push(`${t.path} is inside the protected location ${prot}`);
		if (gitDirComponent(t.path)) reasons.push(`${t.path} is inside a .git directory`);
	}
	if (dest) {
		if (outsideCwd(dest.path, cwd)) reasons.push(`destination ${dest.path} is OUTSIDE the session cwd (${cwd})`);
		const prot = protectedPrefixFor(dest.path);
		if (prot) reasons.push(`destination ${dest.path} is inside the protected location ${prot}`);
	}
	if (action === "symlink" && src && outsideCwd(src.path, cwd))
		reasons.push(`symlink target ${src.path} escapes the session cwd (${cwd})`);
	if (entries > LOUD_ENTRY_THRESHOLD) reasons.push(`${entries} entries affected (> ${LOUD_ENTRY_THRESHOLD})`);
	if (bytes > LOUD_BYTE_THRESHOLD) reasons.push(`${formatSize(bytes)} affected (> ${formatSize(LOUD_BYTE_THRESHOLD)})`);
	if (conflicts && conflicts.count > 0 && overwrite === "always")
		reasons.push(`${conflicts.count} existing destination file(s) would be overwritten`);

	const symlinkCount = targets.reduce((n, t) => n + (t.symlinks ?? 0), 0);
	if (action === "remove" && symlinkCount > 0)
		notes.push(`${symlinkCount} symlink(s) inside the tree will be unlinked, never followed`);
	for (const t of targets)
		if (t.walkTruncated) notes.push(`${t.path} has more than ${MAX_WALK} entries — counts below are a lower bound`);

	return {
		action,
		targets,
		src,
		dest,
		conflicts,
		recursive,
		force,
		overwrite,
		mode,
		hasGlob: targets.some((t) => t.fromGlob),
		risk: { level: reasons.length > 0 ? "high" : "normal", reasons: [...new Set(reasons)] },
		notes,
		totals: { entries, bytes },
		counts: targets.some((t) => t.walkTruncated || (t.unreadable ?? 0) > 0) ? "lower-bound" : "exact",
	};
}

// ---------------------------------------------------------------------------
// preview + approval token
// ---------------------------------------------------------------------------

/**
 * Fingerprint the plan *including observed filesystem state*, so a token issued for a
 * 3-file directory cannot be replayed after that directory grew to 3000 files.
 */
function fingerprint(plan: Plan, cwd: string): string {
	const fp = {
		cwd,
		action: plan.action,
		recursive: plan.recursive,
		force: plan.force,
		overwrite: plan.overwrite,
		mode: plan.mode ?? null,
		targets: plan.targets.map((t) => ({
			p: t.path,
			k: t.kind,
			e: t.entries ?? null,
			b: t.bytes ?? null,
			l: t.linkTo ?? null,
		})),
		dest: plan.dest ? { p: plan.dest.path, k: plan.dest.kind } : null,
		conflicts: plan.conflicts?.count ?? null,
	};
	return "fileops-" + createHash("sha256").update(JSON.stringify(fp)).digest("hex").slice(0, 12);
}

/**
 * Number of user messages in the current session branch.
 *
 * This is the anchor for the same-turn self-approval guard: a token issued while the
 * user had sent N messages may only be redeemed once that count has grown, i.e. after
 * the user actually replied to the preview.
 */
function userTurnCount(ctx: { sessionManager?: { getEntries?: () => unknown[] } }): number {
	try {
		const entries = (ctx.sessionManager?.getEntries?.() ?? []) as Array<{
			type?: string;
			message?: { role?: string };
		}>;
		return entries.filter((e) => e?.type === "message" && e.message?.role === "user").length;
	} catch {
		return 0;
	}
}

/** Tokens we have issued, so we can tell "stale/state changed" from "never previewed". */
const issued = new Map<string, { at: number; userTurns: number }>();
function rememberToken(token: string, userTurns: number): void {
	// Keep the ORIGINAL issue turn: re-previewing in the same turn must not
	// advance the anchor and thereby unlock a same-turn confirm.
	const prev = issued.get(token);
	issued.set(token, { at: Date.now(), userTurns: prev?.userTurns ?? userTurns });
	if (issued.size > 200) {
		for (const [k, v] of issued) {
			if (Date.now() - v.at > TOKEN_TTL_MS) issued.delete(k);
			if (issued.size <= 100) break;
		}
	}
}
function tokenState(token: string): "fresh" | "expired" | "unknown" {
	const v = issued.get(token);
	if (v === undefined) return "unknown";
	return Date.now() - v.at > TOKEN_TTL_MS ? "expired" : "fresh";
}

function kindLabel(t: Target): string {
	switch (t.kind) {
		case "dir":
			return `dir, ${t.entries ?? 0} entries, ${formatSize(t.bytes ?? 0)}${t.symlinks ? `, ${t.symlinks} symlink(s)` : ""}`;
		case "file":
			return `file, ${formatSize(t.bytes ?? 0)}`;
		case "symlink":
			return `symlink -> ${t.linkTo ?? "?"}`;
		case "missing":
			return "does not exist";
		default:
			return "special file";
	}
}

function previewText(plan: Plan, cwd: string): string {
	const lines: string[] = [];
	const flags = [
		plan.recursive ? "recursive" : null,
		plan.force ? "force" : null,
		plan.action === "copy" || plan.action === "move" ? `overwrite=${plan.overwrite}` : null,
		plan.mode ? `mode=${plan.mode}` : null,
	].filter(Boolean);
	lines.push(`PLAN: ${plan.action}${flags.length ? ` (${flags.join(", ")})` : ""}   cwd=${cwd}`);

	if (plan.src && plan.dest) {
		lines.push(`  from: ${plan.src.path}   [${kindLabel(plan.src)}]`);
		lines.push(
			`  to:   ${plan.dest.path}   [${plan.dest.kind === "missing" ? "will be created" : `EXISTS: ${plan.dest.kind}`}]` +
				(plan.dest.intoDir ? `   (destination arg is an existing dir, so the source goes inside it)` : ""),
		);
		if (plan.conflicts && plan.conflicts.count > 0)
			lines.push(
				`  conflicts: ${plan.conflicts.count} existing file(s) at the destination` +
					(plan.conflicts.truncated ? " (count capped)" : "") +
					(plan.conflicts.sample.length ? `, e.g. ${plan.conflicts.sample.join(", ")}` : ""),
			);
	} else {
		for (const t of plan.targets) lines.push(`  ${t.path}   [${kindLabel(t)}]${t.fromGlob ? "  (from glob " + t.raw + ")" : ""}`);
		if (plan.targets.length > 1)
			lines.push(`  total: ${plan.totals.entries} entries, ${formatSize(plan.totals.bytes)}`);
	}

	if (plan.notes.length) for (const n of plan.notes) lines.push(`  note: ${n}`);
	lines.push(
		plan.counts === "exact"
			? "  counts: exact (whole tree measured)"
			: `  counts: LOWER-BOUND — the walk was capped at ${MAX_WALK} entries or hit unreadable directories, so the real number of affected files is HIGHER than shown`,
	);

	if (plan.risk.level === "high") {
		lines.push("");
		lines.push("!! HIGH RISK — requires an explicit, informed OK from the user:");
		for (const r of plan.risk.reasons) lines.push(`   - ${r}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface ExecReport {
	changed: string[];
	skipped: string[];
	errors: string[];
	stats: Record<string, number>;
}

/** Recursive delete that provably never follows symlinks (lstat-based, unlink for links). */
function rmTree(root: string, stats: { files: number; dirs: number; symlinks: number }): void {
	for (const d of readdirSync(root, { withFileTypes: true })) {
		const child = join(root, d.name);
		if (d.isSymbolicLink()) {
			unlinkSync(child);
			stats.symlinks++;
		} else if (d.isDirectory()) {
			rmTree(child, stats);
		} else {
			unlinkSync(child);
			stats.files++;
		}
	}
	rmdirSync(root);
	stats.dirs++;
}

function applyChmod(path: string, mode: ReturnType<typeof parseMode>, recursive: boolean, rep: ExecReport): void {
	const one = (p: string) => {
		const st = lstatSync(p);
		if (st.isSymbolicLink()) {
			rep.skipped.push(`${p}: symlink (not chmod'ed, links are never followed)`);
			return;
		}
		let next: number;
		if (mode.octal !== undefined) next = mode.octal;
		else {
			const bits = mode.symbolic!;
			let mask = 0;
			if (bits.bits.includes("r")) mask |= 0o444;
			if (bits.bits.includes("w")) mask |= 0o222;
			if (bits.bits.includes("x")) mask |= 0o111;
			next = bits.add ? (st.mode & 0o7777) | mask : (st.mode & 0o7777) & ~mask;
		}
		chmodSync(p, next);
		rep.changed.push(`${p} -> ${(next & 0o7777).toString(8).padStart(3, "0")}`);
	};
	one(path);
	if (!recursive) return;
	const stack = [path];
	while (stack.length) {
		const dir = stack.pop()!;
		let dirents;
		try {
			dirents = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			rep.errors.push(`${dir}: ${(e as Error).message}`);
			continue;
		}
		for (const d of dirents) {
			const child = join(dir, d.name);
			if (d.isSymbolicLink()) {
				rep.skipped.push(`${child}: symlink (not chmod'ed)`);
				continue;
			}
			if (d.isDirectory()) stack.push(child);
			try {
				one(child);
			} catch (e) {
				rep.errors.push(`${child}: ${(e as Error).message}`);
			}
		}
	}
}

function execute(plan: Plan): ExecReport {
	const rep: ExecReport = { changed: [], skipped: [], errors: [], stats: {} };
	const bump = (k: string, n = 1) => (rep.stats[k] = (rep.stats[k] ?? 0) + n);

	switch (plan.action) {
		case "mkdir":
			for (const t of plan.targets) {
				if (t.kind === "dir") {
					rep.skipped.push(`${t.path}: already exists`);
					continue;
				}
				if (t.kind !== "missing") {
					rep.errors.push(`${t.path}: exists and is a ${t.kind}, not a directory`);
					continue;
				}
				try {
					mkdirSync(t.path, { recursive: true });
					rep.changed.push(`${t.path} (created)`);
					bump("dirsCreated");
				} catch (e) {
					rep.errors.push(`${t.path}: ${(e as Error).message}`);
				}
			}
			break;

		case "touch":
			for (const t of plan.targets) {
				try {
					if (t.kind === "missing") {
						if (plan.recursive) mkdirSync(dirname(t.path), { recursive: true });
						closeSync(openSync(t.path, "a"));
						rep.changed.push(`${t.path} (created)`);
						bump("filesCreated");
					} else {
						const now = new Date();
						utimesSync(t.path, now, now);
						rep.changed.push(`${t.path} (mtime updated)`);
						bump("touched");
					}
				} catch (e) {
					rep.errors.push(`${t.path}: ${(e as Error).message}`);
				}
			}
			break;

		case "remove":
			for (const t of plan.targets) {
				try {
					if (t.kind === "missing") {
						rep.skipped.push(`${t.path}: does not exist${plan.force ? " (force)" : ""}`);
						continue;
					}
					if (t.kind === "symlink") {
						unlinkSync(t.path);
						rep.changed.push(`${t.path} (symlink unlinked, target untouched)`);
						bump("symlinksRemoved");
						continue;
					}
					if (t.kind === "dir") {
						const s = { files: 0, dirs: 0, symlinks: 0 };
						rmTree(t.path, s);
						rep.changed.push(
							`${t.path} (removed tree: ${s.files} files, ${s.dirs} dirs, ${s.symlinks} symlinks unlinked-not-followed)`,
						);
						bump("filesRemoved", s.files);
						bump("dirsRemoved", s.dirs);
						bump("symlinksRemoved", s.symlinks);
						continue;
					}
					unlinkSync(t.path);
					rep.changed.push(`${t.path} (removed, ${formatSize(t.bytes ?? 0)})`);
					bump("filesRemoved");
				} catch (e) {
					rep.errors.push(`${t.path}: ${(e as Error).message}`);
				}
			}
			break;

		case "copy": {
			const src = plan.src!;
			const dest = plan.dest!;
			try {
				if (dest.kind !== "missing" && plan.overwrite === "never" && src.kind !== "dir") {
					rep.skipped.push(`${dest.path}: exists and overwrite='never'`);
					break;
				}
				mkdirSync(dirname(dest.path), { recursive: true });
				if (src.kind === "dir") {
					cpSync(src.path, dest.path, {
						recursive: true,
						dereference: false,
						verbatimSymlinks: true,
						force: plan.overwrite === "always",
						errorOnExist: false,
					});
					rep.changed.push(
						`${src.path} -> ${dest.path} (tree copied, ${src.entries ?? 0} entries, ${formatSize(src.bytes ?? 0)}` +
							(plan.overwrite === "never" && plan.conflicts?.count
								? `, ${plan.conflicts.count} existing file(s) left untouched`
								: "") +
							")",
					);
				} else {
					cpSync(src.path, dest.path, { dereference: false, verbatimSymlinks: true, force: true });
					rep.changed.push(`${src.path} -> ${dest.path} (${formatSize(src.bytes ?? 0)})`);
				}
				bump("copied");
			} catch (e) {
				rep.errors.push(`${src.path} -> ${dest.path}: ${(e as Error).message}`);
			}
			break;
		}

		case "move": {
			const src = plan.src!;
			const dest = plan.dest!;
			try {
				if (dest.kind !== "missing" && plan.overwrite === "never") {
					rep.skipped.push(`${dest.path}: exists and overwrite='never'`);
					break;
				}
				mkdirSync(dirname(dest.path), { recursive: true });
				if (dest.kind !== "missing" && plan.overwrite === "always") {
					const dk = lookup(dest.path);
					if (dk.kind === "dir") {
						const s = { files: 0, dirs: 0, symlinks: 0 };
						rmTree(dest.path, s);
					} else unlinkSync(dest.path);
				}
				try {
					renameSync(src.path, dest.path);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
					// cross-device: copy then delete, preserving symlinks
					cpSync(src.path, dest.path, {
						recursive: src.kind === "dir",
						dereference: false,
						verbatimSymlinks: true,
						force: true,
					});
					if (src.kind === "dir") rmTree(src.path, { files: 0, dirs: 0, symlinks: 0 });
					else unlinkSync(src.path);
					rep.skipped.push("(cross-device move: copied then deleted the source)");
				}
				rep.changed.push(`${src.path} -> ${dest.path} (moved)`);
				bump("moved");
			} catch (e) {
				rep.errors.push(`${src.path} -> ${dest.path}: ${(e as Error).message}`);
			}
			break;
		}

		case "symlink": {
			const dest = plan.dest!;
			const linkTargetRaw = stripAt(String(plan.src!.raw)).trim();
			try {
				if (dest.kind !== "missing") {
					if (plan.force || plan.overwrite === "always") {
						if (dest.kind === "dir") {
							rep.errors.push(`${dest.path}: exists as a real directory — refusing to replace it with a symlink`);
							break;
						}
						unlinkSync(dest.path);
					} else {
						rep.skipped.push(`${dest.path}: exists (pass force:true to replace it)`);
						break;
					}
				}
				mkdirSync(dirname(dest.path), { recursive: true });
				symlinkSync(linkTargetRaw, dest.path);
				rep.changed.push(`${dest.path} -> ${linkTargetRaw} (symlink created)`);
				bump("symlinksCreated");
			} catch (e) {
				rep.errors.push(`${dest.path}: ${(e as Error).message}`);
			}
			break;
		}

		case "chmod": {
			const parsed = parseMode(plan.mode);
			for (const t of plan.targets) {
				if (t.kind === "missing") {
					rep.skipped.push(`${t.path}: does not exist`);
					continue;
				}
				try {
					applyChmod(t.path, parsed, plan.recursive, rep);
					bump("chmodded");
				} catch (e) {
					rep.errors.push(`${t.path}: ${(e as Error).message}`);
				}
			}
			break;
		}
	}
	return rep;
}

function reportText(plan: Plan, rep: ExecReport): string {
	const lines: string[] = [`DONE: ${plan.action}`];
	if (rep.changed.length) {
		lines.push(`changed (${rep.changed.length}):`);
		for (const c of rep.changed.slice(0, 40)) lines.push(`  + ${c}`);
		if (rep.changed.length > 40) lines.push(`  ... and ${rep.changed.length - 40} more`);
	} else lines.push("changed: nothing");
	if (rep.skipped.length) {
		lines.push(`skipped (${rep.skipped.length}):`);
		for (const s of rep.skipped.slice(0, 20)) lines.push(`  - ${s}`);
		if (rep.skipped.length > 20) lines.push(`  ... and ${rep.skipped.length - 20} more`);
	}
	if (rep.errors.length) {
		lines.push(`errors (${rep.errors.length}):`);
		for (const e of rep.errors.slice(0, 20)) lines.push(`  ! ${e}`);
		if (rep.errors.length > 20) lines.push(`  ... and ${rep.errors.length - 20} more`);
	}
	const stats = Object.entries(rep.stats)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	if (stats) lines.push(`stats: ${stats}`);
	return lines.join("\n");
}

function cap(text: string): string {
	return text.length > MAX_REPORT_CHARS
		? text.slice(0, MAX_REPORT_CHARS) + "\n... [file_ops output truncated]"
		: text;
}

// ---------------------------------------------------------------------------
// tool registration
// ---------------------------------------------------------------------------

const DESCRIPTION = `SAFE, previewed filesystem mutations (mkdir/copy/move/remove/symlink/chmod/touch) instead of bash rm, rm -rf, mkdir -p, cp -r, mv, ln -s, chmod, touch — bash gives no preview, no guardrails, no undo.

Two-step by design: the first call NEVER mutates. It returns a PLAN (resolved absolute paths, entry counts, byte totals, conflicts, any "!! HIGH RISK" block) plus a single-use approval token; repeating the IDENTICAL call with confirm:"<token>" executes it. Interactive sessions get a dialog instead. dryRun:true = preview only, guaranteed side-effect free, no token.

REFUSED and never confirmable: empty/missing paths, an unexpanded $VAR, "/", $HOME, ~/.pi, ~/.ssh, ~/.gnupg, other OS/system prefixes, any .git directory, any ancestor of the session cwd. Ordinary project dirs and /tmp/$TMPDIR are NOT protected.

Every preview ends with "counts: exact" (whole tree measured) or "counts: LOWER-BOUND" (walk capped / unreadable dirs, so the real blast radius is larger). Recursive removal never follows symlinks (links unlinked, targets untouched).

Ex: {"action":"remove","paths":"node_modules","recursive":true} (rm -rf) | {"action":"mkdir","paths":["build/tmp","build/out"]} | {"action":"copy","from":"dist","to":"/tmp/backup","recursive":true,"overwrite":"always"} | {"action":"move","from":"old.ts","to":"src/new.ts"} | {"action":"remove","paths":"tmp/*.log","dryRun":true}`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "file_ops",
		label: "File Ops",
		description: DESCRIPTION,
		promptSnippet:
			"Safe previewed filesystem mutations (mkdir/copy/move/remove/symlink/chmod/touch) with approval + guardrails",
		promptGuidelines: [
			"Use file_ops for every filesystem mutation (rm/rm -rf, mkdir -p, cp -r, mv, ln -s, chmod, touch) instead of bash; one call with a `paths` array beats several bash commands. It runs no shell: pass literal paths (spaces/unicode are safe) and resolve $VAR yourself. Keep bash for non-mutating inspection (ls, du, find) and build/git/package commands.",
			"NEVER pass `confirm` in the same turn as the preview that produced the token. A file_ops preview is a message TO THE USER: show it (with any '!! HIGH RISK' block and any 'counts: LOWER-BOUND' caveat), end your turn, and only repeat the identical call with confirm:\"<token>\" after the user has replied approving it. \"I approve in advance\" or \"don't ask me\" in the original request is NOT that approval. Never invent or reuse a token; re-preview if one is rejected.",
			"dryRun:true is for inspection only (how big is this directory, what does this glob hit) — it returns no token, so it wastes a round-trip when you actually intend to act. On REFUSED: report it and stop, no bash workaround.",
		],
		parameters: Params,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const params = rawParams as ParamsT;
			const cwd = ctx.cwd;

			// ---- plan (read-only) --------------------------------------------
			let plan: Plan;
			try {
				plan = buildPlan(params, cwd);
			} catch (e) {
				if (e instanceof Refusal) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`REFUSED (${e.code}): ${e.message}\n\n` +
									"Nothing was changed. This is a hard block in file_ops — do not retry it and do not run the " +
									"equivalent shell command; tell the user what was blocked and why.",
							},
						],
						details: { action: params.action, status: "refused", code: e.code },
					};
				}
				throw e;
			}

			const preview = previewText(plan, cwd);
			const nothingToDo = plan.targets.length === 0;

			if (params.dryRun) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${preview}\n\ndryRun: true — NOTHING was changed (read-only stat/readdir only).${nothingToDo ? "" : " Re-call without dryRun to get an approval token."}`,
						},
					],
					details: {
						action: plan.action,
						status: "dry-run",
						risk: plan.risk.level,
						paths: plan.targets.map((t) => t.path),
						totals: plan.totals,
						counts: plan.counts,
					},
				};
			}

			if (nothingToDo) {
				return {
					content: [{ type: "text" as const, text: `${preview}\n\nNothing to do — no paths matched.` }],
					details: { action: plan.action, status: "noop" },
				};
			}

			if ((plan.action === "copy" || plan.action === "move") && plan.overwrite === "ask" && !ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`${preview}\n\nREFUSED (AMBIGUOUS_OVERWRITE): overwrite='ask' needs an interactive session. ` +
								"Nothing was changed. Decide explicitly with overwrite:'never' (skip existing) or overwrite:'always' (replace).",
						},
					],
					details: { action: plan.action, status: "refused", code: "AMBIGUOUS_OVERWRITE" },
				};
			}

			// ---- approval ----------------------------------------------------
			const token = fingerprint(plan, cwd);
			if (ctx.hasUI) {
				const title = `${plan.risk.level === "high" ? "!! HIGH RISK " : ""}file_ops ${plan.action}`;
				const approved = await ctx.ui.confirm(title, preview);
				if (!approved) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${preview}\n\nUser DECLINED this file_ops ${plan.action}. Nothing was changed. Ask what to do differently instead of retrying.`,
							},
						],
						details: { action: plan.action, status: "declined" },
					};
				}
			} else {
				const turnsNow = userTurnCount(ctx as { sessionManager?: { getEntries?: () => unknown[] } });
				if (params.confirm !== token) {
					rememberToken(token, turnsNow);
					let why: string;
					if (!params.confirm) why = "No approval token was supplied.";
					else {
						const st = tokenState(params.confirm);
						why =
							st === "unknown"
								? `Token "${params.confirm}" was never issued for this exact call (wrong token, or the arguments changed).`
								: st === "expired"
									? `Token "${params.confirm}" has expired.`
									: `Token "${params.confirm}" was issued earlier, but the filesystem has CHANGED since that preview, so it no longer describes what would happen. Re-check the plan below.`;
					}
					return {
						content: [
							{
								type: "text" as const,
								text:
									`APPROVAL REQUIRED — nothing has been changed.\n\n${preview}\n\n${why}\n` +
									`Show this plan to the user (verbatim if HIGH RISK), get an explicit OK, then repeat this exact call with confirm:"${token}".\n` +
									`The token is bound to the plan above (paths, types, entry counts, sizes): if the filesystem changes, it stops working and you must re-preview.`,
							},
						],
						details: {
							action: plan.action,
							status: "needs-approval",
							risk: plan.risk.level,
							reasons: plan.risk.reasons,
							counts: plan.counts,
							token,
							paths: plan.targets.map((t) => t.path),
							totals: plan.totals,
						},
					};
				}
				// ---- token matches: now prove a HUMAN approved it -------------------
				// Without this, the model can read its own preview and replay the token inside
				// the SAME turn — which is exactly what happened when the guideline sentence
				// was removed during the schema diet (42 files deleted, no human in the loop).
				const seenAt = issued.get(params.confirm);
				const unattended = process.env.PI_FILE_OPS_UNATTENDED === "1";
				if (!unattended) {
					if (!seenAt) {
						return {
							content: [
								{
									type: "text" as const,
									text:
										`NOT EXECUTED — no preview for this exact plan was issued in this session, so there is nothing the user could have approved.\n\n${preview}\n\n` +
										`Call this WITHOUT confirm first, show the plan to the user, and wait for their reply.`,
								},
							],
							details: { action: plan.action, status: "refused", code: "NO_PREVIEW", token },
						};
					}
					if (turnsNow <= seenAt.userTurns) {
						return {
							content: [
								{
									type: "text" as const,
									text:
										`NOT EXECUTED — you are replaying the confirm token in the SAME turn that produced the preview, so the user has not actually approved anything.\n\n${preview}\n\n` +
										`Stop here. Show the plan above to the user (verbatim if HIGH RISK), end your turn, and repeat this call with confirm:"${token}" only after they reply approving it. ` +
										`"I approve in advance" / "don't ask me" in an earlier message is NOT that approval.`,
								},
							],
							details: {
								action: plan.action,
								status: "refused",
								code: "SELF_APPROVAL_BLOCKED",
								risk: plan.risk.level,
								token,
							},
						};
					}
				}
				issued.delete(params.confirm); // single use
			}

			// ---- execute (serialized per target path with pi's mutation queue) --
			const queueKey = plan.dest?.path ?? plan.targets[0]?.path ?? cwd;
			const rep = await withFileMutationQueue(queueKey, async () => execute(plan));

			return {
				content: [{ type: "text" as const, text: cap(reportText(plan, rep)) }],
				details: {
					action: plan.action,
					status: rep.errors.length ? "partial" : "done",
					risk: plan.risk.level,
					changed: rep.changed.length,
					skipped: rep.skipped.length,
					errors: rep.errors.length,
					stats: rep.stats,
				},
			};
		},
		renderCall(args, theme) {
			const a = args as ParamsT;
			const what =
				a.from !== undefined || a.to !== undefined
					? `${a.from ?? "?"} -> ${a.to ?? "?"}`
					: Array.isArray(a.paths)
						? a.paths.length > 2
							? `${a.paths.slice(0, 2).join(", ")} +${a.paths.length - 2}`
							: a.paths.join(", ")
						: String(a.paths ?? "");
			const flags = [
				a.recursive ? "-r" : null,
				a.force ? "-f" : null,
				a.dryRun ? "dry-run" : null,
				a.confirm ? "confirmed" : null,
			]
				.filter(Boolean)
				.join(" ");
			let text = theme.fg("toolTitle", theme.bold(`file_ops ${a.action} `));
			text += theme.fg(a.action === "remove" ? "warning" : "accent", what);
			if (flags) text += theme.fg("dim", ` [${flags}]`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const first = result.content[0];
			const text = (first && "text" in first ? first.text : "") ?? "";
			const color = text.startsWith("REFUSED")
				? "error"
				: text.startsWith("APPROVAL REQUIRED") || text.includes("HIGH RISK")
					? "warning"
					: undefined;
			const lines = text.split("\n");
			const shown = !expanded && lines.length > 18 ? lines.slice(0, 18).join("\n") + `\n... ${lines.length - 18} more lines` : text;
			return new Text(color ? theme.fg(color, shown) : shown, 0, 0);
		},
	});
}
