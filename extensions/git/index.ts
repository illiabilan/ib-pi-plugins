/**
 * Git extension for pi.
 *
 * One action-enum tool that replaces the ~150 raw `git ...` bash invocations a typical
 * pi session makes, and fixes the three concrete pains observed in real session traces:
 *
 *   1. Heredoc acrobatics for commit messages
 *        git commit -m "$(cat <<'EOF' ... EOF)"     ->  {action:"commit", message:"line1\nline2"}
 *      (the message is passed as a single execFile argv element: no shell, no quoting, no heredoc)
 *   2. `git diff <path>` flooding the context window
 *        ->  {action:"diff"} returns a numstat summary + a per-file-truncated patch and
 *            tells the caller exactly how to ask for more.
 *   3. Unguarded destructive commands (`git branch -D`, `git push --force`,
 *      `git commit --no-verify`, `git pull --allow-unrelated-histories`, `git reset --hard`)
 *        ->  every write action is preview-first: nothing runs until the caller echoes back
 *            the confirm token printed in the preview (and, in interactive sessions, the
 *            user also approves a dialog). Dangerous flags are called out loudly.
 *
 * No shell is ever spawned: all git calls go through execFile with an argv array, so paths
 * with spaces, quotes or newlines need no escaping.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Hard cap on characters returned to the LLM for any single call. */
const MAX_CHARS = 40_000;
/** Child-process stdout ceiling; we truncate in JS long before this. */
const MAX_BUFFER = 32 * 1024 * 1024;
const READ_TIMEOUT = 30_000;
/** push/pull/fetch talk to a remote and can legitimately take a while. */
const NETWORK_TIMEOUT = 180_000;

const DEF_CONTEXT = 3;
const DEF_MAX_LINES_PER_FILE = 80;
const DEF_MAX_TOTAL_LINES = 400;
const DEF_LOG_LIMIT = 20;
const DEF_SECTION_CAP = 40;
const DEF_BLAME_LINES = 200;

const READ_ACTIONS = [
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "blame",
  "merge_base",
  "rev_parse",
  "stash_list",
] as const;

const WRITE_ACTIONS = [
  "add",
  "commit",
  "checkout",
  "switch",
  "push",
  "pull",
  "fetch",
  "stash_push",
  "stash_pop",
  "branch_delete",
  "reset",
] as const;

const ALL_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS] as const;
type Action = (typeof ALL_ACTIONS)[number];
const isWrite = (a: string): boolean => (WRITE_ACTIONS as readonly string[]).includes(a);

/**
 * Writes that run WITHOUT the approval gate: moving HEAD between branches, and
 * creating a branch.
 *
 * Rationale: these are the only writes here that git itself already makes safe — it
 * refuses to switch when the move would overwrite local modifications, and the change
 * is undone by switching back. Gating them bought no safety and cost a whole
 * round-trip on the most frequent write in day-to-day work.
 *
 * Deliberately still gated: `checkout -- <paths>` (discards uncommitted work),
 * branch_delete, reset, commit, add, push, pull, fetch, stash. Any built command
 * carrying a DANGER note or a force-ish flag falls back to the gate.
 */
function isUngatedSwitch(
  action: string,
  paths: string[],
  built: { argv: string[]; dangers: string[] },
): boolean {
  if (action !== "checkout" && action !== "switch") return false;
  if (paths.length > 0) return false; // the path form restores files over the working tree
  if (built.dangers.length > 0) return false;
  return !built.argv.some((a) => /^(-f|--force|--discard-changes|--ours|--theirs|--merge|-m)$/.test(a));
}

// ---------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------

type Run = { code: number; stdout: string; stderr: string; timedOut: boolean; argv: string[] };

/** Strip a leading "@" some models add to path arguments (see docs/extensions.md). */
const unAt = (s: string): string => (s.startsWith("@") ? s.slice(1) : s);

function runGit(
  repo: string,
  args: string[],
  opts: { signal?: AbortSignal; timeout?: number; write?: boolean } = {},
): Promise<Run> {
  const argv = ["--no-pager", "-C", repo, "-c", "color.ui=false", ...args];
  return new Promise((res) => {
    execFile(
      "git",
      argv,
      {
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeout ?? READ_TIMEOUT,
        signal: opts.signal,
        env: {
          ...process.env,
          // Never block waiting for a credential prompt on a headless push/pull/fetch.
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          // Reads must not take the index.lock (a concurrent editor/CI job can hold it).
          ...(opts.write ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
        },
      },
      (err: any, stdout: string, stderr: string) => {
        res({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: err?.killed === true || err?.signal === "SIGTERM",
          argv,
        });
      },
    );
  });
}

/** Single-quoted shell rendering, used ONLY for human-readable previews (never executed). */
function shellPreview(argv: string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

function cap(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return (
    text.slice(0, MAX_CHARS) +
    `\n... [output truncated at ${MAX_CHARS} chars. Narrow with paths/limit, or use flags:['stat-only'].]`
  );
}

function limitLines(text: string, max: number, more: string): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n... [${lines.length - max} more lines. ${more}]`;
}

// ---------------------------------------------------------------------------
// status (git status --porcelain=v2 --branch -z)
// ---------------------------------------------------------------------------

type Entry = { code: string; path: string; orig?: string };
type Status = {
  head: string;
  oid: string;
  detached: boolean;
  unborn: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: Entry[];
  unstaged: Entry[];
  conflicts: Entry[];
  untracked: string[];
};

/**
 * porcelain=v2 with -z: every record is NUL-terminated, and a rename ("2 ") record is
 * followed by ONE extra NUL-terminated record holding the original path. Parsing
 * sequentially (rather than line-splitting) is what makes paths containing spaces,
 * quotes, newlines or tabs safe here.
 */
function parseStatus(raw: string): Status {
  const st: Status = {
    head: "?",
    oid: "",
    detached: false,
    unborn: false,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicts: [],
    untracked: [],
  };
  const recs = raw.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# ")) {
      const [key, ...rest] = r.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") {
        st.oid = val;
        if (val === "(initial)") st.unborn = true;
      } else if (key === "branch.head") {
        st.head = val;
        if (val === "(detached)") st.detached = true;
      } else if (key === "branch.upstream") st.upstream = val;
      else if (key === "branch.ab") {
        const m = val.match(/\+(-?\d+)\s+-(-?\d+)/);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      }
      continue;
    }
    if (r.startsWith("1 ")) {
      const f = r.split(" ");
      const xy = f[1];
      const path = f.slice(8).join(" ");
      if (xy[0] !== ".") st.staged.push({ code: xy[0], path });
      if (xy[1] !== ".") st.unstaged.push({ code: xy[1], path });
    } else if (r.startsWith("2 ")) {
      const f = r.split(" ");
      const xy = f[1];
      const path = f.slice(9).join(" ");
      const orig = recs[++i] ?? "";
      if (xy[0] !== ".") st.staged.push({ code: xy[0], path, orig });
      if (xy[1] !== ".") st.unstaged.push({ code: xy[1], path, orig });
    } else if (r.startsWith("u ")) {
      const f = r.split(" ");
      st.conflicts.push({ code: f[1], path: f.slice(10).join(" ") });
    } else if (r.startsWith("? ")) {
      st.untracked.push(r.slice(2));
    }
  }
  return st;
}

const CODE_NAMES: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

function fmtEntries(list: Entry[], sectionCap: number): string {
  const shown = list.slice(0, sectionCap);
  const lines = shown.map((e) => {
    const name = CODE_NAMES[e.code] ?? e.code;
    return `  ${name.padEnd(10)} ${e.orig ? `${e.orig} -> ${e.path}` : e.path}`;
  });
  if (list.length > shown.length)
    lines.push(`  ... and ${list.length - shown.length} more (raise 'limit' to see all)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

type NumStat = { adds: string; dels: string; path: string; binary: boolean };

function parseNumstat(raw: string): NumStat[] {
  const out: NumStat[] = [];
  // -z form: "adds\tdels\tpath\0" — renames emit "adds\tdels\0old\0new\0".
  const recs = raw.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const parts = r.split("\t");
    if (parts.length < 2) continue;
    const [adds, dels] = parts;
    let path = parts.slice(2).join("\t");
    if (path === "") {
      const oldP = recs[++i] ?? "";
      const newP = recs[++i] ?? "";
      path = `${oldP} -> ${newP}`;
    }
    out.push({ adds, dels, path, binary: adds === "-" && dels === "-" });
  }
  return out;
}

/** Path shown by the patch header for a chunk, preferring "+++ b/<path>". */
function chunkPath(chunk: string): string {
  const plus = chunk.match(/^\+\+\+ b\/(.*)$/m);
  if (plus && plus[1] !== "dev/null") return plus[1];
  const minus = chunk.match(/^--- a\/(.*)$/m);
  if (minus) return minus[1];
  const g = chunk.match(/^diff --git a\/(.*?) b\/(.*)$/m);
  if (g) return g[2];
  const cc = chunk.match(/^diff --(?:cc|combined) (.*)$/m);
  return cc ? cc[1] : "(unknown)";
}

// ---------------------------------------------------------------------------
// write-action command building
// ---------------------------------------------------------------------------

type Built = { argv: string[]; dangers: string[]; network?: boolean; what: string };

/**
 * All boolean options live in ONE `flags` array rather than ~15 separate boolean params.
 * Measured reason: every extra schema property is fixed context on EVERY turn — the first
 * version of this tool cost ~2.4k tokens of schema, which wiped out its per-call savings.
 * The names deliberately mirror the real git flags the model already knows.
 */
const FLAG_LIST = [
  "staged",
  "stat-only",
  "with-files",
  "no-remotes",
  "all",
  "amend",
  "allow-empty",
  "no-verify",
  "set-upstream",
  "force",
  "force-with-lease",
  "rebase",
  "prune",
  "include-untracked",
  "create-branch",
  "allow-unrelated-histories",
  "hard",
  "soft",
] as const;

type Norm = {
  staged: boolean;
  statOnly: boolean;
  withFiles: boolean;
  noRemotes: boolean;
  all: boolean;
  amend: boolean;
  allowEmpty: boolean;
  noVerify: boolean;
  setUpstream: boolean;
  force: boolean;
  forceWithLease: boolean;
  rebase: boolean;
  prune: boolean;
  includeUntracked: boolean;
  createBranch: boolean;
  allowUnrelated: boolean;
  hard: boolean;
  soft: boolean;
};

function normFlags(flags?: string[]): { f: Norm; unknown: string[] } {
  const set = new Set((flags ?? []).map((x) => String(x).trim().toLowerCase().replace(/^--/, "")));
  const unknown = [...set].filter((x) => !(FLAG_LIST as readonly string[]).includes(x));
  const on = (n: string) => set.has(n);
  return {
    f: {
      staged: on("staged"),
      statOnly: on("stat-only"),
      withFiles: on("with-files"),
      noRemotes: on("no-remotes"),
      all: on("all"),
      amend: on("amend"),
      allowEmpty: on("allow-empty"),
      noVerify: on("no-verify"),
      setUpstream: on("set-upstream"),
      force: on("force"),
      forceWithLease: on("force-with-lease"),
      rebase: on("rebase"),
      prune: on("prune"),
      includeUntracked: on("include-untracked"),
      createBranch: on("create-branch"),
      allowUnrelated: on("allow-unrelated-histories"),
      hard: on("hard"),
      soft: on("soft"),
    },
    unknown,
  };
}

function buildWrite(p: Params, paths: string[], f: Norm): Built | { error: string } {
  const dangers: string[] = [];
  const need = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

  switch (p.action) {
    case "add": {
      if (f.all) return { argv: ["add", "-A"], dangers, what: "stage ALL changes (tracked + untracked)" };
      if (!paths.length) return { error: "action=add needs paths:[...] (or flags:['all'] for `git add -A`)." };
      return { argv: ["add", "--", ...paths], dangers, what: `stage ${paths.length} path(s)` };
    }
    case "commit": {
      const msg = p.message?.trim();
      if (!msg && !f.amend)
        return {
          error:
            "action=commit needs message:'...' (a plain multi-line string — do NOT build a heredoc). Use amend:true to reuse the previous message.",
        };
      const argv = ["commit"];
      if (f.all) argv.push("-a");
      if (f.amend) {
        argv.push("--amend");
        dangers.push("--amend REWRITES the last commit (its hash changes; a pushed commit then needs a force-push)");
        if (!msg) argv.push("--no-edit");
      }
      if (f.allowEmpty) argv.push("--allow-empty");
      if (f.noVerify) {
        argv.push("--no-verify");
        dangers.push("--no-verify SKIPS pre-commit and commit-msg hooks (lint/format/tests will NOT run)");
      }
      if (msg) argv.push("-m", msg);
      return { argv, dangers, what: f.amend ? "amend the last commit" : "create a commit" };
    }
    case "checkout":
    case "switch": {
      const br = need(p.branch);
      if (paths.length) {
        if (p.action === "switch")
          return { error: "action=switch cannot take paths. Use action=checkout with paths to restore files." };
        dangers.push(
          `checkout -- <paths> OVERWRITES those files from ${br ?? "the index"} and DISCARDS their uncommitted changes`,
        );
        return {
          argv: ["checkout", ...(br ? [br] : []), "--", ...paths],
          dangers,
          what: `restore ${paths.length} path(s) from ${br ?? "the index"}`,
        };
      }
      if (!br) return { error: `action=${p.action} needs branch:'<name>' (add flags:['create-branch'] to create it).` };
      if (p.action === "switch")
        return {
          argv: ["switch", ...(f.createBranch ? ["-c"] : []), br],
          dangers,
          what: `${f.createBranch ? "create and " : ""}switch to ${br}`,
        };
      return {
        argv: ["checkout", ...(f.createBranch ? ["-b"] : []), br],
        dangers,
        what: `${f.createBranch ? "create and " : ""}check out ${br}`,
      };
    }
    case "push": {
      const argv = ["push"];
      if (f.force) {
        argv.push("--force");
        dangers.push(
          "--force OVERWRITES the remote branch and can permanently destroy other people's commits. Prefer forceWithLease:true",
        );
      } else if (f.forceWithLease) {
        argv.push("--force-with-lease");
        dangers.push("--force-with-lease rewrites the remote branch (safe only if nobody else pushed since your last fetch)");
      }
      if (f.noVerify) {
        argv.push("--no-verify");
        dangers.push("--no-verify SKIPS pre-push hooks (CI-gating checks will NOT run locally)");
      }
      if (f.setUpstream) argv.push("-u");
      if (p.remote) argv.push(p.remote);
      if (p.branch) argv.push(p.branch);
      return { argv, dangers, network: true, what: `push to ${p.remote ?? "the default remote"}` };
    }
    case "pull": {
      const argv = ["pull"];
      if (f.rebase) argv.push("--rebase");
      if (f.allowUnrelated) {
        argv.push("--allow-unrelated-histories");
        dangers.push(
          "--allow-unrelated-histories will merge a COMPLETELY UNRELATED history into this repo — usually a sign the wrong remote/branch is being pulled",
        );
      }
      if (p.remote) argv.push(p.remote);
      if (p.branch) argv.push(p.branch);
      return { argv, dangers, network: true, what: `pull from ${p.remote ?? "the default remote"}` };
    }
    case "fetch": {
      const argv = ["fetch"];
      if (f.all) argv.push("--all");
      if (f.prune) argv.push("--prune");
      if (p.remote) argv.push(p.remote);
      if (p.branch) argv.push(p.branch);
      return { argv, dangers, network: true, what: `fetch ${p.remote ?? (f.all ? "all remotes" : "the default remote")}` };
    }
    case "stash_push": {
      const argv = ["stash", "push"];
      if (f.includeUntracked) argv.push("-u");
      if (p.message) argv.push("-m", p.message);
      if (paths.length) argv.push("--", ...paths);
      dangers.push("stash push REMOVES the changes from the working tree (recover with action=stash_pop)");
      return { argv, dangers, what: "stash working-tree changes" };
    }
    case "stash_pop": {
      const argv = ["stash", "pop", ...(p.ref ? [p.ref] : [])];
      return { argv, dangers, what: `pop ${p.ref ?? "the latest stash"}` };
    }
    case "branch_delete": {
      const br = need(p.branch);
      if (!br) return { error: "action=branch_delete needs branch:'<name>'." };
      if (f.force)
        dangers.push(
          `-D force-deletes '${br}' even if it is NOT merged anywhere — its commits become unreachable and are eventually garbage-collected`,
        );
      return { argv: ["branch", f.force ? "-D" : "-d", br], dangers, what: `delete branch ${br}` };
    }
    case "reset": {
      const mode = f.hard ? "hard" : f.soft ? "soft" : "mixed";
      if (paths.length) {
        return { argv: ["reset", "--", ...paths], dangers, what: `unstage ${paths.length} path(s)` };
      }
      if (mode === "hard")
        dangers.push(
          `reset --hard PERMANENTLY DISCARDS every uncommitted change in the working tree and index (moving HEAD to ${p.ref ?? "HEAD"})`,
        );
      return {
        argv: ["reset", `--${mode}`, ...(p.ref ? [p.ref] : [])],
        dangers,
        what: `reset --${mode} to ${p.ref ?? "HEAD"}`,
      };
    }
    default:
      return { error: `Action '${p.action}' is not a write action.` };
  }
}

/**
 * Previews issued in THIS process, keyed by confirm token, with the number of user messages that
 * existed in the session when the preview was produced.
 *
 * Why this exists: a confirm token alone does not prove the *user* approved anything — the model
 * can read the token out of its own tool result and immediately replay it in the same turn
 * (observed behaviour, not a hypothetical). Requiring a NEW user message after the preview means
 * approval has to come from an actual human turn (or, in TUI/RPC, from the confirm dialog).
 */
const previews = new Map<string, { userTurns: number; when: number }>();

/** Number of user messages in the current session branch. */
function userTurnCount(ctx: ExtensionContext): number {
  try {
    const entries = (ctx.sessionManager?.getEntries?.() ?? []) as Array<{ type?: string; message?: { role?: string } }>;
    return entries.filter((e) => e?.type === "message" && e.message?.role === "user").length;
  } catch {
    return 0;
  }
}

/** Stable short token derived from the exact argv, so a token can only approve that one command. */
const tokenFor = (argv: string[]): string =>
  createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 8);

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const schema = Type.Object({
  action: StringEnum(ALL_ACTIONS, {
    description: "Reads and branch switching (checkout/switch to a branch) run immediately. Other writes (add commit push pull fetch stash_push stash_pop branch_delete reset, and checkout with paths) preview first, then need `confirm`.",
  }),
  flags: Type.Optional(
    Type.Array(StringEnum(FLAG_LIST), {
      description:
        "Which action each applies to: diff staged|stat-only; log with-files; branch no-remotes; add/commit/fetch all; commit amend|allow-empty|no-verify; push set-upstream|force|force-with-lease; pull rebase|allow-unrelated-histories; fetch prune; stash_push include-untracked; checkout/switch create-branch; reset hard|soft.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Paths to restrict output (diff/log/show/blame) or operate on (add/reset/stash_push/checkout). No quoting needed for spaces.",
    }),
  ),
  ref: Type.Optional(
    Type.String({ description: "Revision, verbatim: 'HEAD~3', 'main..HEAD', a sha, tag; or 'stash@{1}' for stash_pop." }),
  ),
  base: Type.Optional(Type.String({ description: "diff: compare as <base>...HEAD. merge_base: the second ref." })),
  message: Type.Optional(
    Type.String({ description: "commit/stash_push message: plain multi-line text (subject, blank line, body). No quoting/heredoc." }),
  ),
  branch: Type.Optional(Type.String({ description: "Branch for checkout/switch/push/pull/fetch/branch_delete." })),
  remote: Type.Optional(Type.String({ description: "Remote for push/pull/fetch, e.g. origin." })),
  repo: Type.Optional(Type.String({ description: "Repo path (default: cwd)." })),
  limit: Type.Optional(Type.Number({ description: `Max entries: log commits (default ${DEF_LOG_LIMIT}), branches, blame lines, status rows.` })),
  since: Type.Optional(Type.String({ description: "log: --since, e.g. '2 weeks ago'." })),
  author: Type.Optional(Type.String({ description: "log: --author substring." })),
  filter: Type.Optional(Type.String({ description: "branch: case-insensitive name filter." })),
  lines: Type.Optional(Type.String({ description: "blame line range, e.g. '40-80'." })),
  contextLines: Type.Optional(Type.Number({ description: `diff context lines (default ${DEF_CONTEXT}).` })),
  maxLinesPerFile: Type.Optional(
    Type.Number({ description: `diff/show: patch lines kept per file (default ${DEF_MAX_LINES_PER_FILE}); raising it also raises the total budget.` }),
  ),
  confirm: Type.Optional(
    Type.String({ description: "Token copied from this call's PREVIEW output. Required to actually run a write action; never invent one." }),
  ),
});

type Params = Static<typeof schema>;
export type GitToolInput = Params;

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git",
    label: "Git",
    description: `All git operations in one tool; no shell, so paths and multi-line commit messages need no quoting.

Reads (immediate): status (branch + upstream ahead/behind + grouped staged/unstaged/conflicted/untracked), diff (per-file +/- summary plus a patch truncated to ${DEF_MAX_LINES_PER_FILE} lines/file, ${DEF_MAX_TOTAL_LINES} total), log, show, branch, blame, merge_base, rev_parse, stash_list.

checkout/switch to a branch (incl. flags:['create-branch']) or to a commit runs on the FIRST call, no token: git itself refuses the move if it would overwrite local changes, and switching back undoes it.
Every other write NEVER runs on the first call — including checkout WITH paths, which discards uncommitted work: you get "PREVIEW ONLY" with the exact command, DANGER notes for destructive flags, and a confirm token; repeating the identical call plus confirm:"<token>" runs it. Same-turn token replay is refused ("self-approval-blocked") and a token is valid only for that exact command. Interactive sessions also show a dialog.

Ex: {"action":"status"} | {"action":"diff","base":"origin/main","flags":["stat-only"]} | {"action":"diff","paths":["src/app.ts"],"maxLinesPerFile":400} | {"action":"commit","message":"Fix crash on empty input\n\nGuard the parser against a zero-length buffer."} -> preview, then the identical call plus "confirm":"a1b2c3d4" -> runs | {"action":"push","remote":"origin","branch":"feature/x","flags":["set-upstream"]}`,
    promptSnippet: "All git operations (status/diff/log/show/branch/blame + immediate checkout/switch + preview-confirmed commit/push/pull/reset)",
    promptGuidelines: [
      "Use the git tool for every git operation instead of `git ...` in bash (pass repo:'<path>' for another repo rather than `cd X && git ...`): action='status' answers \"what changed / which branch\" in one call, and action='diff' returns a +/- summary with a truncated patch instead of thousands of lines — if a file was truncated, re-call with paths:[thatFile] and a bigger maxLinesPerFile rather than shelling out. Commit messages go in the plain multi-line `message` string, never a bash heredoc.",
      "checkout/switch to a branch or commit executes straight away — do not ask for approval and do not wait for a token. Every OTHER write action only PREVIEWS and returns a confirm token: end your turn there, quoting the previewed command and any DANGER lines verbatim, and repeat the call with confirm:'<token>' only after the user replies approving it. Same-turn replay is refused, invented tokens are refused, and running the same command through bash instead is a policy violation.",
      "On a failed commit/push read the verbatim git output: a hook rejection means fix the reported problem, not re-run with flags:['no-verify'] (use that only if the user explicitly asks).",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const p = params as Params;
      const { f, unknown: badFlags } = normFlags(p.flags as string[] | undefined);
      const paths = (p.paths ?? []).map((s: string) => unAt(s)).filter((s: string) => s.length > 0);
      const lineMatch = /^(\d+)(?:\s*[-,:]\s*(\d+))?$/.exec((p.lines ?? "").trim());
      const lineStart = lineMatch ? Number(lineMatch[1]) : 0;
      const lineEnd = lineMatch ? Number(lineMatch[2] ?? lineMatch[1]) + (lineMatch[2] ? 0 : 40) : 0;
      const repoArg = p.repo ? unAt(p.repo) : ctx.cwd;
      const repo = resolve(ctx.cwd, repoArg);

      const fin = (text: string, details: Record<string, unknown> = {}, isError = false) => ({
        content: [{ type: "text" as const, text: cap(text) }],
        // charCapped/truncated must never disagree with the text the model actually sees:
        // the hard 40k char cap can fire even when the per-file/​total line budgets did not.
        details: {
          action: p.action,
          repo,
          ...details,
          ...(text.length > MAX_CHARS ? { charCapped: true, truncated: true } : {}),
        },
        isError,
      });
      const bad = (msg: string) => fin(`Error: ${msg}`, { error: msg }, true);
      if (badFlags.length)
        return bad(
          `Unknown flag(s): ${badFlags.join(", ")}. Valid flags: ${FLAG_LIST.join(", ")}.`,
        );

      // ---- repo sanity: this is the #1 source of confusing raw-git failures ----
      const top = await runGit(repo, ["rev-parse", "--show-toplevel"], { signal });
      if (top.code !== 0) {
        const inside = await runGit(repo, ["rev-parse", "--is-inside-git-dir"], { signal });
        const { existsSync: pathExists } = await import("node:fs");
        const hint = !pathExists(repo)
          ? "That path does not exist on disk — check the spelling, or pass repo:'<path to an existing repo>'."
          : inside.stdout.trim() === "true"
            ? "That path is inside a .git directory; pass the working tree instead."
            : "Not a git repository (and no parent is one). Pass repo:'<path to a repo>' or ask the user which repo to use.";
        return fin(
          `Error: git cannot operate in ${repo}.\n${hint}\ngit said: ${(top.stderr || top.stdout).trim() || "(no output)"}`,
          { error: "not-a-repo" },
          true,
        );
      }
      const root = top.stdout.trim();

      const runR = (args: string[]) => runGit(repo, args, { signal });
      const secCap = Math.max(1, Math.min(p.limit ?? DEF_SECTION_CAP, 1000));

      try {
        switch (p.action as Action) {
          // ------------------------------------------------------------------
          case "status": {
            const r = await runR(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
            if (r.code !== 0) return bad(`git status failed: ${(r.stderr || r.stdout).trim()}`);
            const st = parseStatus(r.stdout);
            const out: string[] = [];
            const brDesc = st.unborn
              ? `branch ${st.head} (no commits yet)`
              : st.detached
                ? `DETACHED HEAD at ${st.oid.slice(0, 8)} (not on any branch)`
                : `branch ${st.head}`;
            const track = st.upstream
              ? `, upstream ${st.upstream} (ahead ${st.ahead}, behind ${st.behind})`
              : st.detached || st.unborn
                ? ""
                : ", no upstream configured";
            out.push(`Repo:   ${root}`);
            out.push(`On:     ${brDesc}${track}`);
            if (!st.unborn) {
              const last = await runR(["log", "-1", "--format=%h %s (%ar by %an)"]);
              if (last.code === 0 && last.stdout.trim()) out.push(`HEAD:   ${last.stdout.trim()}`);
            }
            // A merge/rebase/cherry-pick in progress explains conflicts and blocks commits.
            const inProgress: string[] = [];
            for (const [file, label] of [
              ["MERGE_HEAD", "merge in progress"],
              ["CHERRY_PICK_HEAD", "cherry-pick in progress"],
              ["REVERT_HEAD", "revert in progress"],
              ["rebase-merge", "rebase in progress"],
              ["rebase-apply", "rebase/am in progress"],
            ] as const) {
              const chk = await runR(["rev-parse", "--git-path", file]);
              if (chk.code === 0) {
                const { existsSync } = await import("node:fs");
                const abs = resolve(root, chk.stdout.trim());
                if (existsSync(abs)) inProgress.push(label);
              }
            }
            if (inProgress.length) out.push(`State:  ${inProgress.join(", ")} — resolve or abort before committing`);
            out.push("");
            out.push(`Staged (${st.staged.length}):`);
            out.push(st.staged.length ? fmtEntries(st.staged, secCap) : "  (none)");
            out.push(`Unstaged (${st.unstaged.length}):`);
            out.push(st.unstaged.length ? fmtEntries(st.unstaged, secCap) : "  (none)");
            if (st.conflicts.length) {
              out.push(`CONFLICTS (${st.conflicts.length}) — must be resolved:`);
              out.push(st.conflicts.map((e) => `  ${e.code}  ${e.path}`).slice(0, secCap).join("\n"));
            }
            const shownU = st.untracked.slice(0, Math.min(secCap, 20));
            out.push(`Untracked (${st.untracked.length}${st.untracked.length > shownU.length ? `, ${shownU.length} shown` : ""}):`);
            out.push(shownU.length ? shownU.map((u) => `  ${u}`).join("\n") : "  (none)");
            const stash = await runR(["stash", "list"]);
            const stashCount = stash.code === 0 ? stash.stdout.split("\n").filter((l) => l.trim()).length : 0;
            if (stashCount) out.push(`\nStashes: ${stashCount} (action=stash_list)`);
            if (st.staged.length || st.unstaged.length)
              out.push(`\nFor the actual changes: {"action":"diff"}${st.staged.length ? ` or {"action":"diff","staged":true}` : ""}`);
            return fin(out.join("\n"), {
              branch: st.head,
              detached: st.detached,
              unborn: st.unborn,
              counts: {
                staged: st.staged.length,
                unstaged: st.unstaged.length,
                conflicts: st.conflicts.length,
                untracked: st.untracked.length,
              },
            });
          }

          // ------------------------------------------------------------------
          case "diff": {
            const revArgs: string[] = [];
            if (p.ref) revArgs.push(p.ref);
            else if (p.base) revArgs.push(`${p.base}...HEAD`);
            const common = ["diff", ...(f.staged ? ["--cached"] : []), ...revArgs];
            const pathArgs = paths.length ? ["--", ...paths] : [];

            const ns = await runR([...common, "--numstat", "-z", ...pathArgs]);
            if (ns.code !== 0) return bad(`git diff failed: ${(ns.stderr || ns.stdout).trim()}`);
            const stats = parseNumstat(ns.stdout);
            // Be explicit about WHICH two things are being compared: a two-dot/three-dot range
            // never includes the working tree, which is easy to misread as "my uncommitted changes".
            const rangeArg = revArgs.length ? revArgs.join(" ") : "";
            const what = rangeArg
              ? rangeArg.includes("..")
                ? `diff ${rangeArg} (commit range — working tree/index NOT included)`
                : `diff ${rangeArg} (${f.staged ? "index" : "working tree"} vs ${rangeArg})`
              : f.staged
                ? "staged diff (index vs HEAD)"
                : "diff (working tree vs index)";
            const scope = `${what}${paths.length ? ` -- ${paths.join(" ")}` : ""}`;

            if (!stats.length) {
              const stx = await runR(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
              const st = stx.code === 0 ? parseStatus(stx.stdout) : null;
              const extra: string[] = [];
              if (st?.untracked.length)
                extra.push(
                  `${st.untracked.length} UNTRACKED file(s) exist and are invisible to git diff (e.g. ${st.untracked.slice(0, 3).join(", ")}) — see action=status.`,
                );
              if (!f.staged && st?.staged.length)
                extra.push(`${st.staged.length} change(s) are STAGED — re-call with flags:["staged"] to see them.`);
              return fin(`No changes in ${scope}.${extra.length ? `\n${extra.join("\n")}` : ""}`, { files: 0 });
            }

            const totalAdd = stats.reduce((n, s) => n + (s.binary ? 0 : Number(s.adds) || 0), 0);
            const totalDel = stats.reduce((n, s) => n + (s.binary ? 0 : Number(s.dels) || 0), 0);
            const bins = stats.filter((s) => s.binary);
            const head = [
              `${scope}: ${stats.length} file(s), +${totalAdd} -${totalDel}${bins.length ? `, ${bins.length} binary` : ""}`,
              ...stats
                .slice(0, 200)
                .map((s) => `  ${s.binary ? "binary".padStart(9) : `+${s.adds} -${s.dels}`.padStart(9)}  ${s.path}`),
              ...(stats.length > 200 ? [`  ... and ${stats.length - 200} more files`] : []),
            ].join("\n");

            if (f.statOnly)
              return fin(`${head}\n\n(stat-only: no patch. Re-call with paths:[...] for the patch of specific files.)`, {
                files: stats.length,
                truncated: false,
              });

            const ctxLines = Math.max(0, Math.min(p.contextLines ?? DEF_CONTEXT, 25));
            const perFile = Math.max(5, Math.min(p.maxLinesPerFile ?? DEF_MAX_LINES_PER_FILE, 20_000));
            // The total budget is derived from maxLinesPerFile instead of being its own schema param:
            // raising the per-file cap also raises the whole-diff cap, so one knob covers "give me more".
            const totalMax = Math.max(DEF_MAX_TOTAL_LINES, Math.min(perFile * 4, 40_000));
            const pr = await runR([...common, `-U${ctxLines}`, ...pathArgs]);
            if (pr.code !== 0) return bad(`git diff (patch) failed: ${(pr.stderr || pr.stdout).trim()}`);

            const chunks = pr.stdout.split(/^(?=diff --(?:git|cc|combined) )/m).filter((c) => c.trim());
            const kept: string[] = [];
            let used = 0;
            let filesTruncated = 0;
            const skipped: string[] = [];
            for (const chunk of chunks) {
              const fpath = chunkPath(chunk);
              if (used >= totalMax) {
                skipped.push(fpath);
                continue;
              }
              const lines = chunk.replace(/\n$/, "").split("\n");
              const budget = Math.min(perFile, totalMax - used);
              if (lines.length > budget) {
                filesTruncated++;
                kept.push(
                  `${lines.slice(0, budget).join("\n")}\n... [${lines.length - budget} more diff lines for ${fpath} — re-call: {"action":"diff","paths":["${fpath}"],"maxLinesPerFile":${Math.min(lines.length + 10, 20_000)}}]`,
                );
                used += budget;
              } else {
                kept.push(lines.join("\n"));
                used += lines.length;
              }
            }
            const foot: string[] = [];
            if (filesTruncated)
              foot.push(`${filesTruncated} file patch(es) truncated at ${perFile} lines each (maxLinesPerFile).`);
            if (skipped.length)
              foot.push(
                `${skipped.length} file(s) omitted entirely after the ${totalMax}-line total budget: ${skipped.slice(0, 15).join(", ")}${skipped.length > 15 ? ", ..." : ""}. Re-call with paths:[...] per file, or flags:["stat-only"] for the summary.`,
              );
            if (bins.length) foot.push(`Binary file(s) not shown as text: ${bins.map((b) => b.path).join(", ")}.`);
            return fin(`${head}\n\n${kept.join("\n")}${foot.length ? `\n\n[${foot.join(" ")}]` : ""}`, {
              files: stats.length,
              truncated: filesTruncated > 0 || skipped.length > 0,
              filesTruncated,
              filesOmitted: skipped.length,
            });
          }

          // ------------------------------------------------------------------
          case "log": {
            const n = Math.max(1, Math.min(p.limit ?? DEF_LOG_LIMIT, 500));
            const args = ["log", `-n${n}`, "--date=short", "--format=%h\x1f%ad\x1f%an\x1f%s"];
            if (p.author) args.push(`--author=${p.author}`);
            if (p.since) args.push(`--since=${p.since}`);
            if (f.withFiles) args.push("--name-status");
            if (p.ref) args.push(p.ref);
            if (paths.length) args.push("--", ...paths);
            const r = await runR(args);
            if (r.code !== 0) {
              const err = (r.stderr || r.stdout).trim();
              if (/does not have any commits yet|bad default revision/.test(err))
                return fin("This repository has no commits yet (unborn HEAD), so there is no log.", { commits: 0 });
              return bad(`git log failed: ${err}`);
            }
            if (!r.stdout.trim())
              return fin(
                `No commits matched (${[p.ref, p.author && `author=${p.author}`, p.since && `since=${p.since}`, paths.length && `paths=${paths.join(" ")}`]
                  .filter(Boolean)
                  .join(", ") || "no filters"}).`,
                { commits: 0 },
              );
            const lines = r.stdout.split("\n");
            const out: string[] = [];
            let commits = 0;
            for (const line of lines) {
              if (line.includes("\x1f")) {
                const [h, d, a, s] = line.split("\x1f");
                out.push(`${h} | ${d} | ${a} | ${s}`);
                commits++;
              } else if (line.trim()) out.push(`         ${line.trim()}`);
            }
            const header = `${commits} commit(s)${p.ref ? ` in ${p.ref}` : ""}${paths.length ? ` touching ${paths.join(" ")}` : ""} (hash | date | author | subject):`;
            return fin(
              `${header}\n${limitLines(out.join("\n"), n * (f.withFiles ? 40 : 1) + 10, "raise 'limit' or narrow with paths/since")}`,
              { commits },
            );
          }

          // ------------------------------------------------------------------
          case "show": {
            const ref = p.ref ?? "HEAD";
            const meta = await runR([
              "show",
              "-s",
              "--format=commit %H%nauthor  %an <%ae>%ndate    %ad%nparents %p%nrefs   %d%n%n%B",
              "--date=iso",
              ref,
            ]);
            if (meta.code !== 0) {
              const err = (meta.stderr || meta.stdout).trim();
              if (ref === "HEAD" && /unknown revision|ambiguous argument 'HEAD'/.test(err))
                return fin("This repository has no commits yet (unborn HEAD), so there is nothing to show.", {
                  files: 0,
                });
              return bad(`git show ${ref} failed: ${err}`);
            }
            const ns = await runR(["show", "--numstat", "-z", "--format=", ref]);
            const stats = parseNumstat(ns.stdout);
            const out = [meta.stdout.trimEnd(), "", `Files (${stats.length}):`];
            out.push(
              ...stats
                .slice(0, 200)
                .map((s) => `  ${s.binary ? "binary".padStart(9) : `+${s.adds} -${s.dels}`.padStart(9)}  ${s.path}`),
            );
            if (stats.length > 200) out.push(`  ... and ${stats.length - 200} more files`);
            if (paths.length && !f.statOnly) {
              const perFile = Math.max(5, Math.min(p.maxLinesPerFile ?? DEF_MAX_LINES_PER_FILE, 20_000));
              const pr = await runR(["show", `-U${Math.max(0, p.contextLines ?? DEF_CONTEXT)}`, "--format=", ref, "--", ...paths]);
              if (pr.code === 0 && pr.stdout.trim()) {
                out.push("", `Patch for ${paths.join(", ")}:`);
                for (const chunk of pr.stdout.split(/^(?=diff --(?:git|cc|combined) )/m).filter((c) => c.trim())) {
                  out.push(limitLines(chunk.trimEnd(), perFile, `raise maxLinesPerFile for ${chunkPath(chunk)}`));
                }
              }
            } else if (!paths.length) {
              out.push("", 'For a patch, re-call with paths:["<file>"] (patches for whole commits are often huge).');
            }
            return fin(out.join("\n"), { files: stats.length });
          }

          // ------------------------------------------------------------------
          case "branch": {
            const cur = await runR(["branch", "--show-current"]);
            const currentName = cur.stdout.trim();
            // %(symref) is non-empty only for symbolic refs such as refs/remotes/origin/HEAD,
            // which would otherwise show up as a bogus branch called "origin".
            const fmt =
              "%(refname:short)\x1f%(objectname:short)\x1f%(committerdate:short)\x1f%(upstream:short)\x1f%(symref)";
            const r = await runR(["for-each-ref", `--format=${fmt}`, "--sort=-committerdate", "refs/heads", ...(f.noRemotes ? [] : ["refs/remotes"])]);
            if (r.code !== 0) return bad(`git for-each-ref failed: ${(r.stderr || r.stdout).trim()}`);
            const nameFilter = p.filter?.toLowerCase();
            const rows = r.stdout
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => l.split("\x1f"))
              .filter(([, , , , symref]) => !symref)
              .filter(([name]) => !nameFilter || name.toLowerCase().includes(nameFilter));
            // Classify local vs remote by asking git which refs are under refs/heads, rather than
            // guessing from the presence of a "/" (local branch names legitimately contain slashes,
            // e.g. feature/foo, which a slash heuristic would misfile as a remote branch).
            const heads = await runR(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
            const headSet = new Set(heads.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
            const localRows = rows.filter(([n]) => headSet.has(n));
            const remoteRows = rows.filter(([n]) => !headSet.has(n));
            const cap1 = Math.max(1, Math.min(p.limit ?? 30, 500));
            const fmtRow = ([n, sha, date, up]: string[]) =>
              `  ${n === currentName ? "*" : " "} ${n}  ${sha}  ${date}${up ? `  -> ${up}` : ""}`;
            const out: string[] = [];
            out.push(
              currentName
                ? `Current branch: ${currentName}`
                : `Current branch: (detached HEAD — not on a branch; see action=status)`,
            );
            out.push(`Local branches (${localRows.length}${p.filter ? ` matching '${p.filter}'` : ""}):`);
            out.push(localRows.slice(0, cap1).map(fmtRow).join("\n") || "  (none)");
            if (localRows.length > cap1) out.push(`  ... ${localRows.length - cap1} more (raise 'limit')`);
            if (!f.noRemotes) {
              out.push(`Remote branches (${remoteRows.length}${p.filter ? ` matching '${p.filter}'` : ""}):`);
              out.push(remoteRows.slice(0, cap1).map(fmtRow).join("\n") || "  (none)");
              if (remoteRows.length > cap1)
                out.push(`  ... ${remoteRows.length - cap1} more (raise 'limit', use filter, or flags:["no-remotes"])`);
            }
            return fin(out.join("\n"), { current: currentName, local: localRows.length, remote: remoteRows.length });
          }

          // ------------------------------------------------------------------
          case "blame": {
            const file = paths[0];
            if (!file) return bad("action=blame needs paths:['<file>'] (and ideally lines:'40-80').");
            const args = ["blame", "--date=short", "-w"];
            if (lineStart) args.push(`-L${lineStart},${lineEnd}`);
            args.push("--", file);
            const r = await runR(args);
            if (r.code !== 0) return bad(`git blame failed: ${(r.stderr || r.stdout).trim()}`);
            const maxL = Math.max(1, Math.min(p.limit ?? DEF_BLAME_LINES, 2000));
            return fin(
              `blame ${file}${lineStart ? ` lines ${lineStart}-${lineEnd}` : ""}:\n` +
                limitLines(r.stdout.trimEnd(), maxL, "pass lines:'<start>-<end>' to blame a specific range"),
              {},
            );
          }

          // ------------------------------------------------------------------
          case "merge_base": {
            const a = p.ref ?? "HEAD";
            const b = p.base ?? "HEAD";
            if (a === b) return bad("action=merge_base needs two different refs: ref and base (e.g. ref='HEAD', base='origin/main').");
            const r = await runR(["merge-base", a, b]);
            if (r.code !== 0) return bad(`git merge-base ${a} ${b} failed: ${(r.stderr || r.stdout).trim()}`);
            const sha = r.stdout.trim();
            const info = await runR(["log", "-1", "--date=short", "--format=%h | %ad | %an | %s", sha]);
            const ab = await runR(["rev-list", "--left-right", "--count", `${a}...${b}`]);
            const [left, right] = ab.stdout.trim().split(/\s+/);
            return fin(
              `merge-base(${a}, ${b}) = ${sha}\n${info.stdout.trim()}\n${a} has ${left ?? "?"} commit(s) not in ${b}; ${b} has ${right ?? "?"} not in ${a}.`,
              { mergeBase: sha },
            );
          }

          // ------------------------------------------------------------------
          case "rev_parse": {
            if (!p.ref) {
              const [gitDir, head, br] = await Promise.all([
                runR(["rev-parse", "--absolute-git-dir"]),
                runR(["rev-parse", "HEAD"]),
                runR(["branch", "--show-current"]),
              ]);
              return fin(
                [
                  `toplevel: ${root}`,
                  `git-dir:  ${gitDir.stdout.trim() || "?"}`,
                  `HEAD:     ${head.code === 0 ? head.stdout.trim() : "(unborn — no commits yet)"}`,
                  `branch:   ${br.stdout.trim() || "(detached HEAD)"}`,
                ].join("\n"),
                {},
              );
            }
            const r = await runR(["rev-parse", "--verify", p.ref]);
            if (r.code !== 0)
              return bad(`'${p.ref}' is not a valid ref in this repo: ${(r.stderr || r.stdout).trim()}`);
            const sha = r.stdout.trim();
            const info = await runR(["log", "-1", "--date=short", "--format=%h | %ad | %an | %s", sha]);
            return fin(`${p.ref} = ${sha}\n${info.stdout.trim()}`, { sha });
          }

          // ------------------------------------------------------------------
          case "stash_list": {
            // NOTE: passing --date=short here would rewrite the %gd reflog selector into a
            // date form ("stash@{2026-08-17}") that `git stash pop` cannot address. Use %cs for
            // the date instead and leave the selector alone so it is copy-pasteable as `ref`.
            const r = await runR(["stash", "list", "--format=%gd\x1f%h\x1f%cs\x1f%s"]);
            if (r.code !== 0) return bad(`git stash list failed: ${(r.stderr || r.stdout).trim()}`);
            const rows = r.stdout.split("\n").filter((l) => l.trim());
            if (!rows.length) return fin("No stashes.", { stashes: 0 });
            const capN = Math.max(1, Math.min(p.limit ?? 50, 500));
            return fin(
              `${rows.length} stash(es):\n${rows
                .slice(0, capN)
                .map((l) => `  ${l.split("\x1f").join(" | ")}`)
                .join("\n")}`,
              { stashes: rows.length },
            );
          }

          // ------------------------------------------------------------------
          // WRITE ACTIONS — preview first, execute only with a matching token
          // ------------------------------------------------------------------
          default: {
            if (!isWrite(p.action)) return bad(`Unknown action '${p.action}'. Valid: ${ALL_ACTIONS.join(", ")}`);
            const built = buildWrite(p, paths, f);
            if ("error" in built) return bad(built.error);
            const full = ["git", "-C", root, ...built.argv];
            const token = tokenFor(built.argv);
            const preview = shellPreview(full);
            const dangerBlock = built.dangers.length
              ? `\n${built.dangers.map((d) => `!! DANGER: ${d}`).join("\n")}\n`
              : "";
            const unattended = process.env.PI_GIT_UNATTENDED === "1";
            const ungated = isUngatedSwitch(p.action, paths, built);

            if (!ungated) {
            if (p.confirm !== token) {
              const mismatch = !!p.confirm;
              // Remember this preview so a later confirm can be checked against the user turn count.
              if (!previews.has(token)) {
                // Bounded: a long session can preview many commands; keep only the newest 50.
                if (previews.size >= 50) {
                  const oldest = [...previews.entries()].sort((a, b) => a[1].when - b[1].when)[0];
                  if (oldest) previews.delete(oldest[0]);
                }
                previews.set(token, { userTurns: userTurnCount(ctx), when: Date.now() });
              }
              return fin(
                [
                  mismatch
                    ? `NOT EXECUTED — the confirm token '${p.confirm}' does not match this command (a token is only valid for the exact command it was issued for; either the parameters changed or the token was invented).`
                    : `PREVIEW ONLY — nothing was executed.`,
                  ``,
                  `Would ${built.what} in ${root}:`,
                  `  ${preview}`,
                  ...(p.message
                    ? [
                        ``,
                        `Commit/stash message (verbatim, ${p.message.split("\n").length} line(s)):`,
                        p.message.split("\n").map((l: string) => `  | ${l}`).join("\n"),
                      ]
                    : []),
                  dangerBlock,
                  `Show the command above to the user and get explicit approval.`,
                  `Then repeat this exact call with confirm:"${token}". Never guess a token — always copy the one printed here.`,
                ].join("\n"),
                { preview, token, dangers: built.dangers, executed: false, ...(mismatch ? { error: "token-mismatch" } : {}) },
                mismatch,
              );
            }

            // ---- token matches: now prove a HUMAN approved it ----
            const seenAt = previews.get(token);
            const turnsNow = userTurnCount(ctx);
            if (!ctx.hasUI && !unattended) {
              if (!seenAt)
                return fin(
                  [
                    `NOT EXECUTED — no preview for this command was issued in this session, so there is nothing the user could have approved.`,
                    `Call this action WITHOUT confirm first, show the preview to the user, and wait for their reply.`,
                    `  ${preview}`,
                  ].join("\n"),
                  { executed: false, error: "no-preview", token },
                  true,
                );
              if (turnsNow <= seenAt.userTurns)
                return fin(
                  [
                    `NOT EXECUTED — you are re-sending the confirm token in the same turn that produced the preview, so the user has not actually approved anything.`,
                    `  ${preview}`,
                    dangerBlock.trim(),
                    `Stop here. Show the command above to the user, end your turn, and only run it after they reply with approval.`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  { executed: false, error: "self-approval-blocked", token, dangers: built.dangers },
                  true,
                );
            }

            if (ctx.hasUI) {
              const ok = await ctx.ui.confirm(
                `git ${p.action}${built.dangers.length ? "  ⚠ DANGEROUS" : ""}`,
                `${preview}${dangerBlock ? `\n${dangerBlock.trim()}` : ""}`,
              );
              if (!ok)
                return fin(
                  `User DECLINED: ${preview}\nNothing was executed. Ask what to change instead of retrying, and do not run this via bash.`,
                  { executed: false, declined: true },
                  true,
                );
            }
            } // end approval gate (skipped for an ungated branch switch)

            const r = await runGit(root, built.argv, {
              signal,
              write: true,
              timeout: built.network ? NETWORK_TIMEOUT : READ_TIMEOUT,
            });
            const combined = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
            if (r.code !== 0) {
              const hookHint =
                p.action === "commit" && /hook|pre-commit|husky|lint|prettier|eslint|detekt|ktlint/i.test(combined)
                  ? "\nA git hook rejected this commit. Fix the reported problem and commit again — do NOT retry with flags:['no-verify'] unless the user explicitly asks."
                  : "";
              const timeoutHint = r.timedOut
                ? `\nThe command timed out after ${(built.network ? NETWORK_TIMEOUT : READ_TIMEOUT) / 1000}s (auth prompts are disabled, so a hung remote usually means missing credentials).`
                : "";
              return fin(
                `git ${p.action} FAILED (exit ${r.code}): ${preview}\n\n--- git output (verbatim) ---\n${limitLines(combined || "(no output)", 200, "rerun with fewer paths")}${hookHint}${timeoutHint}`,
                { executed: true, exitCode: r.code, dangers: built.dangers, approval: ungated ? "ungated-switch" : ctx.hasUI ? "ui-dialog" : unattended ? "unattended-env" : "user-turn" },
                true,
              );
            }

            const extra: string[] = [];
            if (p.action === "commit") {
              const last = await runR(["log", "-1", "--format=%h %s", "--stat=100"]);
              if (last.code === 0) extra.push(last.stdout.trimEnd());
            } else if (p.action === "checkout" || p.action === "switch" || p.action === "branch_delete" || p.action === "reset") {
              const st = await runR(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
              if (st.code === 0) {
                const s = parseStatus(st.stdout);
                extra.push(
                  `Now on ${s.detached ? `DETACHED HEAD ${s.oid.slice(0, 8)}` : s.head}; ${s.staged.length} staged, ${s.unstaged.length} unstaged, ${s.untracked.length} untracked.`,
                );
              }
            }
            return fin(
              [
                `OK — executed: ${preview}`,
                combined ? `\n--- git output ---\n${limitLines(combined, 120, "run action=status for the current state")}` : "",
                extra.length ? `\n${extra.join("\n")}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
              { executed: true, exitCode: 0, dangers: built.dangers, approval: ungated ? "ungated-switch" : ctx.hasUI ? "ui-dialog" : unattended ? "unattended-env" : "user-turn" },
            );
          }
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return fin("Cancelled.", { cancelled: true }, true);
        return bad(`git ${p.action} threw: ${e?.message ?? String(e)}`);
      }
    },

    renderCall(args: GitToolInput, theme) {
      const a = args;
      const bits: string[] = [];
      if (a.ref) bits.push(a.ref);
      if (a.base) bits.push(`base=${a.base}`);
      if (a.branch) bits.push(a.branch);
      if (a.remote) bits.push(a.remote);
      if (a.filter) bits.push(`/${a.filter}/`);
      if (a.paths?.length) bits.push(a.paths.slice(0, 3).join(" ") + (a.paths.length > 3 ? ` +${a.paths.length - 3}` : ""));
      const flagList = (a.flags ?? []) as string[];
      if (flagList.length) bits.push(flagList.map((x) => `--${x}`).join(" "));
      const dangerous = flagList.some((x) =>
        ["force", "no-verify", "amend", "allow-unrelated-histories", "hard", "force-with-lease"].includes(x),
      );
      const suffix = isWrite(a.action)
        ? a.confirm
          ? theme.fg("warning", " [confirmed]")
          : theme.fg("dim", " [preview]")
        : "";
      return new Text(
        `${theme.fg("accent", "git")} ${theme.bold(a.action)}${dangerous ? theme.fg("error", " ⚠") : ""}` +
          `${bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""}${suffix}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const first = result.content[0];
      const text = (first && "text" in first ? first.text : "") ?? "";
      // AgentToolResult has no isError field at the type level, so detect failure from the
      // structured details we set plus the explicit text markers we emit.
      const d = result.details as { error?: string; declined?: boolean; exitCode?: number } | undefined;
      const failed = !!d?.error || !!d?.declined || (typeof d?.exitCode === "number" && d.exitCode !== 0);
      if (failed) return new Text(theme.fg("error", limitLines(text, expanded ? 400 : 12, "expand for more")), 0, 0);
      if (text.startsWith("PREVIEW ONLY")) return new Text(theme.fg("warning", text), 0, 0);
      return new Text(limitLines(text, expanded ? 1000 : 15, "expand for more"), 0, 0);
    },
  });
}
