/**
 * gh extension for pi — GitHub PR/issue workflow as one action-enum tool.
 *
 * Wraps the `gh` CLI (https://cli.github.com) instead of reimplementing GitHub auth:
 * authentication is whatever `gh auth status` says, and gh's own auth errors are
 * surfaced verbatim with an explicit "run gh auth login" hint.
 *
 * Why this exists (measured): in a 1539-command corpus of real bash calls, the 15 that
 * used `gh` were the highest-stakes ones — including a `gh pr create --title ... --body ...`
 * composed inline in a shell string, i.e. an externally visible mutation with zero preview
 * and a body smuggled through shell quoting. Here:
 *   - title/body are plain tool params, passed to gh via argv + stdin (never a shell string),
 *     so backticks/quotes/newlines/emoji cannot break or be reinterpreted;
 *   - every write action is preview-first: the first call returns the exact resolved payload
 *     plus a one-time approval token bound to a hash of that payload, and executes nothing.
 *
 * Every result ends with a machine-readable marker line:
 *   gh_status: ok | preview_pending_approval | refused_unapproved | declined | auth_error
 *              | not_installed | no_remote | not_found | error
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

/** How long a preview's approval token stays valid. */
const APPROVAL_TTL_MS = 15 * 60 * 1000;
/** Body text is shown verbatim in the preview up to this many chars (the API call is NEVER truncated). */
const PREVIEW_BODY_CHARS = 4000;
/** Cap for PR/issue body text in read actions (pr_view / issue_view). */
const READ_BODY_CHARS = 3000;
/** Cap for a raw patch returned by pr_diff (patch:true). */
const PATCH_CHARS = 30_000;
/** Cap for CI logs (run_log). The TAIL is kept — a failing job's error is at the END of its log. */
const LOG_CHARS = 20_000;
/** Default child-process timeout. */
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 32 * 1024 * 1024;

type GhStatus =
  | "ok"
  | "preview_pending_approval"
  | "refused_unapproved"
  | "declined"
  | "auth_error"
  | "not_installed"
  | "no_remote"
  | "not_found"
  | "error";

type Run = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all (gh missing, permission). */
  spawnError?: string;
  timedOut?: boolean;
};

/**
 * Run a CLI with argv (NO shell). Body text goes through stdin, so no quoting layer
 * can ever mangle it. Never throws on a non-zero exit — callers classify the failure,
 * because several gh exit codes are informational (e.g. `gh pr checks` exits 8 when
 * checks are merely pending, which is not an error).
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; stdin?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        signal: opts.signal,
        timeout: opts.timeout ?? GH_TIMEOUT_MS,
        // SIGKILL the direct child on timeout; a hung grandchild can still hold the pipe
        // open a little longer, so the reported duration may exceed the nominal timeout.
        killSignal: "SIGKILL",
        env: { ...process.env, GH_PAGER: "cat", PAGER: "cat", GH_PROMPT_DISABLED: "1", CLICOLOR: "0", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      return resolve({ code: null, stdout: "", stderr: "", spawnError: e?.message ?? String(e) });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => {
      if (stdout.length < GH_MAX_BUFFER) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < GH_MAX_BUFFER) stderr += d.toString();
    });
    child.on("error", (e: any) => {
      // ENOENT here means the binary does not exist; ABORT_ERR means we cancelled.
      if (e?.code === "ETIMEDOUT") timedOut = true;
      resolve({ code: null, stdout, stderr, spawnError: `${e?.code ?? ""} ${e?.message ?? String(e)}`.trim(), timedOut });
    });
    child.on("close", (code, sig) => {
      resolve({ code, stdout, stderr, timedOut: timedOut || sig === "SIGTERM" });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {
        /* EPIPE if gh exits early — the close handler reports the real reason. */
      });
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

const gh = (args: string[], o: Parameters<typeof run>[2] = {}) => run("gh", args, o);
const git = (args: string[], cwd?: string, signal?: AbortSignal) => run("git", args, { cwd, signal, timeout: 15_000 });

const NOT_INSTALLED_HELP = `The GitHub CLI (\`gh\`) is not installed or not on PATH.

Install it, then re-run:
  macOS:  brew install gh
  other:  https://cli.github.com/manual/installation
Then authenticate once with:  gh auth login`;

/** Map a failed gh invocation onto a status + actionable message. Order matters: most specific first. */
function classify(r: Run, ctxHint: string): { status: GhStatus; message: string } {
  const raw = `${r.stderr}\n${r.stdout}`.trim();
  const low = raw.toLowerCase();

  if (r.spawnError && /enoent/i.test(r.spawnError)) return { status: "not_installed", message: NOT_INSTALLED_HELP };
  if (r.spawnError && /abort/i.test(r.spawnError)) return { status: "error", message: "Cancelled." };
  if (r.timedOut)
    return { status: "error", message: `gh timed out after ${GH_TIMEOUT_MS / 1000}s (${ctxHint}). Network or gh hang?` };
  if (r.spawnError) return { status: "error", message: `Could not run gh: ${r.spawnError}` };

  if (/no git remotes found|none of the git remotes|not a git repository|could not determine base repository/.test(low))
    return {
      status: "no_remote",
      message: `${raw}\n\nThis directory has no GitHub remote that gh recognises. Either run from a cloned GitHub repo, or pass repo:"OWNER/REPO" to target one explicitly (e.g. {"action":"${ctxHint}","repo":"cli/cli"}).`,
    };

  if (
    /you are not logged into any github|gh auth login|bad credentials|http 401|authentication failed|requires authentication/.test(
      low,
    )
  )
    return {
      status: "auth_error",
      message: `${raw}\n\ngh is not authenticated. Tell the user to run:  gh auth login\n(Do not retry this call until they confirm they have logged in.)`,
    };

  if (/required scopes|missing required scope|gh auth refresh/.test(low))
    return {
      status: "auth_error",
      message: `${raw}\n\nThe gh token is missing an OAuth scope. Tell the user to run the \`gh auth refresh -s <scope>\` command quoted above; do not retry blindly.`,
    };

  // Checked BEFORE the 403 branch: GitHub's "invalid search query" reply also contains
  // "you do not have permission", which used to be misclassified as auth_error and sent
  // the agent off to `gh auth login` for what was really a malformed query (found in testing).
  if (/invalid search query|validation failed|could not parse|unknown flag|unknown command|invalid value/.test(low))
    return {
      status: "error",
      message: `${raw}\n\nThis is a malformed request, not an auth problem (${ctxHint}) — fix the query/parameters and try again.`,
    };

  if (/http 403|must have (admin|push|write) (access|permission)|resource not accessible|forbidden/.test(low))
    return {
      status: "auth_error",
      message: `${raw}\n\nHTTP 403 / permission denied — the authenticated account may lack access to this repo, or the token lacks a scope. Ask the user to check \`gh auth status\` (and \`gh auth login\` / \`gh auth refresh\` if needed) rather than retrying.`,
    };

  if (/could not resolve to (a|an) repository/.test(low))
    return {
      status: "not_found",
      message: `${raw}\n\nThe git remote points at a repository gh cannot see (renamed, deleted, private, or wrong account). Ask the user to confirm the remote, or pass repo:"OWNER/REPO" explicitly — do not retry unchanged.`,
    };

  if (
    /could not resolve to (a|an) (pullrequest|issue)|no pull requests found|no open pull requests|not found|no such|does not exist/.test(
      low,
    )
  )
    return { status: "not_found", message: `${raw}\n\nNothing matched (${ctxHint}). Check the number/branch/repo.` };

  return { status: "error", message: raw || `gh exited with code ${r.code} (${ctxHint}) and no output.` };
}

function cap(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated at ${max} of ${text.length} chars — ${what}]`;
}

/** Like cap(), but keeps the END of the text — for logs, where the failure is at the bottom. */
function capTail(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  return `... [truncated: showing the LAST ${max} of ${text.length} chars — ${what}]\n${text.slice(-max)}`;
}

/** Shown when a write PREVIEW clips a body. The payload actually sent to gh is never clipped. */
const BODY_CAP_NOTE =
  "THIS PREVIEW DISPLAY ONLY. The full untruncated text is what gets sent to GitHub when approved";

function jsonOut<T>(r: Run): T | null {
  try {
    return JSON.parse(r.stdout || "null") as T;
  } catch {
    return null;
  }
}

/** Split a search query into argv words, keeping "quoted phrases" intact. */
function splitQuery(q: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of q.trim().matchAll(re)) {
    const v = m[1] ?? m[2] ?? m[3] ?? "";
    if (v) out.push(v);
  }
  return out.length ? out : [q];
}

const day = (s?: string | null) => (s ? String(s).split("T")[0] : "?");

/* ------------------------------------------------------------------ schema */

const READ_ACTIONS = [
  "auth_status",
  "repo_info",
  "pr_list",
  "pr_view",
  "pr_diff",
  "pr_checks",
  "search_prs",
  "search_issues",
  "issue_view",
  "run_list",
  "run_view",
  "run_log",
  "workflow_list",
] as const;

const WRITE_ACTIONS = [
  "pr_create",
  "pr_edit",
  "pr_comment",
  "pr_ready",
  "pr_merge",
  "issue_comment",
  "run_rerun",
  "run_cancel",
  "workflow_run",
] as const;

const actionEnum = [...READ_ACTIONS, ...WRITE_ACTIONS] as const;
const writeSet: Set<string> = new Set(WRITE_ACTIONS);

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "Read: auth_status, repo_info, pr_list, pr_view, pr_diff, pr_checks, search_prs, search_issues, issue_view, " +
        "run_list, run_view, run_log, workflow_list. " +
        "Write (preview-first, needs confirm_token): pr_create, pr_edit, pr_comment, pr_ready, pr_merge, issue_comment, " +
        "run_rerun, run_cancel, workflow_run.",
    },
  ),
  number: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description:
        "PR/issue number (or a PR URL/branch name). For run_view/run_log/run_rerun/run_cancel it is the workflow RUN id " +
        "(an Actions run URL works too). Omit for pr_* to use the current branch's PR, and for run_* to use the latest run on the current branch.",
    }),
  ),
  repo: Type.Optional(
    Type.String({ description: 'Target repo as "OWNER/REPO" (gh -R). Omit to use the current directory\'s repo.' }),
  ),
  state: Type.Optional(Type.String({ description: "Filter: open | closed | merged | all (pr_list, search_*)." })),
  author: Type.Optional(Type.String({ description: 'Filter by author login, or "@me" (pr_list, search_*).' })),
  base: Type.Optional(
    Type.String({ description: "Base branch. Filter for pr_list; target branch for pr_create (default: repo default branch)." }),
  ),
  head: Type.Optional(Type.String({ description: "Head branch for pr_create (default: current git branch)." })),
  search: Type.Optional(Type.String({ description: "Free-text GitHub search qualifier string for pr_list (gh pr list --search)." })),
  query: Type.Optional(Type.String({ description: 'Search query for search_prs / search_issues, e.g. "PROJ-48283".' })),
  limit: Type.Optional(Type.Number({ description: "Max results for pr_list / search_* (default 10, max 100)." })),
  title: Type.Optional(Type.String({ description: "Title for pr_create / pr_edit." })),
  body: Type.Optional(
    Type.String({
      description:
        "Body text for pr_create / pr_edit / pr_comment / issue_comment / pr_merge commit body. Pass real multi-line text " +
        "with newlines, backticks, quotes and emoji as-is — it is handed to gh over stdin, never through a shell, so no escaping is needed.",
    }),
  ),
  draft: Type.Optional(Type.Boolean({ description: "Create the PR as a draft (pr_create)." })),
  reviewers: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Reviewer logins/teams for pr_create / pr_edit (string or array).",
    }),
  ),
  labels: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], { description: "Labels for pr_create / pr_edit." }),
  ),
  merge_method: Type.Optional(
    Type.String({ description: "pr_merge: squash (default) | merge | rebase. Merging is irreversible." }),
  ),
  delete_branch: Type.Optional(Type.Boolean({ description: "pr_merge: delete the head branch after merging." })),
  body_limit: Type.Optional(
    Type.Number({
      description: `Max body chars to include in pr_view / issue_view output (default ${READ_BODY_CHARS}). Pass 0 to omit the body entirely when you only need state/checks/branches — it saves a lot of context on template-heavy PRs.`,
    }),
  ),
  patch: Type.Optional(
    Type.Boolean({ description: `pr_diff: return the raw patch (capped at ${PATCH_CHARS} chars) instead of the per-file stat.` }),
  ),
  workflow: Type.Optional(
    Type.String({
      description:
        "Workflow name, file name (ci.yml) or id. Filter for run_list; the workflow to dispatch for workflow_run (required there).",
    }),
  ),
  branch: Type.Optional(
    Type.String({ description: "Branch filter for run_list (default for run_* resolution: the current git branch)." }),
  ),
  event: Type.Optional(Type.String({ description: "run_list: trigger event filter, e.g. push | pull_request | schedule | workflow_dispatch." })),
  status: Type.Optional(
    Type.String({
      description:
        "run_list / run resolution filter: queued | in_progress | completed | success | failure | cancelled | skipped | timed_out | action_required | neutral | stale | startup_failure | requested | waiting | pending.",
    }),
  ),
  job: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description:
        "run_log / run_rerun: a single job of the run, by name (case-insensitive, substring ok) or by job databaseId from run_view. " +
        "Note the number in an Actions `/jobs/<n>` URL is NOT the job id — pass the name instead and the tool resolves it.",
    }),
  ),
  failed_only: Type.Optional(
    Type.Boolean({ description: "run_rerun: rerun ONLY the failed jobs (`gh run rerun --failed`) instead of the whole run." }),
  ),
  ref: Type.Optional(
    Type.String({ description: "workflow_run: branch/tag to run the workflow on (default: current branch, else repo default)." }),
  ),
  inputs: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'workflow_run: workflow_dispatch inputs as a flat string map, e.g. {"environment":"staging"}.',
    }),
  ),
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "pr_create only: run `gh pr create --dry-run`, which prints what WOULD be created without creating it. " +
        "Note gh may still push the head branch, so it is not a pure no-op. Still requires approval.",
    }),
  ),
  confirm_token: Type.Optional(
    Type.String({
      description:
        "Approval token from a previous preview of the SAME payload. Only pass it after the user has seen the preview " +
        "and explicitly approved it. Any change to the payload invalidates the token.",
    }),
  ),
});

export type GhToolInput = Static<typeof schema>;

/* ------------------------------------------- bash escape-hatch detection */

/**
 * gh subcommands that MUTATE something externally visible. Empirically necessary:
 * during validation, an agent that was correctly refused by the approval gate
 * immediately re-ran `gh pr create ... --body "..."` through the bash tool and
 * created the PR anyway. Guidance alone did not prevent that; this does.
 */
const GH_WRITE_SUBCOMMANDS: Record<string, string[]> = {
  pr: ["create", "edit", "comment", "merge", "ready", "close", "reopen", "review", "lock", "unlock", "checkout"],
  issue: ["create", "edit", "comment", "close", "reopen", "delete", "lock", "unlock", "pin", "unpin", "transfer", "develop"],
  release: ["create", "edit", "delete", "delete-asset", "upload"],
  repo: ["create", "delete", "edit", "fork", "archive", "unarchive", "rename", "sync", "set-default"],
  workflow: ["run", "enable", "disable"],
  run: ["rerun", "cancel", "delete"],
  secret: ["set", "delete"],
  variable: ["set", "delete"],
  label: ["create", "edit", "delete", "clone"],
  gist: ["create", "edit", "delete", "rename"],
  cache: ["delete"],
  auth: ["logout", "login", "refresh", "setup-git"],
  "project": ["create", "edit", "delete", "item-add", "item-edit", "item-delete", "field-create", "field-delete"],
};

/** Suggested gh-tool action for the blocked bash command, when there is a direct equivalent. */
const SUGGESTED_ACTION: Record<string, string> = {
  "pr create": "pr_create",
  "pr edit": "pr_edit",
  "pr comment": "pr_comment",
  "pr merge": "pr_merge",
  "pr ready": "pr_ready",
  "issue comment": "issue_comment",
  "run rerun": "run_rerun",
  "run cancel": "run_cancel",
  "workflow run": "workflow_run",
};

/** Shell words that can legitimately precede the real command in a segment. */
const PREFIX_WORDS = new Set(["sudo", "command", "nohup", "time", "env", "exec", "then", "do", "!", "{", "("]);

/**
 * Wrappers that take the real command as a quoted argument or as their trailing words.
 * Without these, `bash -c "gh pr create ..."`, `eval "..."` and `xargs -I{} gh pr create`
 * slipped past the guard entirely (found while probing the guard adversarially).
 */
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval", "xargs", "timeout", "watch", "script", "ssh"]);

/**
 * Find mutating gh invocations in a bash command string.
 *
 * Deliberately checks only the FIRST word of each pipeline/`;`/`&&` segment (plus the
 * contents of $(...) / backticks), so `echo "gh pr create ..."`, `grep 'gh pr merge' file`
 * and prose in a heredoc are NOT flagged — over-blocking reads/text would make the guard
 * worse than the risk it removes.
 */
export function findGhWrites(command: string, depth = 0): { subcommand: string; segment: string }[] {
  const hits: { subcommand: string; segment: string }[] = [];
  if (depth > 3) return hits;
  const candidates: string[] = [command];
  for (const m of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) candidates.push(m[1] ?? m[2] ?? "");

  for (const cand of candidates) {
    for (const rawSeg of cand.split(/\n|;|&&|\|\||\||&/)) {
      const seg = rawSeg.trim();
      if (!seg) continue;
      let words = seg.split(/\s+/).filter(Boolean);
      // strip env assignments and benign prefixes (sudo/env/nohup/...)
      while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || PREFIX_WORDS.has(words[0]))) words = words.slice(1);
      if (!words.length) continue;
      const bin = words[0].replace(/^.*\//, "");
      if (SHELL_WRAPPERS.has(bin)) {
        // The real command hides in a quoted argument, or in the trailing words.
        for (const q of seg.matchAll(/"([^"]*)"|'([^']*)'/g)) {
          const inner = q[1] ?? q[2] ?? "";
          if (inner.trim()) hits.push(...findGhWrites(inner, depth + 1));
        }
        const trailing = words
          .slice(1)
          .filter((w) => !w.startsWith("-") && !/^\d+$/.test(w) && w !== "{}" && !/^["']/.test(w));
        if (trailing.length) hits.push(...findGhWrites(trailing.join(" "), depth + 1));
        continue;
      }
      if (bin !== "gh") continue;
      const rest = words.slice(1).filter((w) => !w.startsWith("-"));
      const group = rest[0];
      const sub = rest[1];
      if (group === "api") {
        const method = /(?:-X|--method)[= ]+([A-Za-z]+)/.exec(seg)?.[1]?.toUpperCase();
        if (method && method !== "GET" && method !== "HEAD") hits.push({ subcommand: `api -X ${method}`, segment: seg });
        continue;
      }
      if (group && sub && GH_WRITE_SUBCOMMANDS[group]?.includes(sub)) hits.push({ subcommand: `${group} ${sub}`, segment: seg });
    }
  }
  return hits;
}

/* --------------------------------------------------- approval bookkeeping */

type Pending = { action: string; createdAt: number; payload: string };
/** token -> pending write. Single-use: deleted once executed. Module-scoped, so it dies with the session. */
const pending = new Map<string, Pending>();

/**
 * Per-process salt: makes a token unguessable and non-replayable across sessions, so
 * possession of a token from an earlier run (or knowledge of this algorithm) is never
 * enough — a preview must have happened in THIS process.
 */
const TOKEN_SALT = randomBytes(16).toString("hex");

function tokenFor(action: string, payload: unknown): string {
  const canonical = JSON.stringify({ salt: TOKEN_SALT, action, payload });
  return `gh-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > APPROVAL_TTL_MS) pending.delete(k);
}

/* ----------------------------------------------------------- git/repo info */

type RepoCtx = {
  nameWithOwner?: string;
  defaultBranch?: string;
  url?: string;
  currentBranch?: string;
  /** true when HEAD is detached (no branch) — pr_create cannot infer a head branch. */
  detached?: boolean;
  headSha?: string;
  remotes?: string[];
  failure?: { status: GhStatus; message: string };
};

async function repoContext(params: GhToolInput, cwd: string, signal?: AbortSignal): Promise<RepoCtx> {
  const out: RepoCtx = {};
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal);
  if (branch.code === 0) {
    const b = branch.stdout.trim();
    if (b === "HEAD") {
      out.detached = true;
      const sha = await git(["rev-parse", "--short", "HEAD"], cwd, signal);
      out.headSha = sha.code === 0 ? sha.stdout.trim() : undefined;
    } else out.currentBranch = b;
  }
  const remotes = await git(["remote", "-v"], cwd, signal);
  if (remotes.code === 0)
    out.remotes = [...new Set(remotes.stdout.trim().split("\n").filter(Boolean).map((l) => l.replace(/\s+/g, " ")))];

  const args = ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"];
  if (params.repo) args.splice(2, 0, "-R", params.repo);
  const rv = await gh(args, { cwd, signal });
  if (rv.code !== 0) {
    out.failure = classify(rv, params.action);
    return out;
  }
  const j = jsonOut<any>(rv);
  out.nameWithOwner = j?.nameWithOwner;
  out.defaultBranch = j?.defaultBranchRef?.name;
  out.url = j?.url;
  return out;
}

const toArr = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean);

const numArg = (n: GhToolInput["number"]): string | undefined =>
  n === undefined || n === null || `${n}`.trim() === "" ? undefined : `${n}`.trim();

/* ------------------------------------------------------------- formatting */

function checksSummary(rollup: any[] | undefined): string {
  if (!rollup || !rollup.length) return "  (no checks reported)";
  const buckets = new Map<string, number>();
  const failing: string[] = [];
  for (const c of rollup) {
    const state = String(c.conclusion || c.state || c.status || "PENDING").toUpperCase();
    buckets.set(state, (buckets.get(state) ?? 0) + 1);
    if (/FAIL|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(state))
      failing.push(`    ✗ ${c.name || c.context || "?"} (${state})${c.detailsUrl ? ` ${c.detailsUrl}` : ""}`);
  }
  const line = [...buckets.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  return `  ${rollup.length} checks: ${line}${failing.length ? `\n${failing.slice(0, 10).join("\n")}` : ""}`;
}

function prLine(p: any): string {
  const flags = [p.isDraft ? "DRAFT" : null].filter(Boolean).join(",");
  return [
    `#${p.number} ${p.title ?? ""}`,
    `  ${p.state ?? "?"}${flags ? ` (${flags})` : ""}  ${p.baseRefName ?? "?"} <- ${p.headRefName ?? "?"}  @${
      p.author?.login ?? "?"
    }  updated ${day(p.updatedAt)}`,
    p.url ? `  ${p.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/* --------------------------------------------------------- CI / Actions */

/** Valid `gh run list --status` values (gh rejects anything else with a bare "invalid value"). */
const RUN_STATUSES = [
  "queued", "completed", "in_progress", "requested", "waiting", "pending", "action_required",
  "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out",
] as const;

/** Shared field list (valid for both `gh run list` and `gh run view`). */
const RUN_FIELDS = "databaseId,number,workflowName,displayTitle,headBranch,headSha,event,status,conclusion,createdAt,updatedAt,url";

/** Effective state of a run/job/step: conclusion once finished, status while it is not. */
const stateOf = (x: any): string => String(x?.conclusion || x?.status || "unknown").toLowerCase();

function icon(state: string): string {
  if (/^(success|neutral)$/.test(state)) return "✓";
  if (/(failure|timed_out|startup_failure|action_required)/.test(state)) return "✗";
  if (/cancelled|stale/.test(state)) return "⊘";
  if (/in_progress|queued|waiting|pending|requested/.test(state)) return "◷";
  if (/skipped/.test(state)) return "–";
  return "•";
}

const isFailState = (state: string) => /(failure|timed_out|startup_failure|action_required)/.test(state);

function runLine(r: any): string {
  const st = stateOf(r);
  return [
    `${icon(st)} run ${r.databaseId}  ${r.workflowName ?? r.name ?? "?"}  [${st}]`,
    `    ${r.headBranch ?? "?"} · ${r.event ?? "?"} · ${day(r.createdAt)}  ${r.displayTitle ? `— ${r.displayTitle}` : ""}`.trimEnd(),
    r.url ? `    ${r.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull distinct Actions run ids out of check/job links so the agent can chain into run_*. */
function runIdsFrom(links: (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const l of links) {
    const m = /\/actions\/runs\/(\d+)/.exec(String(l ?? ""));
    if (m) out.add(m[1]);
  }
  return [...out];
}

type RunRef = { id?: string; note?: string; run?: any; err?: string; failure?: { status: GhStatus; message: string } };

/**
 * Resolve which workflow run to act on: the explicit `number` (id or Actions URL), else the
 * latest run on the current branch (optionally narrowed by workflow/status). Returning the
 * resolution note matters for writes — the preview must say WHICH run was picked.
 */
async function resolveRunRef(
  params: GhToolInput,
  R: string[],
  cwd: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<RunRef> {
  const raw = numArg(params.number);
  if (raw) {
    if (/^\d+$/.test(raw)) return { id: raw };
    const m = /\/actions\/runs\/(\d+)/.exec(raw);
    if (m) return { id: m[1] };
    return {
      err: `Could not read a workflow run id from number:"${raw}". Pass the numeric run id (see {"action":"run_list"}) or an Actions run URL.`,
    };
  }
  const args = ["run", "list", ...R, "--limit", "1", "--json", RUN_FIELDS];
  if (branch) args.push("--branch", branch);
  if (params.workflow) args.push("--workflow", params.workflow);
  if (params.status) args.push("--status", params.status);
  const r = await gh(args, { cwd, signal });
  if (r.code !== 0) return { failure: classify(r, params.action) };
  const first = (jsonOut<any[]>(r) ?? [])[0];
  const scope = [branch ? `branch '${branch}'` : "this repo", params.workflow ? `workflow '${params.workflow}'` : "", params.status ? `status '${params.status}'` : ""]
    .filter(Boolean)
    .join(", ");
  if (!first)
    return {
      err: `No workflow runs found for ${scope}. List them with {"action":"run_list"} and pass number:<run id> explicitly.`,
    };
  return {
    id: String(first.databaseId),
    run: first,
    note: `resolved as the latest run for ${scope} (${first.workflowName ?? "?"}, ${stateOf(first)})`,
  };
}

/** Fetch a run plus its jobs (jobs are only available on `run view`, never on `run list`). */
async function fetchRun(id: string, R: string[], cwd: string, signal?: AbortSignal) {
  const r = await gh(["run", "view", id, ...R, "--json", `${RUN_FIELDS},attempt,jobs`], { cwd, signal });
  return { raw: r, run: r.code === 0 ? jsonOut<any>(r) : null };
}

/**
 * Resolve `job` (name or id) to a job databaseId within a run.
 *
 * gh's `--job` needs the job's databaseId; the number in an Actions `/jobs/<n>` URL is a
 * different id and makes the API return 404, so a numeric job is VALIDATED against the run's
 * real job ids instead of being passed through blindly.
 */
function resolveJob(jobs: any[], want: string): { id?: string; name?: string; err?: string } {
  const list = jobs ?? [];
  const inventory = list.length
    ? list.map((j) => `    ${j.databaseId}  ${j.name} [${stateOf(j)}]`).join("\n")
    : "    (this run reported no jobs)";
  const w = want.trim().toLowerCase();
  if (/^\d+$/.test(w)) {
    const hit = list.find((j) => String(j.databaseId) === w);
    if (hit) return { id: String(hit.databaseId), name: hit.name };
    return {
      err: `job ${want} is not a job of this run. (The number in an Actions "/jobs/<n>" URL is not the job id.) Jobs in this run:\n${inventory}`,
    };
  }
  const exact = list.filter((j) => String(j.name).toLowerCase() === w);
  const partial = exact.length ? exact : list.filter((j) => String(j.name).toLowerCase().includes(w));
  if (partial.length === 1) return { id: String(partial[0].databaseId), name: partial[0].name };
  if (!partial.length) return { err: `No job named "${want}" in this run. Jobs:\n${inventory}` };
  return {
    err: `"${want}" matches ${partial.length} jobs — pass the exact name or the job id:\n${partial
      .map((j) => `    ${j.databaseId}  ${j.name} [${stateOf(j)}]`)
      .join("\n")}`,
  };
}

/* ------------------------------------------------------- write previews */

type WritePlan = {
  /** Ordered, human-readable resolved payload lines (shown verbatim to the user). */
  previewLines: string[];
  /** Canonical payload object the token is bound to (full body included — never truncated). */
  payload: Record<string, unknown>;
  /** argv for gh, excluding body (body goes over stdin when bodyStdin is set). */
  args: string[];
  bodyStdin?: string;
  /** Extra warning shown above the payload. */
  warning?: string;
  successNote?: string;
};

/**
 * Serialize approval dialogs process-wide.
 *
 * pi runs the tool calls of one assistant message in parallel unless a tool sets
 * executionMode:"sequential" (which forces the whole batch sequential). The TUI has
 * exactly ONE dialog slot: showExtensionSelector() overwrites this.extensionSelector
 * and clears the editor container, so a second concurrent ctx.ui.confirm() evicts the
 * first from the widget tree and its promise NEVER resolves — that tool call never
 * returns and the whole turn deadlocks. executionMode covers the in-batch case; this
 * queue also covers dialogs raised concurrently from elsewhere (a subagent, an event
 * handler, another gated extension). It lives on globalThis so all extensions in the
 * process share one chain.
 */
function uiExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { __piUiDialogQueue?: Promise<void> };
  const next = (g.__piUiDialogQueue ?? Promise.resolve()).then(fn, fn);
  g.__piUiDialogQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export default function (pi: ExtensionAPI) {
  /**
   * Safety guard: a mutating `gh` command run through the bash tool bypasses the
   * approval gate entirely. Block those and point the model at the gh tool instead.
   * Only active while the gh tool itself is active, so `--exclude-tools gh` (or
   * disabling the tool) restores plain bash behaviour rather than leaving no path at all.
   */
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as { command?: string })?.command;
    if (typeof command !== "string" || !command.includes("gh")) return undefined;
    let active: string[] = [];
    try {
      active = pi.getActiveTools();
    } catch {
      /* if we cannot tell, fall through to the check below */
    }
    if (active.length && !active.includes("gh")) return undefined;
    const hits = findGhWrites(command);
    if (!hits.length) return undefined;
    const h = hits[0];
    const suggestion = SUGGESTED_ACTION[h.subcommand];
    return {
      block: true,
      reason:
        `Blocked: \`gh ${h.subcommand}\` in bash would mutate GitHub with no payload preview and no user approval.\n` +
        `Use the gh tool instead${suggestion ? ` — {"action":"${suggestion}", ...}` : ""}: it shows the exact resolved payload (base, head, title, full body) and only executes after the user explicitly approves it.\n` +
        `Blocked segment: ${h.segment.slice(0, 300)}\n` +
        (suggestion
          ? ""
          : "There is no gh tool action for this operation: report to the user what you wanted to run and let THEM run it, instead of retrying through bash."),
    };
  });

  pi.registerTool({
    name: "gh",
    label: "GitHub",
    // Raises an approval dialog: must never run concurrently with another tool call.
    executionMode: "sequential",
    description: `GitHub PRs/issues via the \`gh\` CLI. Title/body are plain parameters (passed over argv+stdin, never a shell string), and every mutation is preview-first.

Read PRs/issues: auth_status, repo_info, pr_list (author/state/base/search), pr_view (number, or the current branch's PR: state, base<-head, checks, reviews, body), pr_diff (per-file stat; patch:true for the raw patch), pr_checks, search_prs, search_issues, issue_view.
Read CI (Actions): run_list (workflow/branch/status/event filters), run_view (a run's jobs + failed steps + job ids), run_log (failed-step logs, or one job's full log via job:"<name|id>"), workflow_list.
Write: pr_create, pr_edit, pr_comment, pr_ready, pr_merge, issue_comment, run_rerun (failed_only / job), run_cancel, workflow_run.

CI triage loop: pr_checks (failing run ids) -> run_view (which job/step) -> run_log (why) -> run_rerun {failed_only:true} (retry only what failed). run_* accept the run id in \`number\`, or omit it for the latest run on the current branch.

Writes never auto-run, but you do NOT ask for permission in prose first: just call the action. In an interactive session the user gets a confirm dialog with the resolved payload and decides there — one decision, no extra turn. In a non-interactive session the call instead returns the payload + a one-time confirm_token bound to a hash of it; relay that and repeat the identical call with confirm_token once the user approves. Any change to the payload (even one body character) voids the token.

Examples:
  {"action":"pr_view"}   {"action":"pr_list","author":"@me","limit":5}   {"action":"search_prs","query":"PROJ-48283"}
  {"action":"pr_create","base":"main","title":"Add upsell telemetry","body":"## What\\n- adds \`Telemetry\` hooks\\n"}  -> preview
  same call + "confirm_token":"gh-1a2b3c4d5e6f"  -> executes, only after the user approved that exact payload

Every result ends with "gh_status:" — ok | preview_pending_approval | refused_unapproved | declined | auth_error | not_installed | no_remote | not_found | error.`,
    promptSnippet: "GitHub PRs/issues via gh CLI: view/list/search/diff/checks + preview-gated PR create/edit/comment/merge",
    promptGuidelines: [
      "Use gh for anything GitHub (PRs, issues, checks, PR search) instead of running the `gh` CLI or `curl api.github.com` through bash — gh takes title/body as plain parameters and passes them to the CLI over argv/stdin, so multi-line bodies with backticks, quotes or emoji need no shell escaping.",
      "gh write actions (pr_create, pr_edit, pr_comment, pr_ready, pr_merge, issue_comment) mutate a real, externally visible GitHub repo, so the tool itself asks the user — do not pre-ask in prose, and do not summarize the payload before calling. Call the action once with the full parameters: interactive sessions show a confirm dialog, and if the reply instead comes back as a preview + confirm_token, relay it verbatim and repeat the call with the token after the user approves. Never invent or reuse a confirm_token, and never call a write action twice in one turn.",
      "When a gh result ends with gh_status: preview_pending_approval, nothing was created or changed — do not report success and do not retry; relay the preview and wait for the user.",
      "When a gh result ends with gh_status: auth_error, tell the user to run `gh auth login` (or the exact `gh auth refresh -s ...` command quoted in the output) and stop; when it ends with gh_status: not_installed, tell them to install the GitHub CLI. Do not retry either case.",
      "When a gh result ends with gh_status: no_remote, the working directory has no GitHub remote: pass repo:\"OWNER/REPO\" explicitly instead of retrying the same call.",
      "For gh pr_merge, state the merge method and that merging is irreversible when asking the user to approve.",
      "Prefer gh pr_diff without patch:true (per-file added/removed stat) to judge PR size, and only pass patch:true when the actual code changes are needed — the patch is capped and can be large.",
      "For CI failures use the gh tool, not the Actions web UI or bash `gh run`: pr_checks (or run_list) gives the failing run id, run_view shows which job/step failed plus job ids, and run_log returns the failing log tail (add job:\"<name>\" to read one job's full log). Omit `number` on run_* to target the latest run of the current branch.",
      "To retry CI, prefer gh run_rerun with failed_only:true (reruns only the failed jobs) or job:\"<name or id>\" for a single job, instead of rerunning everything; it is preview-gated like other writes because a rerun spends CI minutes and can re-trigger deploys. Never pass a number from an Actions `/jobs/<n>` URL as `job` — pass the job name and let the tool resolve the real id.",
      "gh run_cancel aborts an in-progress run and workflow_run dispatches a new one (workflow_dispatch, with ref + inputs) — both are real CI mutations, so call them once and let the tool's approval step handle the confirmation.",
      "A gh preview caps the DISPLAYED body at 4000 chars; the body actually sent to GitHub is never truncated, so a \"truncated at 4000 of N chars\" note in a preview is a display cap only and is not a reason to shorten the body.",
      "Pass body_limit:0 to gh pr_view/issue_view when the question is only about state, branches, checks or reviews — PR templates are long and the body is usually the biggest part of the output.",
      "Running a mutating `gh` command (gh pr create/merge/edit/comment/ready, gh issue comment, gh api -X POST/PATCH/DELETE, ...) through bash is blocked while the gh tool is active, because it would skip the payload preview. If a bash gh command is blocked, use the corresponding gh action; if there is no matching action, tell the user the command instead of looking for another way to run it.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      sweep();
      const cwd = ctx.cwd;
      const fin = (text: string, st: GhStatus = "ok", extra: Record<string, unknown> = {}) => {
        return {
          content: [{ type: "text" as const, text: `${text}\n\ngh_status: ${st}` }],
          details: { action: params.action, ghStatus: st, ...extra },
          isError: st !== "ok" && st !== "preview_pending_approval",
        };
      };
      const bad = (msg: string) => fin(`Error: ${msg}`, "error");
      const limit = Math.max(1, Math.min(Math.floor(params.limit ?? 10), 100));
      const bodyLimit = params.body_limit === undefined ? READ_BODY_CHARS : Math.max(0, Math.floor(params.body_limit));
      const R = params.repo ? ["-R", params.repo] : [];

      try {
        /* ------------------------------------------------------------- reads */
        switch (params.action) {
          case "auth_status": {
            const ver = await gh(["--version"], { cwd, signal });
            if (ver.spawnError) {
              const c = classify(ver, "auth_status");
              return fin(c.message, c.status);
            }
            const st = await gh(["auth", "status"], { cwd, signal });
            const text = `${(st.stdout + st.stderr).trim() || "(no output)"}`;
            if (st.code !== 0) {
              const c = classify(st, "auth_status");
              return fin(`${ver.stdout.trim().split("\n")[0]}\n\n${c.message}`, c.status);
            }
            return fin(`${ver.stdout.trim().split("\n")[0]}\n\n${text}`);
          }

          case "repo_info": {
            const rc = await repoContext(params, cwd, signal);
            const head = rc.detached
              ? `  Branch:   (detached HEAD at ${rc.headSha ?? "?"}) — pr_create needs an explicit head branch`
              : `  Branch:   ${rc.currentBranch ?? "?"}`;
            const remotes = rc.remotes?.length ? rc.remotes.map((r) => `    ${r}`).join("\n") : "    (none)";
            if (rc.failure)
              return fin(
                [`Local git context (cwd ${cwd}):`, head, "  Remotes:", remotes, "", rc.failure.message].join("\n"),
                rc.failure.status,
              );
            return fin(
              [
                `Repo:     ${rc.nameWithOwner ?? "?"}`,
                `URL:      ${rc.url ?? "?"}`,
                `Default:  ${rc.defaultBranch ?? "?"}`,
                head,
                "  Remotes:",
                remotes,
              ].join("\n"),
            );
          }

          case "pr_list": {
            const args = ["pr", "list", ...R, "--limit", String(limit), "--json",
              "number,title,author,state,isDraft,baseRefName,headRefName,updatedAt,url"];
            const st = (params.state ?? "open").toLowerCase();
            if (["open", "closed", "merged", "all"].includes(st)) args.push("--state", st);
            else return bad(`state must be open|closed|merged|all (got '${params.state}').`);
            if (params.author) args.push("--author", params.author);
            if (params.base) args.push("--base", params.base);
            if (params.head) args.push("--head", params.head);
            if (params.search) args.push("--search", params.search);
            const r = await gh(args, { cwd, signal });
            if (r.code !== 0) {
              const c = classify(r, "pr_list");
              return fin(c.message, c.status);
            }
            const list = jsonOut<any[]>(r) ?? [];
            if (!list.length)
              return fin(
                `No PRs matched (state=${st}${params.author ? ` author=${params.author}` : ""}${
                  params.base ? ` base=${params.base}` : ""
                }${params.search ? ` search="${params.search}"` : ""}).`,
              );
            return fin(`PRs (${list.length} shown, state=${st}):\n\n${list.map(prLine).join("\n\n")}`);
          }

          case "pr_view": {
            const args = ["pr", "view", ...(numArg(params.number) ? [numArg(params.number)!] : []), ...R, "--json",
              "number,title,state,isDraft,baseRefName,headRefName,author,url,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,latestReviews,body,additions,deletions,changedFiles,updatedAt"];
            const r = await gh(args, { cwd, signal });
            if (r.code !== 0) {
              const c = classify(r, "pr_view");
              return fin(c.message, c.status);
            }
            const p = jsonOut<any>(r);
            if (!p)
              return fin(
                `gh exited 0 but returned no parseable PR JSON. Raw output:\n${cap(`${r.stdout}${r.stderr}`.trim() || "(empty)", 300, "raw gh output")}`,
                "error",
              );
            const reviews = (p.latestReviews ?? []).map((v: any) => `    ${v.author?.login ?? "?"}: ${v.state}`);
            return fin(
              [
                `PR:       #${p.number} ${p.title}`,
                `URL:      ${p.url}`,
                `State:    ${p.state}${p.isDraft ? " (DRAFT)" : ""}`,
                `Branches: ${p.baseRefName} <- ${p.headRefName}`,
                `Author:   @${p.author?.login ?? "?"}   updated ${day(p.updatedAt)}`,
                `Size:     +${p.additions ?? "?"} -${p.deletions ?? "?"} across ${p.changedFiles ?? "?"} files`,
                `Mergeable:${p.mergeable ?? "?"} (${p.mergeStateStatus ?? "?"})`,
                `Review:   ${p.reviewDecision || "no decision yet"}`,
                ...(reviews.length ? ["  Latest reviews:", ...reviews] : []),
                "Checks:",
                checksSummary(p.statusCheckRollup),
                "",
                ...(bodyLimit === 0
                  ? ["Body:  (omitted: body_limit=0)"]
                  : ["Body:", p.body?.trim() ? cap(p.body, bodyLimit, "body; raise body_limit for more") : "(empty)"]),
              ].join("\n"),
            );
          }

          case "pr_diff": {
            const n = numArg(params.number);
            if (params.patch) {
              const r = await gh(["pr", "diff", ...(n ? [n] : []), ...R, "--patch", "--color", "never"], { cwd, signal });
              if (r.code !== 0) {
                const c = classify(r, "pr_diff");
                return fin(c.message, c.status);
              }
              return fin(
                `Patch for PR ${n ? `#${n}` : "(current branch)"}:\n\n${cap(r.stdout, PATCH_CHARS, "patch") || "(empty diff)"}`,
              );
            }
            // Default: per-file stat, derived from the PR's files list (gh pr diff has no --stat).
            const r = await gh(["pr", "view", ...(n ? [n] : []), ...R, "--json", "number,files,additions,deletions,changedFiles"], {
              cwd,
              signal,
            });
            if (r.code !== 0) {
              const c = classify(r, "pr_diff");
              return fin(c.message, c.status);
            }
            const p = jsonOut<any>(r);
            const files = (p?.files ?? []) as any[];
            const lines = files
              .slice(0, 200)
              .map((f) => `  +${String(f.additions).padStart(5)} -${String(f.deletions).padStart(5)}  ${f.path}`);
            return fin(
              [
                `Diff stat for PR #${p?.number ?? "?"}: ${p?.changedFiles ?? files.length} files, +${p?.additions ?? "?"} -${
                  p?.deletions ?? "?"
                }`,
                ...lines,
                files.length > 200 ? `  ... ${files.length - 200} more files` : "",
                "",
                "Pass patch:true for the raw patch.",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }

          case "pr_checks": {
            const n = numArg(params.number);
            const r = await gh(["pr", "checks", ...(n ? [n] : []), ...R, "--json", "name,state,bucket,link,workflow"], {
              cwd,
              signal,
            });
            // Exit 8 = "checks pending", which is a normal state, not a failure.
            const rows = jsonOut<any[]>(r);
            if (r.code !== 0 && r.code !== 8 && !rows) {
              const c = classify(r, "pr_checks");
              // "no checks reported on the branch" is informational, not an error.
              if (/no checks reported/i.test(`${r.stderr}${r.stdout}`))
                return fin(`No checks reported for PR ${n ? `#${n}` : "(current branch)"}.`);
              return fin(c.message, c.status);
            }
            const list = rows ?? [];
            if (!list.length) return fin(`No checks reported for PR ${n ? `#${n}` : "(current branch)"}.`);
            const byBucket = new Map<string, number>();
            for (const c of list) byBucket.set(c.bucket ?? "?", (byBucket.get(c.bucket ?? "?") ?? 0) + 1);
            const failing = list.filter((c) => c.bucket === "fail");
            const notable = list
              .filter((c) => c.bucket !== "pass" && c.bucket !== "skipping")
              .slice(0, 25)
              .map((c) => `  ${c.bucket === "fail" ? "✗" : "•"} ${c.name} [${c.bucket}/${c.state}]${c.link ? ` ${c.link}` : ""}`);
            const failedRunIds = runIdsFrom(failing.map((c) => c.link));
            return fin(
              [
                `Checks for PR ${n ? `#${n}` : "(current branch)"}: ${list.length} total — ${[...byBucket.entries()]
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}${r.code === 8 ? " (some still pending)" : ""}`,
                ...(notable.length ? ["Not passing:", ...notable] : ["All checks passing or skipped."]),
                ...(failedRunIds.length
                  ? [
                      "",
                      `Failing Actions run id(s): ${failedRunIds.join(", ")}`,
                      `  logs:  {"action":"run_log","number":${failedRunIds[0]}}`,
                      `  rerun: {"action":"run_rerun","number":${failedRunIds[0]},"failed_only":true}`,
                    ]
                  : []),
              ].join("\n"),
            );
          }

          case "search_prs":
          case "search_issues": {
            if (!params.query?.trim()) return bad(`query is required for action=${params.action}.`);
            const kind = params.action === "search_prs" ? "prs" : "issues";
            const fields =
              kind === "prs" ? "url,title,state,repository,updatedAt,author,isDraft" : "url,title,state,repository,updatedAt,author";
            // gh treats a single argv element as ONE quoted phrase, so `repo:x is:open foo`
            // must be split into separate words or GitHub rejects it as an invalid query.
            const terms = splitQuery(params.query);
            const args = ["search", kind, ...terms, "--limit", String(limit), "--json", fields];
            if (params.repo) args.push("--repo", params.repo);
            if (params.author) args.push("--author", params.author);
            if (params.state && ["open", "closed"].includes(params.state.toLowerCase()))
              args.push("--state", params.state.toLowerCase());
            const r = await gh(args, { cwd, signal });
            if (r.code !== 0) {
              const c = classify(r, params.action);
              return fin(c.message, c.status);
            }
            const list = jsonOut<any[]>(r) ?? [];
            if (!list.length) return fin(`No ${kind} matched "${params.query}".`);
            return fin(
              `${kind} matching "${params.query}" (${list.length} shown):\n\n${list
                .map(
                  (i) =>
                    `${i.repository?.nameWithOwner ?? "?"} — ${i.title}\n  ${i.state}${
                      i.isDraft ? " (DRAFT)" : ""
                    }  @${i.author?.login ?? "?"}  updated ${day(i.updatedAt)}\n  ${i.url}`,
                )
                .join("\n\n")}`,
            );
          }

          case "issue_view": {
            const n = numArg(params.number);
            if (!n) return bad("number is required for action=issue_view.");
            const r = await gh(["issue", "view", n, ...R, "--json",
              "number,title,state,author,labels,assignees,url,body,updatedAt,comments"], { cwd, signal });
            if (r.code !== 0) {
              const c = classify(r, "issue_view");
              return fin(c.message, c.status);
            }
            const i = jsonOut<any>(r);
            if (!i)
              return fin(
                `gh exited 0 but returned no parseable issue JSON. Raw output:\n${cap(`${r.stdout}${r.stderr}`.trim() || "(empty)", 300, "raw gh output")}`,
                "error",
              );
            return fin(
              [
                `Issue:    #${i.number} ${i.title}`,
                `URL:      ${i.url}`,
                `State:    ${i.state}`,
                `Author:   @${i.author?.login ?? "?"}   updated ${day(i.updatedAt)}`,
                `Labels:   ${(i.labels ?? []).map((l: any) => l.name).join(", ") || "(none)"}`,
                `Assignees:${(i.assignees ?? []).map((a: any) => a.login).join(", ") || " (none)"}`,
                `Comments: ${(i.comments ?? []).length}`,
                "",
                ...(bodyLimit === 0
                  ? ["Body:  (omitted: body_limit=0)"]
                  : ["Body:", i.body?.trim() ? cap(i.body, bodyLimit, "body; raise body_limit for more") : "(empty)"]),
              ].join("\n"),
            );
          }

          /* ------------------------------------------------------ CI reads */

          case "run_list": {
            if (params.status && !RUN_STATUSES.includes(params.status.toLowerCase() as any))
              return bad(`status must be one of: ${RUN_STATUSES.join(" | ")} (got '${params.status}').`);
            const args = ["run", "list", ...R, "--limit", String(limit), "--json", RUN_FIELDS];
            if (params.workflow) args.push("--workflow", params.workflow);
            if (params.branch) args.push("--branch", params.branch);
            if (params.event) args.push("--event", params.event);
            if (params.status) args.push("--status", params.status.toLowerCase());
            if (params.author) {
              let user = params.author;
              if (user === "@me") {
                const who = await gh(["api", "user", "--jq", ".login"], { cwd, signal });
                if (who.code === 0 && who.stdout.trim()) user = who.stdout.trim();
              }
              args.push("--user", user);
            }
            const r = await gh(args, { cwd, signal });
            if (r.code !== 0) {
              const c = classify(r, "run_list");
              return fin(c.message, c.status);
            }
            const runs = jsonOut<any[]>(r) ?? [];
            const scope = [
              params.workflow ? `workflow=${params.workflow}` : "",
              params.branch ? `branch=${params.branch}` : "",
              params.status ? `status=${params.status}` : "",
              params.event ? `event=${params.event}` : "",
            ]
              .filter(Boolean)
              .join(" ");
            if (!runs.length) return fin(`No workflow runs matched${scope ? ` (${scope})` : ""}.`);
            const firstFail = runs.find((x) => isFailState(stateOf(x)));
            return fin(
              [
                `Workflow runs (${runs.length} shown${scope ? `, ${scope}` : ""}):`,
                "",
                runs.map(runLine).join("\n\n"),
                ...(firstFail
                  ? ["", `Inspect a failure: {"action":"run_view","number":${firstFail.databaseId}} — then run_log / run_rerun.`]
                  : []),
              ].join("\n"),
            );
          }

          case "run_view": {
            const ref = await resolveRunRef(params, R, cwd, params.branch ?? undefined, signal);
            if (ref.failure) return fin(ref.failure.message, ref.failure.status);
            if (!ref.id) return bad(ref.err ?? "Could not resolve a workflow run.");
            const { raw, run } = await fetchRun(ref.id, R, cwd, signal);
            if (raw.code !== 0 || !run) {
              const c = classify(raw, "run_view");
              return fin(c.message, c.status);
            }
            const jobs = (run.jobs ?? []) as any[];
            const jobLines = jobs.slice(0, 50).flatMap((j) => {
              const js = stateOf(j);
              const failedSteps = (j.steps ?? [])
                .filter((s: any) => isFailState(stateOf(s)))
                .slice(0, 5)
                .map((s: any) => `      failed step #${s.number}: ${s.name} [${stateOf(s)}]`);
              return [
                `  ${icon(js)} ${j.name}  [${js}]  job id ${j.databaseId}`,
                ...failedSteps,
                ...(isFailState(js) ? [`      log: {"action":"run_log","number":${run.databaseId},"job":${j.databaseId}}`] : []),
              ];
            });
            const failedJobs = jobs.filter((j) => isFailState(stateOf(j)));
            const st = stateOf(run);
            return fin(
              [
                `Run:      ${run.databaseId}  ${run.workflowName ?? "?"}${run.attempt && run.attempt > 1 ? `  (attempt ${run.attempt})` : ""}${
                  ref.note ? `   [${ref.note}]` : ""
                }`,
                `Title:    ${run.displayTitle ?? "?"}`,
                `URL:      ${run.url ?? "?"}`,
                `Branch:   ${run.headBranch ?? "?"} @ ${String(run.headSha ?? "").slice(0, 8)}   event: ${run.event ?? "?"}`,
                `State:    ${icon(st)} ${run.status ?? "?"}${run.conclusion ? ` / ${run.conclusion}` : ""}   created ${day(run.createdAt)}, updated ${day(run.updatedAt)}`,
                `Jobs:     ${jobs.length}${failedJobs.length ? `  (${failedJobs.length} failing)` : ""}`,
                ...jobLines,
                jobs.length > 50 ? `  ... ${jobs.length - 50} more jobs` : "",
                "",
                ...(failedJobs.length
                  ? [
                      `Failing logs: {"action":"run_log","number":${run.databaseId}}   (all failed steps of the run)`,
                      `Rerun failed: {"action":"run_rerun","number":${run.databaseId},"failed_only":true}`,
                    ]
                  : st === "in_progress" || st === "queued"
                    ? ["Run is not finished yet — logs become available as jobs complete."]
                    : []),
              ]
                .filter((l) => l !== "")
                .join("\n"),
            );
          }

          case "run_log": {
            const ref = await resolveRunRef(params, R, cwd, params.branch ?? undefined, signal);
            if (ref.failure) return fin(ref.failure.message, ref.failure.status);
            if (!ref.id) return bad(ref.err ?? "Could not resolve a workflow run.");
            let args = ["run", "view", ref.id, ...R, "--log-failed"];
            let what = `failed steps of run ${ref.id}`;
            if (params.job !== undefined && `${params.job}`.trim() !== "") {
              const { raw, run } = await fetchRun(ref.id, R, cwd, signal);
              if (raw.code !== 0 || !run) {
                const c = classify(raw, "run_log");
                return fin(c.message, c.status);
              }
              const jr = resolveJob(run.jobs ?? [], `${params.job}`);
              if (!jr.id) return bad(jr.err ?? "Could not resolve the job.");
              // `gh run view --job <id> --log` takes NO positional run id.
              args = ["run", "view", ...R, "--job", jr.id, "--log"];
              what = `full log of job "${jr.name}" (${jr.id}) in run ${ref.id}`;
            }
            const r = await gh(args, { cwd, signal, timeout: 120_000 });
            const blob = `${r.stdout}`.trim();
            if (r.code !== 0 && !blob) {
              const joined = `${r.stderr}${r.stdout}`.toLowerCase();
              if (/still in progress|has not completed|no logs found/.test(joined))
                return fin(
                  `No logs yet for run ${ref.id}: the run (or the requested job) has not completed — GitHub only serves logs for finished jobs.\nCheck progress with {"action":"run_view","number":${ref.id}} and retry when it is done.`,
                );
              const c = classify(r, "run_log");
              return fin(c.message, c.status);
            }
            if (!blob)
              return fin(
                `No failing-step logs for run ${ref.id} (nothing failed, or GitHub expired the logs — they are retained ~90 days).\nSee {"action":"run_view","number":${ref.id}} for per-job state.`,
              );
            return fin(
              [
                `Logs — ${what}${ref.note ? `  [${ref.note}]` : ""}:`,
                "----------------------------------------",
                capTail(blob, LOG_CHARS, 'log tail; narrow with job:"<name>" for one job'),
                "----------------------------------------",
                ...(params.job === undefined
                  ? ['Narrow to one job with job:"<job name or id>" (names come from run_view).']
                  : []),
              ].join("\n"),
            );
          }

          case "workflow_list": {
            const r = await gh(["workflow", "list", ...R, "--limit", String(Math.max(limit, 30)), "--all", "--json", "id,name,path,state"], {
              cwd,
              signal,
            });
            if (r.code !== 0) {
              const c = classify(r, "workflow_list");
              return fin(c.message, c.status);
            }
            const wfs = jsonOut<any[]>(r) ?? [];
            if (!wfs.length) return fin("No workflows found in this repository.");
            return fin(
              [
                `Workflows (${wfs.length}):`,
                ...wfs.map((w) => `  ${w.state === "active" ? "✓" : "–"} ${w.name}  [${w.state}]  ${w.path}  id ${w.id}`),
                "",
                'Runs of one workflow: {"action":"run_list","workflow":"<name or file.yml>"}',
              ].join("\n"),
            );
          }
        }

        /* ------------------------------------------------------------ writes */
        if (!writeSet.has(params.action)) return bad(`Unknown action '${params.action}'. Valid: ${actionEnum.join(", ")}`);

        const rc = await repoContext(params, cwd, signal);
        if (rc.failure) return fin(rc.failure.message, rc.failure.status);

        const reviewers = toArr(params.reviewers);
        const labels = toArr(params.labels);
        const n = numArg(params.number);
        let plan: WritePlan;

        switch (params.action) {
          case "pr_create": {
            if (!params.title?.trim()) return bad("title is required for action=pr_create.");
            const head = params.head?.trim() || rc.currentBranch;
            if (!head)
              return bad(
                rc.detached
                  ? `HEAD is detached (at ${rc.headSha ?? "?"}), so there is no current branch to use as the PR head. Pass head:"branch-name" explicitly, or check out a branch first.`
                  : "Could not determine the head branch. Pass head:\"branch-name\".",
              );
            const base = params.base?.trim() || rc.defaultBranch;
            if (!base) return bad('Could not determine the base branch. Pass base:"main" explicitly.');
            const body = params.body ?? "";
            const args = ["pr", "create", ...R, "--base", base, "--head", head, "--title", params.title, "--body-file", "-"];
            if (params.draft) args.push("--draft");
            for (const rv of reviewers) args.push("--reviewer", rv);
            for (const l of labels) args.push("--label", l);
            if (params.dry_run) args.push("--dry-run");
            plan = {
              payload: { repo: rc.nameWithOwner, base, head, title: params.title, body, draft: !!params.draft, reviewers, labels, dryRun: !!params.dry_run },
              args,
              bodyStdin: body,
              previewLines: [
                `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
                `Base:      ${base}${params.base ? "" : "   (repo default branch)"}`,
                `Head:      ${head}${params.head ? "" : "   (current git branch)"}`,
                `Draft:     ${params.draft ? "yes" : "no"}`,
                `Reviewers: ${reviewers.join(", ") || "(none)"}`,
                `Labels:    ${labels.join(", ") || "(none)"}`,
                `Title:     ${params.title}${params.title.length > 256 ? `   !! ${params.title.length} chars — GitHub PR titles are limited to 256; shorten it or GitHub will reject the call` : ""}`,
                params.dry_run ? "Mode:      --dry-run (gh prints details instead of creating; may still push the head branch)" : "",
                "",
                `Body (${body.length} chars):`,
                "----------------------------------------",
                cap(body, PREVIEW_BODY_CHARS, BODY_CAP_NOTE),
                "----------------------------------------",
              ].filter(Boolean),
              warning: params.dry_run
                ? "This will run gh pr create --dry-run (no PR created, but gh may push the head branch)."
                : "This CREATES A PUBLICLY VISIBLE PULL REQUEST on GitHub.",
              successNote: "PR created",
            };
            break;
          }

          case "pr_edit": {
            if (!params.title?.trim() && params.body === undefined && !reviewers.length && !labels.length && !params.base)
              return bad("action=pr_edit needs at least one of title, body, base, reviewers, labels.");
            const args = ["pr", "edit", ...(n ? [n] : []), ...R];
            if (params.title) args.push("--title", params.title);
            if (params.base) args.push("--base", params.base);
            for (const rv of reviewers) args.push("--add-reviewer", rv);
            for (const l of labels) args.push("--add-label", l);
            const body = params.body;
            if (body !== undefined) args.push("--body-file", "-");
            plan = {
              payload: { repo: rc.nameWithOwner, number: n ?? `(current branch: ${rc.currentBranch ?? "?"})`, title: params.title, base: params.base, body, reviewers, labels },
              args,
              bodyStdin: body,
              previewLines: [
                `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
                `PR:        ${n ? `#${n}` : `(PR of current branch ${rc.currentBranch ?? "?"})`}`,
                params.title ? `New title: ${params.title}` : "Title:     (unchanged)",
                params.base ? `New base:  ${params.base}` : "Base:      (unchanged)",
                `Add reviewers: ${reviewers.join(", ") || "(none)"}`,
                `Add labels:    ${labels.join(", ") || "(none)"}`,
                ...(body === undefined
                  ? ["Body:      (unchanged)"]
                  : [
                      "",
                      `REPLACEMENT body (${body.length} chars) — this OVERWRITES the existing description:`,
                      "----------------------------------------",
                      cap(body, PREVIEW_BODY_CHARS, BODY_CAP_NOTE),
                      "----------------------------------------",
                    ]),
              ],
              warning: body !== undefined ? "This REPLACES the PR description (the old text is not kept)." : "This edits an existing PR.",
              successNote: "PR updated",
            };
            break;
          }

          case "pr_comment":
          case "issue_comment": {
            const isPr = params.action === "pr_comment";
            if (!params.body?.trim()) return bad(`body is required for action=${params.action}.`);
            if (!isPr && !n) return bad("number is required for action=issue_comment.");
            const args = [isPr ? "pr" : "issue", "comment", ...(n ? [n] : []), ...R, "--body-file", "-"];
            plan = {
              payload: { repo: rc.nameWithOwner, kind: isPr ? "pr" : "issue", number: n ?? `(current branch: ${rc.currentBranch ?? "?"})`, body: params.body },
              args,
              bodyStdin: params.body,
              previewLines: [
                `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
                `${isPr ? "PR" : "Issue"}:        ${n ? `#${n}` : `(PR of current branch ${rc.currentBranch ?? "?"})`}`,
                "",
                `Comment (${params.body.length} chars):`,
                "----------------------------------------",
                cap(params.body, PREVIEW_BODY_CHARS, BODY_CAP_NOTE),
                "----------------------------------------",
              ],
              warning: `This posts a publicly visible comment (notifying subscribers) on the ${isPr ? "pull request" : "issue"}.`,
              successNote: "Comment posted",
            };
            break;
          }

          case "pr_ready": {
            plan = {
              payload: { repo: rc.nameWithOwner, number: n ?? `(current branch: ${rc.currentBranch ?? "?"})` },
              args: ["pr", "ready", ...(n ? [n] : []), ...R],
              previewLines: [
                `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
                `PR:        ${n ? `#${n}` : `(PR of current branch ${rc.currentBranch ?? "?"})`}`,
                "Action:    mark as ready for review (leaves draft state, requests reviews / notifies reviewers)",
              ],
              warning: "This takes the PR out of draft and notifies reviewers.",
              successNote: "PR marked ready for review",
            };
            break;
          }

          case "pr_merge": {
            const method = (params.merge_method ?? "squash").toLowerCase();
            if (!["squash", "merge", "rebase"].includes(method))
              return bad(`merge_method must be squash|merge|rebase (got '${params.merge_method}').`);
            const args = ["pr", "merge", ...(n ? [n] : []), ...R, `--${method}`];
            if (params.delete_branch) args.push("--delete-branch");
            if (params.body) args.push("--body-file", "-");
            plan = {
              payload: { repo: rc.nameWithOwner, number: n ?? `(current branch: ${rc.currentBranch ?? "?"})`, method, deleteBranch: !!params.delete_branch, body: params.body ?? "" },
              args,
              bodyStdin: params.body,
              previewLines: [
                `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
                `PR:        ${n ? `#${n}` : `(PR of current branch ${rc.currentBranch ?? "?"})`}`,
                `Method:    --${method}`,
                `Delete head branch after merge: ${params.delete_branch ? "YES (local + remote)" : "no"}`,
                ...(params.body
                  ? [
                      "",
                      `Merge commit body (${params.body.length} chars):`,
                      "----------------------------------------",
                      cap(params.body, PREVIEW_BODY_CHARS, BODY_CAP_NOTE),
                      "----------------------------------------",
                    ]
                  : []),
              ],
              warning: `MERGING IS IRREVERSIBLE: this ${method}-merges the PR into its base branch immediately${
                params.delete_branch ? " and DELETES the head branch" : ""
              }. It can trigger deploys and cannot be undone with gh.`,
              successNote: "PR merged",
            };
            break;
          }

          /* ----------------------------------------------------- CI writes */

          case "run_rerun":
          case "run_cancel": {
            const ref = await resolveRunRef(params, R, cwd, params.branch ?? rc.currentBranch, signal);
            if (ref.failure) return fin(ref.failure.message, ref.failure.status);
            if (!ref.id) return bad(ref.err ?? "Could not resolve a workflow run.");
            const { raw, run } = await fetchRun(ref.id, R, cwd, signal);
            if (raw.code !== 0 || !run) {
              const c = classify(raw, params.action);
              return fin(c.message, c.status);
            }
            const jobs = (run.jobs ?? []) as any[];
            const failedJobs = jobs.filter((j) => isFailState(stateOf(j)));
            const runHead = [
              `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
              `Run:       ${run.databaseId}  ${run.workflowName ?? "?"}${run.attempt && run.attempt > 1 ? ` (attempt ${run.attempt})` : ""} — ${run.displayTitle ?? ""}`,
              `URL:       ${run.url ?? "?"}`,
              `Branch:    ${run.headBranch ?? "?"} @ ${String(run.headSha ?? "").slice(0, 8)}   event: ${run.event ?? "?"}`,
              `State:     ${run.status ?? "?"}${run.conclusion ? ` / ${run.conclusion}` : ""}   (${jobs.length} jobs, ${failedJobs.length} failing)`,
              ...(ref.note ? [`Resolved:  no number was given — ${ref.note}`] : []),
            ];

            if (params.action === "run_cancel") {
              if (String(run.status).toLowerCase() === "completed")
                return bad(
                  `Run ${run.databaseId} already finished (${stateOf(run)}), so there is nothing to cancel. Nothing was sent.`,
                );
              plan = {
                payload: { repo: rc.nameWithOwner, runId: String(run.databaseId), workflow: run.workflowName },
                args: ["run", "cancel", String(run.databaseId), ...R],
                previewLines: [...runHead, "Action:    CANCEL this in-progress run (all queued/running jobs are stopped)"],
                warning:
                  "This CANCELS a running CI job. Work in progress is aborted mid-step, which can leave a deploy/publish half-finished, and the PR's checks turn red.",
                successNote: "Cancel requested",
              };
              break;
            }

            const jobSel =
              params.job !== undefined && `${params.job}`.trim() !== "" ? resolveJob(jobs, `${params.job}`) : null;
            if (jobSel && !jobSel.id) return bad(jobSel.err ?? "Could not resolve the job.");
            if (!jobSel && params.failed_only && !failedJobs.length)
              return bad(
                `failed_only:true was requested but run ${run.databaseId} has no failed jobs (state: ${stateOf(run)}). Nothing was sent. Drop failed_only to rerun the whole run, or pick another run with {"action":"run_list","status":"failure"}.`,
              );
            const scope = jobSel
              ? `ONE job: "${jobSel.name}" (id ${jobSel.id}) plus the jobs it depends on`
              : params.failed_only
                ? `ONLY the failed jobs (${failedJobs.map((j) => j.name).join(", ")})`
                : `ALL ${jobs.length} jobs of the run`;
            plan = {
              payload: {
                repo: rc.nameWithOwner,
                runId: String(run.databaseId),
                workflow: run.workflowName,
                failedOnly: !!params.failed_only && !jobSel,
                job: jobSel?.id ?? null,
              },
              // `gh run rerun --job <id>` takes no positional run id.
              args: jobSel
                ? ["run", "rerun", ...R, "--job", jobSel.id!]
                : ["run", "rerun", String(run.databaseId), ...R, ...(params.failed_only ? ["--failed"] : [])],
              previewLines: [...runHead, `Rerun:     ${scope}`],
              warning:
                "This RE-RUNS GitHub Actions on the repo: it spends CI minutes, replaces the existing check results, and re-executes everything those jobs do (including any deploy/publish/notification steps).",
              successNote: "Rerun requested",
            };
            break;
          }

          case "workflow_run": {
            if (!params.workflow?.trim())
              return bad(
                'workflow is required for action=workflow_run (name, file name like "ci.yml", or id — list them with {"action":"workflow_list"}).',
              );
            const wfRef = params.ref?.trim() || rc.currentBranch || rc.defaultBranch;
            if (!wfRef)
              return bad('Could not determine a ref to run the workflow on (detached HEAD?). Pass ref:"main" explicitly.');
            const inputs = Object.entries(params.inputs ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);
            if (inputs.length > 25)
              return bad(`workflow_dispatch supports at most 25 inputs; got ${inputs.length}.`);
            const wfArgs = ["workflow", "run", params.workflow.trim(), ...R, "--ref", wfRef];
            for (const [k, v] of inputs) wfArgs.push("-f", `${k}=${v}`);
            plan = {
              payload: { repo: rc.nameWithOwner, workflow: params.workflow.trim(), ref: wfRef, inputs: Object.fromEntries(inputs) },
              args: wfArgs,
              previewLines: [
                `Repo:      ${rc.nameWithOwner ?? "(current dir)"}`,
                `Workflow:  ${params.workflow.trim()}`,
                `Ref:       ${wfRef}${params.ref ? "" : "   (current branch / repo default)"}`,
                `Inputs:    ${inputs.length ? "" : "(none)"}`,
                ...inputs.map(([k, v]) => `    ${k} = ${v.length > 200 ? `${v.slice(0, 200)}…` : v}`),
              ],
              warning:
                "This DISPATCHES a real workflow run on GitHub (workflow_dispatch). It executes CI immediately and can build, deploy, publish or notify — check the ref and inputs carefully.",
              successNote: "Workflow dispatched",
            };
            break;
          }

          default:
            return bad(`Unhandled write action '${params.action}'.`);
        }

        const token = tokenFor(params.action, plan.payload);

        /** Send it. Shared by the interactive path and the token-approved headless path. */
        const execApproved = async () => {
          pending.delete(token); // single use, consumed even if gh then fails
          const r = await gh(plan.args, { cwd, signal, stdin: plan.bodyStdin, timeout: 120_000 });
          if (r.code !== 0) {
            const c = classify(r, params.action);
            return fin(`${plan.successNote ?? "Write"} FAILED — nothing may have changed.\n\n${c.message}`, c.status);
          }
          return fin(
            [
              `${plan.successNote}: ${(r.stdout + r.stderr).trim() || "(gh reported no output)"}`,
              "",
              `Executed: gh ${plan.args.join(" ")}${plan.bodyStdin ? ` (body: ${plan.bodyStdin.length} chars via stdin)` : ""}`,
            ].join("\n"),
          );
        };

        /* Interactive session: the dialog IS the approval. One decision, on the first call —
           previewing in prose and then popping a dialog made the user approve twice. */
        if (ctx.hasUI) {
          const ok = await uiExclusive(() =>
            ctx.ui.confirm(
              `gh ${params.action}${plan.payload.repo ? ` on ${plan.payload.repo}` : ""}`,
              [plan.warning ?? "", "", ...plan.previewLines].join("\n").slice(0, 4000),
            ),
          );
          if (!ok)
            return fin(
              `User declined the gh ${params.action}. Nothing was sent to GitHub. Ask what to change instead of retrying.`,
              "declined",
            );
          return await execApproved();
        }

        /* Preview step: no confirm_token, or one that does not match THIS payload. */
        if (params.confirm_token !== token) {
          pending.set(token, { action: params.action, createdAt: Date.now(), payload: JSON.stringify(plan.payload) });
          const mismatch =
            params.confirm_token && params.confirm_token !== token
              ? `The confirm_token you passed (${params.confirm_token}) does not match this payload — it was never issued for exactly this payload (or the payload changed since it was approved), so it is void. Re-show the payload below and get fresh approval.\n\n`
              : "";
          return fin(
            [
              `${mismatch}NOTHING HAS BEEN SENT TO GITHUB YET. This is a preview of \`gh ${plan.args.join(" ")}\`.`,
              "",
              `!! ${plan.warning ?? "This is a write operation."}`,
              "",
              `--- resolved ${params.action} payload ---`,
              ...plan.previewLines,
              "--- end payload ---",
              "",
              `Show this payload to the user (body included) and ask for explicit approval.`,
              `If they approve, call gh again with the IDENTICAL parameters plus confirm_token:"${token}".`,
              `Any change to the payload produces a different token; this one expires in ${APPROVAL_TTL_MS / 60000} minutes and works once.`,
            ].join("\n"),
            "preview_pending_approval",
            { confirmToken: token, ghArgs: plan.args, bodyChars: plan.bodyStdin?.length ?? 0 },
          );
        }

        /* Approved-by-token step. */
        const rec = pending.get(token);
        if (!rec)
          return fin(
            `Approval token ${token} is unknown or expired (tokens live ${APPROVAL_TTL_MS / 60000} minutes and are single-use). Nothing was sent. Call gh again without confirm_token to regenerate the preview, and have the user approve it again.`,
            "refused_unapproved",
          );

        if (process.env.PI_GH_ALLOW_UNATTENDED_WRITES !== "1") {
          // No interactive UI (print/JSON mode) => no human could have seen the preview in-session.
          return fin(
            [
              `Refusing to execute gh ${params.action}: this session has no interactive UI (mode=${ctx.mode}), so no human could confirm the payload.`,
              "Nothing was sent to GitHub, and nothing you can do from bash will change that — do not try another route.",
              "Tell the user this needs an interactive pi session (the gh extension README documents an opt-in for unattended writes, which only they can enable).",
            ].join("\n"),
            "refused_unapproved",
            { confirmToken: token },
          );
        }

        return await execApproved();
      } catch (e: any) {
        if (e?.name === "AbortError") return fin("Cancelled.", "error");
        return fin(`gh tool failed: ${e?.message ?? String(e)}`, "error");
      }
    },
    renderCall(args: GhToolInput, theme) {
      const bits = [
        args.repo,
        args.number !== undefined ? `#${args.number}` : undefined,
        args.workflow,
        args.job !== undefined ? `job ${args.job}` : undefined,
        args.failed_only ? "failed-only" : undefined,
        args.query && `"${args.query}"`,
        args.base && args.head ? `${args.base}<-${args.head}` : args.base,
        args.title && `"${args.title.slice(0, 60)}"`,
        args.confirm_token ? "APPROVED" : writeSet.has(args.action) ? "preview" : undefined,
      ].filter(Boolean);
      return new Text(
        `${theme.fg("accent", "gh")} ${theme.bold(args.action)}${bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const first = result.content[0];
      const text = (first && "text" in first ? first.text : "") ?? "";
      const st = /gh_status: (\w+)$/.exec(text.trim())?.[1] ?? "";
      const color = st === "ok" ? "success" : st === "preview_pending_approval" ? "warning" : st ? "error" : "text";
      if (expanded) return new Text(theme.fg(color, text), 0, 0);
      const lines = text.split("\n");
      const shown = lines.length > 20 ? `${lines.slice(0, 20).join("\n")}\n... and ${lines.length - 20} more lines` : text;
      return new Text(theme.fg(color, shown), 0, 0);
    },
  });
}
