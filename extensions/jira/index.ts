/**
 * Jira extension for pi.
 *
 * Configuration comes ONLY from environment variables (never hardcoded):
 *   JIRA_USERNAME   your Atlassian account email        (required)
 *   JIRA_API_TOKEN  Atlassian API token                 (required)
 *   JIRA_URL        instance base URL                   (optional, default https://acme.atlassian.net)
 *
 * Put them in your shell profile (~/.zshrc, ~/.bashrc, ~/.zprofile):
 *   export JIRA_USERNAME="you@example.com"
 *   export JIRA_API_TOKEN="atlassian-api-token"
 *   export JIRA_URL="https://yourcompany.atlassian.net"
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "https://acme.atlassian.net";
const PROFILES = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc", ".profile"];

type Creds = {
  url: string;
  username: string;
  token: string;
  /** Provenance of the credentials — "env" is trustworthy, "shell-profile" is a fallback. */
  source: "env" | "shell-profile";
};

let credsCache: Creds | null = null;
let credsPromise: Promise<Creds | { error: string; source: "none" }> | null = null;

function fromEnv(): Creds | null {
  const username = process.env.JIRA_USERNAME?.trim();
  const token = process.env.JIRA_API_TOKEN?.trim();
  if (!username || !token) return null;
  return {
    url: (process.env.JIRA_URL?.trim() || DEFAULT_URL).replace(/\/+$/, ""),
    username,
    token,
    source: "env",
  };
}

/** Fallback: pi may have been launched without the profile sourced (GUI launch, cron, CI). */
function fromLoginShell(): Promise<Creds | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const hasProfile = PROFILES.some((p) => existsSync(join(homedir(), p)));
    if (!hasProfile) return resolve(null);
    execFile(
      shell,
      ["-l", "-i", "-c", 'printf "%s\\n%s\\n%s\\n" "$JIRA_USERNAME" "$JIRA_API_TOKEN" "$JIRA_URL"'],
      { timeout: 10_000, env: { ...process.env, PI_JIRA_PROBE: "1" } },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        const [username = "", token = "", url = ""] = stdout.split("\n").map((s) => s.trim());
        if (!username || !token) return resolve(null);
        resolve({ url: (url || DEFAULT_URL).replace(/\/+$/, ""), username, token, source: "shell-profile" });
      },
    );
  });
}

const SETUP_HELP = `Jira credentials are not configured.

Add these to your shell profile (~/.zshrc, ~/.bashrc or ~/.zprofile), then restart pi:

  export JIRA_USERNAME="your-email@example.com"
  export JIRA_API_TOKEN="your-atlassian-api-token"
  export JIRA_URL="https://yourcompany.atlassian.net"   # optional, default ${DEFAULT_URL}

Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
(Atlassian API tokens commonly expire after 90 days — regenerate and re-export if you get 401.)`;

async function getCreds(): Promise<Creds | { error: string; source: "none" }> {
  if (credsCache) return credsCache;
  if (!credsPromise) {
    credsPromise = (async () => {
      const direct = fromEnv();
      if (direct) {
        credsCache = direct;
        return direct;
      }
      const shellCreds = await fromLoginShell();
      if (shellCreds) {
        credsCache = shellCreds;
        return shellCreds;
      }
      credsPromise = null; // allow retry after the user fixes their profile
      return { error: SETUP_HELP, source: "none" as const };
    })();
  }
  return credsPromise;
}

type ApiResult = { ok: boolean; status: number; json: any; text: string };

async function request(
  creds: Creds,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResult> {
  const auth = Buffer.from(`${creds.username}:${creds.token}`).toString("base64");
  const res = await fetch(`${creds.url}/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (HTML error page etc.) */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** Platform REST API (/rest/api/2|3). */
function api(
  creds: Creds,
  version: 2 | 3,
  endpoint: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResult> {
  return request(creds, `rest/api/${version}/${endpoint}`, method, body, signal);
}

/** Agile/Software API (/rest/agile/1.0) — boards, backlogs, sprints. Not part of the platform API. */
function agile(
  creds: Creds,
  endpoint: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResult> {
  return request(creds, `rest/agile/1.0/${endpoint}`, method, body, signal);
}

function errText(r: ApiResult): string {
  const j = r.json;
  const parts: string[] = [`HTTP ${r.status}`];
  if (j?.errorMessages?.length) parts.push(...j.errorMessages);
  if (j?.errors) for (const [k, v] of Object.entries(j.errors)) parts.push(`${k}: ${v}`);
  if (parts.length === 1) {
    // Non-JSON body (CDN/proxy HTML error page): strip markup and keep it short.
    const plain = (r.text || "(empty response)").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    parts.push(plain.slice(0, 300) || "(empty response)");
  }
  if (r.status === 401 || (r.status === 403 && j))
    parts.push("Auth failed — JIRA_API_TOKEN may be expired/invalid, or JIRA_USERNAME is wrong.");
  return `Jira API error: ${parts.join(" | ")}`;
}

const day = (s?: string) => (s ? s.split("T")[0] : "?");

/**
 * Flatten Atlassian Document Format to plain text.
 * The v3 search endpoint returns `description` as ADF; v2 returns a plain string.
 */
export function adfToText(node: any, depth = 0): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((n) => adfToText(n, depth)).join("");
  if (node.type === "text") return String(node.text ?? "");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.text ?? node.attrs?.id ?? ""}`;
  if (node.type === "inlineCard") return String(node.attrs?.url ?? "");
  const inner = adfToText(node.content, depth + 1);
  const block = ["paragraph", "heading", "listItem", "blockquote", "codeBlock", "tableRow"].includes(node.type);
  return block ? `${inner}\n` : inner;
}

const descText = (d: any): string =>
  typeof d === "string" ? d : d ? adfToText(d).replace(/\n{3,}/g, "\n\n").trim() : "";

/** Search via v3 POST search/jql (v2 POST /search is deprecated). */
async function searchJql(
  creds: Creds,
  jql: string,
  maxResults: number,
  fields: string[],
  signal?: AbortSignal,
): Promise<ApiResult> {
  return api(creds, 3, "search/jql", "POST", { jql, maxResults, fields }, signal);
}

/**
 * Paginated search. `search/jql` returns at most ~100 issues per page plus a `nextPageToken`
 * (and no reliable `total`), so a single call silently truncates a backlog scan.
 * Returns every issue up to `cap`, plus whether more remain.
 */
async function searchAll(
  creds: Creds,
  jql: string,
  cap: number,
  fields: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; err?: ApiResult; issues: any[]; truncated: boolean; pages: number }> {
  const issues: any[] = [];
  let nextPageToken: string | undefined;
  let pages = 0;
  while (issues.length < cap && pages < 60) {
    const body: Record<string, unknown> = {
      jql,
      maxResults: Math.min(100, cap - issues.length),
      fields,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const r = await api(creds, 3, "search/jql", "POST", body, signal);
    if (!r.ok) return { ok: false, err: r, issues, truncated: false, pages };
    pages++;
    issues.push(...(r.json?.issues ?? []));
    nextPageToken = r.json?.nextPageToken;
    if (!nextPageToken || !(r.json?.issues ?? []).length) return { ok: true, issues, truncated: false, pages };
  }
  return { ok: true, issues, truncated: true, pages };
}

function issueLine(i: any): string {
  const f = i.fields ?? {};
  return [
    `[${i.key}] ${f.summary ?? ""}`,
    `  Status:   ${f.status?.name ?? "?"}`,
    f.assignee !== undefined ? `  Assignee: ${f.assignee?.displayName ?? "Unassigned"}` : null,
    f.priority !== undefined ? `  Priority: ${f.priority?.name ?? "None"}` : null,
    f.updated ? `  Updated:  ${day(f.updated)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function counts(issues: any[], pick: (f: any) => string): string {
  const m = new Map<string, number>();
  for (const i of issues) {
    const k = pick(i.fields ?? {});
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

/**
 * Jira issueLink direction semantics, verified empirically against a live instance
 * (created a Blocks link, then queried `issue in linkedIssues(KEY, "blocks")`):
 *
 *   POST {type, inwardIssue: I, outwardIssue: O}
 *     => I <type.outward> O      (e.g. inward issue "blocks" the outward issue)
 *     => O <type.inward>  I      (e.g. outward issue "is blocked by" the inward issue)
 *
 * So the issue that should read with the type's OUTWARD phrase must be sent as
 * `inwardIssue`. `sourceIsInward: true` means the shortcut phrase equals type.outward.
 * (The legacy jira_cli.sh shell script had this inverted and produced reversed links.)
 */
const LINK_SHORTCUTS: Record<string, { type: string; sourceIsInward: boolean }> = {
  "child-of": { type: "Child-Issue", sourceIsInward: false }, // source = "is child task of" (inward phrase)
  "parent-of": { type: "Child-Issue", sourceIsInward: true }, // source = "is parent task of" (outward phrase)
  blocks: { type: "Blocks", sourceIsInward: true },
  "is-blocked-by": { type: "Blocks", sourceIsInward: false },
  "relates-to": { type: "Relates", sourceIsInward: true }, // symmetric
  duplicates: { type: "Duplicate", sourceIsInward: true },
  clones: { type: "Cloners", sourceIsInward: true },
};

/* ------------------------------------------------------------------ *
 *  Duplicate detection (local, deterministic — no API calls, no LLM)  *
 * ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those there here is are was were be been being am" +
    " do does did doing have has had having will would shall should can could may might must" +
    " i we you he she it they them us our your their my me his her its" +
    " of in on at to for from by with without into onto over under about as via per" +
    " not no yes so such own same other another each any all both more most some" +
    " issue issues ticket tickets story stories task tasks bug bugs epic epics chore spike" +
    " jira please need needs needed want wants should when while during after before").split(/\s+/),
);

/** Cheap suffix stemmer — enough to make "banners"/"banner" and "loading"/"load" collide. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && (w.endsWith("ing") || w.endsWith("ers"))) return w.slice(0, -3);
  if (w.length > 3 && (w.endsWith("es") || w.endsWith("ed"))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function normalizeText(s: string): string {
  return s
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ") // issue keys carry no semantic signal
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    // Keep version/decimal numbers as one token so "gradle 8.7" and "gradle 8.9" stay distinct.
    .replace(/(\d)[.,](\d)/g, "$1p$2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSet(s: string, maxTokens = 200): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeText(s).split(" ")) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
    if (out.size >= maxTokens) break;
  }
  return out;
}

function trigrams(s: string): Set<string> {
  const t = ` ${normalizeText(s)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

type DupDoc = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  type: string;
  assignee: string;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  linkCount: number;
  dupLinks: Set<string>;
  toks: Set<string>;
  tris: Set<string>;
  descToks: Set<string>;
};

export function toDoc(i: any): DupDoc {
  const f = i.fields ?? {};
  const summary = String(f.summary ?? "");
  const desc = descText(f.description).slice(0, 4000);
  const dupLinks = new Set<string>();
  for (const l of f.issuelinks ?? []) {
    const other = l.outwardIssue ?? l.inwardIssue;
    if (other?.key && /duplicate/i.test(String(l.type?.name ?? ""))) dupLinks.add(other.key);
  }
  return {
    key: i.key,
    summary,
    status: f.status?.name ?? "?",
    statusCategory: f.status?.statusCategory?.name ?? "?",
    type: f.issuetype?.name ?? "?",
    assignee: f.assignee?.displayName ?? "Unassigned",
    reporter: f.reporter?.displayName ?? "?",
    created: day(f.created),
    updated: day(f.updated),
    labels: Array.isArray(f.labels) ? f.labels : [],
    linkCount: (f.issuelinks ?? []).length,
    dupLinks,
    toks: tokenSet(summary),
    tris: trigrams(summary),
    descToks: tokenSet(desc, 300),
  };
}

type Pair = { a: number; b: number; score: number; sum: number; desc: number };

/**
 * Score = summary similarity (token Jaccard + character trigram Dice, so typos and word
 * order still match), nudged by description overlap when both issues have one.
 */
function pairScore(x: DupDoc, y: DupDoc): Pair | null {
  const jac = jaccard(x.toks, y.toks);
  const tri = dice(x.tris, y.tris);
  const sum = 0.65 * jac + 0.35 * tri;
  const bothDesc = x.descToks.size >= 3 && y.descToks.size >= 3;
  const desc = bothDesc ? jaccard(x.descToks, y.descToks) : 0;
  const score = bothDesc ? 0.85 * sum + 0.15 * desc : sum;
  return { a: -1, b: -1, score, sum, desc };
}

/** Union-find clustering over all pairs at or above the threshold. */
export function findDuplicateClusters(docs: DupDoc[], threshold: number) {
  const n = docs.length;
  // Inverted index prefilter: only compare issues that share a reasonably rare token.
  const postings = new Map<string, number[]>();
  for (let i = 0; i < n; i++)
    for (const t of docs[i].toks) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(i);
    }
  const commonCap = Math.max(8, Math.floor(n * 0.35));
  const pairs: Pair[] = [];
  let compared = 0;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    seen.clear();
    for (const t of docs[i].toks) {
      const p = postings.get(t)!;
      if (p.length > commonCap) continue; // stopword-like token in this dataset
      for (const j of p) {
        if (j <= i || seen.has(j)) continue;
        seen.add(j);
        compared++;
        const s = pairScore(docs[i], docs[j])!;
        if (s.score >= threshold) pairs.push({ ...s, a: i, b: j });
      }
    }
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const p of pairs) parent[find(p.a)] = find(p.b);

  const groups = new Map<number, number[]>();
  for (const p of pairs)
    for (const idx of [p.a, p.b]) {
      const root = find(idx);
      const g = groups.get(root) ?? [];
      if (!g.includes(idx)) g.push(idx);
      groups.set(root, g);
    }

  const bestPair = new Map<string, Pair>();
  for (const p of pairs) {
    const k = `${find(p.a)}`;
    const cur = bestPair.get(k);
    if (!cur || p.score > cur.score) bestPair.set(k, p);
  }

  const CATEGORY_RANK: Record<string, number> = { Done: 3, "In Progress": 2, "To Do": 1 };
  const clusters = [...groups.entries()].map(([root, idxs]) => {
    const members = idxs.map((i) => docs[i]);
    // Canonical = most progressed, then most linked/discussed, then oldest.
    const canonical = [...members].sort(
      (a, b) =>
        (CATEGORY_RANK[b.statusCategory] ?? 0) - (CATEGORY_RANK[a.statusCategory] ?? 0) ||
        b.linkCount - a.linkCount ||
        a.created.localeCompare(b.created),
    )[0];
    const linked = members.every((m) =>
      members.filter((o) => o.key !== m.key).every((o) => m.dupLinks.has(o.key) || o.dupLinks.has(m.key)),
    );
    // Template series ("... for the Redeem screen" / "... for the Save screen") look almost
    // identical lexically but are distinct work. Detect them: every member carries at least one
    // token no sibling has. Reported so a reviewer isn't tempted to close a whole series.
    const shared = new Set(
      [...members[0].toks].filter((t) => members.every((m) => m.toks.has(t))),
    );
    const distinct = members.map((m) => ({
      key: m.key,
      only: [...m.toks].filter((t) => !shared.has(t) && members.every((o) => o.key === m.key || !o.toks.has(t))),
    }));
    const siblingSeries = members.length >= 2 && distinct.every((d) => d.only.length > 0);
    return {
      members,
      canonical,
      maxScore: bestPair.get(`${root}`)?.score ?? 0,
      alreadyLinked: linked,
      siblingSeries,
      distinct,
    };
  });
  clusters.sort((a, b) => b.maxScore - a.maxScore || b.members.length - a.members.length);
  return { clusters, pairCount: pairs.length, compared };
}

const actionEnum = [
  "show",
  "boards",
  "backlog",
  "find_duplicates",
  "transitions",
  "transition",
  "comment",
  "delete",
  "list",
  "search",
  "projects",
  "me",
  "stats",
  "sprint_stats",
  "link_types",
  "createmeta",
  "create",
  "update",
  "link",
  "test_token",
] as const;

const schema = Type.Object({
  action: Type.Union(
    actionEnum.map((a) => Type.Literal(a)),
    {
      description:
        "show=one issue; boards; backlog=board backlog (ranked); find_duplicates=cluster near-identical issues; list=my issues; search=JQL; projects; me; stats; sprint_stats; link_types; transitions=available workflow moves; createmeta=creatable fields; create; update; transition=change status; comment; link; delete; test_token",
    },
  ),
  issue_key: Type.Optional(Type.String({ description: "Issue key, e.g. PROJ-123. For show/update/link (source)/transition/comment/delete." })),
  issue_keys: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Bulk targets for transition/comment/delete/link (each key is processed in turn, errors reported per key, one approval covers the batch). For link, every key is a source pointing at target_key \u2014 e.g. mark 5 duplicates as duplicating the canonical issue.",
    }),
  ),
  jql: Type.Optional(Type.String({ description: "JQL for action=search, e.g. 'project = ADA AND status = \"In Progress\"'" })),
  limit: Type.Optional(Type.Number({ description: "Max results for list/search (default 10)" })),
  days: Type.Optional(Type.Number({ description: "Lookback window for action=stats (default 30)" })),
  project: Type.Optional(
    Type.String({
      description:
        "Project key for action=createmeta (e.g. ADA). For action=projects, an optional case-insensitive key/name filter.",
    }),
  ),
  issue_type: Type.Optional(Type.String({ description: "Issue type name for createmeta, e.g. Story. Omit to list available types." })),
  fields: Type.Optional(
    Type.Unknown({
      description:
        'Field object for create/update. create: {"project":{"key":"ADA"},"issuetype":{"name":"Story"},"summary":"..."}. update: {"summary":"New title"}. A {"fields":{...}} wrapper is accepted too.',
    }),
  ),
  link_type: Type.Optional(
    Type.String({
      description:
        "For action=link: child-of | parent-of | blocks | is-blocked-by | relates-to | duplicates | clones, or a raw Jira link type name.",
    }),
  ),
  target_key: Type.Optional(Type.String({ description: "For action=link: the other issue key." })),
  body: Type.Optional(
    Type.String({ description: "Comment text for action=comment, or a comment to post alongside action=transition." }),
  ),
  transition: Type.Optional(
    Type.String({ description: "For action=transition: target transition or status name (case-insensitive), or its numeric id. Use action=transitions to list what the issue currently allows." }),
  ),
  resolution: Type.Optional(
    Type.String({ description: "For action=transition: resolution name to set, e.g. 'Duplicate' (only if the transition screen accepts it)." }),
  ),
  board_id: Type.Optional(Type.Number({ description: "Board id for action=backlog (see action=boards). Omit to auto-pick the first board of `project`." })),
  threshold: Type.Optional(
    Type.Number({ description: "For action=find_duplicates: similarity cutoff 0..1 (default 0.55). Lower = more candidates and more noise; 0.75+ = near-identical only." }),
  ),
  confirm_delete: Type.Optional(
    Type.Boolean({ description: "Required true for action=delete. Set it only when the user explicitly asked to DELETE (not close) those issues." }),
  ),
});

export type JiraToolInput = Static<typeof schema>;

function unwrapFields(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  let obj: any = input;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.fields && typeof obj.fields === "object") return obj.fields;
  return obj;
}

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
  pi.registerTool({
    name: "jira",
    label: "Jira",
    // Raises an approval dialog: must never run concurrently with another tool call.
    executionMode: "sequential",
    description: `Query and modify Jira issues over the REST API (credentials from JIRA_USERNAME / JIRA_API_TOKEN / JIRA_URL env vars).

Read actions: show (one issue with description), list (issues assigned to you), search (JQL, auto-paginated), boards, backlog (ranked board backlog), find_duplicates (local similarity clustering over a backlog/JQL scope), projects, me, stats, sprint_stats, link_types, transitions, createmeta, test_token.
Write actions: create, update, transition (change status), comment, link, delete. These mutate real shared Jira state — only call them after the user has seen the exact payload and explicitly approved it. In interactive sessions jira also asks the user to confirm each write. delete is IRREVERSIBLE and additionally requires confirm_delete:true.

Backlog cleanup / de-duplication flow:
  1. {"action":"find_duplicates","project":"ADA"} (or jql/board_id) — returns clusters with scores, a suggested canonical issue, and which pairs are already linked as duplicates.
  2. Show the clusters to the user and let THEM decide what is a real duplicate.
  3. For each confirmed duplicate: {"action":"link","issue_keys":["PROJ-2","PROJ-3"],"link_type":"duplicates","target_key":"PROJ-1"} then {"action":"transition","issue_keys":["PROJ-2","PROJ-3"],"transition":"Done","resolution":"Duplicate","body":"Closing as duplicate of PROJ-1"}.
  4. Prefer closing over deleting; only use delete when the user explicitly asks to destroy the issue.

Prefer jira over running curl/jira_cli.sh in bash for anything Jira — it needs no shell profile sourcing and returns compact pre-formatted text.
Examples:
  {"action":"show","issue_key":"PROJ-123"}
  {"action":"search","jql":"project = ADA AND status = \\"In Progress\\"","limit":20}
  {"action":"createmeta","project":"ADA","issue_type":"Story"}
  {"action":"create","fields":{"project":{"key":"ADA"},"issuetype":{"name":"Story"},"summary":"My ticket"}}
  {"action":"update","issue_key":"PROJ-123","fields":{"summary":"New title"}}
  {"action":"link","issue_key":"PROJ-123","link_type":"blocks","target_key":"PROJ-124"}
  {"action":"backlog","project":"ADA","limit":200}
  {"action":"find_duplicates","jql":"project = ADA AND statusCategory != Done","threshold":0.6}
  {"action":"transitions","issue_key":"PROJ-123"}
  {"action":"transition","issue_key":"PROJ-123","transition":"Done","resolution":"Duplicate","body":"Duplicate of PROJ-100"}
  {"action":"comment","issue_key":"PROJ-123","body":"Superseded by PROJ-100"}

Every result ends with a "config_source:" marker: "env" means credentials came from the process environment (normal); "shell-profile" means they were recovered by probing a login shell, which is slower and means the user's env was not inherited — mention it if they hit auth problems.`,
    promptSnippet: "Read/search/create/update/link Jira issues via the Jira REST API",
    promptGuidelines: [
      "jira actions create, update, transition, comment, link and delete mutate real shared Jira state: never call them until the user has seen the exact payload/relationship in a message and explicitly approved it. Present a preview and stop instead of calling; after a change request, show the revised preview again rather than writing.",
      "Use jira for ALL Jira access (reading, searching, creating, updating, linking issues) instead of bash+curl or any jira_cli.sh script; it reads credentials from JIRA_USERNAME/JIRA_API_TOKEN env vars itself and needs no shell profile sourcing.",
      "When the user mentions an issue key like PROJ-123 or TEAM-205 and wants information about it, call jira with {action:'show', issue_key:'PROJ-123'} before answering rather than guessing.",
      "Before jira action='create' on an unfamiliar project, call jira action='createmeta' with the project (and issue_type) to learn required/custom field ids instead of guessing field names.",
      "If jira returns an auth error (HTTP 401/403), tell the user to regenerate their Atlassian API token and re-export JIRA_API_TOKEN in their shell profile — do not retry blindly.",
      "For backlog de-duplication use jira action='find_duplicates' (project/jql/board_id + optional threshold) instead of pulling hundreds of issues into context and eyeballing them: it scores every pair locally and returns clusters, a suggested canonical issue and pairs already linked as duplicates. Its clusters are CANDIDATES — present them to the user for a decision, never auto-close them.",
      "Closing a duplicate is a transition, not an update: jira action='update' cannot change status. Use action='transitions' to see the allowed moves for that issue, then action='transition' with transition/resolution/body. Prefer closing as duplicate (link + transition) over action='delete', which is irreversible and needs confirm_delete:true plus an explicit user request to delete.",
      "For repetitive cleanup pass issue_keys:[...] to transition/comment/delete/link instead of one call per issue — the batch is approved once and each key's outcome is reported separately.",
      "If a jira result reports config_source: shell-profile, note that pi did not inherit the Jira env vars and the user should restart pi from a shell where their profile is loaded.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const WRITE_ACTIONS = new Set(["create", "update", "link", "transition", "comment", "delete"]);
      const targets = (params.issue_keys?.length ? params.issue_keys : params.issue_key ? [params.issue_key] : []).map(
        (k) => k.trim().toUpperCase(),
      );
      if (WRITE_ACTIONS.has(params.action) && ctx.hasUI) {
        const who = targets.length ? targets.join(", ") : "new issue";
        const summary =
          params.action === "link"
            ? `${who} ${params.link_type} ${params.target_key}`
            : params.action === "transition"
              ? `${who} \u2192 ${params.transition}${params.resolution ? ` (resolution: ${params.resolution})` : ""}${
                  params.body ? `\ncomment: ${params.body.slice(0, 300)}` : ""
                }`
              : params.action === "comment"
                ? `${who}\n${(params.body ?? "").slice(0, 600)}`
                : params.action === "delete"
                  ? `IRREVERSIBLE \u2014 permanently delete ${targets.length} issue(s): ${who}\nSub-tasks are deleted too. Closing as duplicate is usually the right move instead.`
                  : `${who}: ${JSON.stringify(unwrapFields(params.fields) ?? {}).slice(0, 800)}`;
        const approved = await uiExclusive(() => ctx.ui.confirm(`Jira ${params.action}`, summary));
        if (!approved)
          return {
            content: [
              {
                type: "text" as const,
                text: `User declined the jira ${params.action}. Nothing was written. Ask what to change instead of retrying.`,
              },
            ],
            details: { action: params.action, declined: true },
            isError: true,
          };
      }

      const creds = await getCreds();
      if ("error" in creds) {
        return {
          content: [{ type: "text", text: `${creds.error}\n\nconfig_source: none` }],
          details: { action: params.action, configSource: "none" },
          isError: true,
        };
      }

      const fin = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text: `${text}\n\nconfig_source: ${creds.source}` }],
        details: { action: params.action, configSource: creds.source, isError },
        isError,
      });
      const bad = (msg: string) => fin(`Error: ${msg}`, true);
      const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
      /** Scan actions (backlog / find_duplicates) legitimately need hundreds of issues. */
      const scanLimit = Math.max(1, Math.min(params.limit ?? 300, 2000));
      const SCAN_FIELDS = [
        "summary",
        "description",
        "status",
        "issuetype",
        "assignee",
        "reporter",
        "created",
        "updated",
        "labels",
        "priority",
        "issuelinks",
      ];

      /** Resolve a board for `board_id` or the first board of `project`. */
      const resolveBoard = async (): Promise<{ id: number; name: string; warn?: string } | { error: string }> => {
        if (params.board_id) return { id: params.board_id, name: `board ${params.board_id}` };
        if (!params.project) return { error: "pass board_id or project (see action=boards)." };
        const r = await agile(creds, `board?projectKeyOrId=${encodeURIComponent(params.project)}&maxResults=50`, "GET", undefined, signal);
        if (!r.ok) return { error: errText(r) };
        const boards = r.json?.values ?? [];
        if (!boards.length) return { error: `No board found for project ${params.project}.` };
        // projectKeyOrId matches every board whose FILTER can see the project, including boards
        // owned by other projects. Picking boards[0] blindly returns another team's backlog.
        const want = params.project.toUpperCase();
        const owned = boards.filter((b: any) => String(b.location?.projectKey ?? "").toUpperCase() === want);
        const chosen = owned[0] ?? boards[0];
        const name = `${chosen.name} (id ${chosen.id}${chosen.location?.projectKey ? `, ${chosen.location.projectKey}` : ""})`;
        return {
          id: chosen.id,
          name,
          warn: owned.length
            ? owned.length > 1
              ? `${owned.length} boards belong to ${want}; using the first. Pass board_id to choose another (see action=boards).`
              : undefined
            : `No board is owned by ${want}; falling back to "${chosen.name}", which lives in ${
                chosen.location?.projectKey ?? "another project"
              } and may contain other projects' issues. Pass board_id explicitly (see action=boards).`,
        };
      };

      /** Ranked backlog of a board, paginated (Agile API, not the platform API). */
      const fetchBacklog = async (boardId: number, cap: number) => {
        const issues: any[] = [];
        let startAt = 0;
        while (issues.length < cap) {
          const q = `board/${boardId}/backlog?startAt=${startAt}&maxResults=${Math.min(100, cap - issues.length)}&fields=${SCAN_FIELDS.join(",")}`;
          const r = await agile(creds, q, "GET", undefined, signal);
          if (!r.ok) return { ok: false as const, err: r, issues };
          const page = r.json?.issues ?? [];
          issues.push(...page);
          startAt += page.length;
          if (!page.length || r.json?.isLast || startAt >= (r.json?.total ?? 0)) break;
        }
        return { ok: true as const, issues };
      };

      /** Run one write per key, never abort the batch on a single failure. */
      const perKey = async (keys: string[], fn: (key: string) => Promise<string>) => {
        const lines: string[] = [];
        for (const k of keys) {
          try {
            lines.push(await fn(k));
          } catch (e: any) {
            if (e?.name === "AbortError") throw e;
            lines.push(`  \u2717 ${k}: ${e?.message ?? String(e)}`);
          }
        }
        const failed = lines.filter((l) => l.trimStart().startsWith("\u2717")).length;
        return { text: lines.join("\n"), failed, ok: lines.length - failed };
      };

      try {
        switch (params.action) {
          case "test_token": {
            const r = await api(creds, 2, "myself", "GET", undefined, signal);
            if (!r.ok || !r.json?.displayName) return fin(`Token invalid or expired.\n${errText(r)}`, true);
            return fin(`Token OK — authenticated as ${r.json.displayName} <${r.json.emailAddress ?? "?"}> at ${creds.url}`);
          }
          case "me": {
            const r = await api(creds, 2, "myself", "GET", undefined, signal);
            if (!r.ok) return fin(errText(r), true);
            const j = r.json;
            return fin(
              [
                "User Profile:",
                `  Name:    ${j.displayName}`,
                `  Email:   ${j.emailAddress ?? "(hidden)"}`,
                `  Account: ${j.accountId}`,
                `  Active:  ${j.active}`,
                `  Site:    ${creds.url}`,
              ].join("\n"),
            );
          }
          case "projects": {
            const r = await api(creds, 2, "project", "GET", undefined, signal);
            if (!r.ok) return fin(errText(r), true);
            const all = Array.isArray(r.json) ? r.json : [];
            const q = params.project?.trim().toLowerCase();
            const list = q
              ? all.filter(
                  (p: any) =>
                    String(p.key).toLowerCase().includes(q) || String(p.name).toLowerCase().includes(q),
                )
              : all;
            if (!list.length)
              return fin(
                q
                  ? `No project matches '${params.project}' (${all.length} projects visible).`
                  : "No projects visible to this account.",
              );
            // Large sites can expose hundreds of projects; cap output instead of flooding context.
            const cap = q ? 100 : 40;
            const shown = list.slice(0, cap);
            const head = `Projects (${shown.length} of ${list.length}${q ? ` matching '${params.project}'` : ""} shown${
              list.length > shown.length ? "; pass the `project` parameter as a name/key filter to narrow" : ""
            }):`;
            return fin(`${head}\n${shown.map((p: any) => `  [${p.key}] ${p.name}`).join("\n")}`);
          }
          case "show": {
            if (!params.issue_key) return bad("issue_key is required for action=show (e.g. PROJ-123).");
            const r = await api(creds, 2, `issue/${encodeURIComponent(params.issue_key)}`, "GET", undefined, signal);
            if (!r.ok) return fin(errText(r), true);
            const f = r.json?.fields ?? {};
            const links = (f.issuelinks ?? [])
              .map((l: any) => {
                const other = l.outwardIssue ?? l.inwardIssue;
                const dir = l.outwardIssue ? l.type?.outward : l.type?.inward;
                return other ? `  ${dir} ${other.key} (${other.fields?.summary ?? ""})` : null;
              })
              .filter(Boolean);
            return fin(
              [
                `Issue:    ${r.json.key}`,
                `URL:      ${creds.url}/browse/${r.json.key}`,
                `Summary:  ${f.summary ?? ""}`,
                `Type:     ${f.issuetype?.name ?? "Unknown"}`,
                `Status:   ${f.status?.name ?? "?"}`,
                `Priority: ${f.priority?.name ?? "None"}`,
                `Assignee: ${f.assignee?.displayName ?? "Unassigned"}`,
                `Reporter: ${f.reporter?.displayName ?? "?"}`,
                `Epic:     ${f.customfield_10014 ?? "None"}`,
                `Parent:   ${f.parent?.key ?? "None"}`,
                `Created:  ${day(f.created)}`,
                `Updated:  ${day(f.updated)}`,
                ...(links.length ? ["Links:", ...links] : []),
                "",
                "Description:",
                descText(f.description) || "No description",
              ].join("\n"),
            );
          }
          case "list": {
            const r = await searchJql(
              creds,
              "assignee = currentUser() ORDER BY updated DESC",
              limit,
              ["summary", "status", "priority", "updated"],
              signal,
            );
            if (!r.ok) return fin(errText(r), true);
            const issues = r.json?.issues ?? [];
            if (!issues.length) return fin("No issues assigned to you.");
            return fin(`Your assigned issues (${issues.length} shown):\n\n${issues.map(issueLine).join("\n\n")}`);
          }
          case "search": {
            if (!params.jql?.trim()) return bad("jql is required for action=search.");
            const r = await searchAll(
              creds,
              params.jql,
              Math.max(1, Math.min(params.limit ?? 10, 1000)),
              ["summary", "status", "assignee", "priority", "updated"],
              signal,
            );
            if (!r.ok) return fin(errText(r.err!), true);
            if (!r.issues.length) return fin(`No issues matched: ${params.jql}`);
            return fin(
              `Search: ${params.jql}\nResults (${r.issues.length} shown${
                r.truncated ? ", more available \u2014 raise `limit`" : ""
              }):\n\n${r.issues.map(issueLine).join("\n\n")}`,
            );
          }
          case "stats": {
            const days = Math.max(1, params.days ?? 30);
            const r = await searchJql(
              creds,
              `assignee = currentUser() AND updated >= -${days}d`,
              1000,
              ["status", "priority"],
              signal,
            );
            if (!r.ok) return fin(errText(r), true);
            const issues = r.json?.issues ?? [];
            if (!issues.length) return fin(`No issues updated in the last ${days} days.`);
            return fin(
              [
                `Statistics (last ${days} days)`,
                `Total issues: ${issues.length}`,
                "",
                "By status:",
                counts(issues, (f) => f.status?.name ?? "Unknown"),
                "",
                "By priority:",
                counts(issues, (f) => f.priority?.name ?? "None"),
              ].join("\n"),
            );
          }
          case "sprint_stats": {
            const r = await searchJql(
              creds,
              "assignee = currentUser() AND sprint in openSprints()",
              1000,
              ["status", "summary"],
              signal,
            );
            if (!r.ok) return fin(errText(r), true);
            const issues = r.json?.issues ?? [];
            if (!issues.length) return fin("No issues assigned to you in active sprints.");
            return fin(
              [
                "Current sprint statistics",
                `Total issues: ${issues.length}`,
                "",
                "By status:",
                counts(issues, (f) => f.status?.name ?? "Unknown"),
              ].join("\n"),
            );
          }
          case "boards": {
            const q = params.project ? `board?projectKeyOrId=${encodeURIComponent(params.project)}&maxResults=50` : "board?maxResults=50";
            const r = await agile(creds, q, "GET", undefined, signal);
            if (!r.ok) return fin(`${errText(r)}\n(Boards come from the Agile API \u2014 a Jira Work Management project has none.)`, true);
            const boards = r.json?.values ?? [];
            if (!boards.length) return fin(params.project ? `No boards for project ${params.project}.` : "No boards visible.");
            return fin(
              `Boards (${boards.length}${r.json?.isLast === false ? "+" : ""})${
                params.project
                  ? ` \u2014 boards whose filter includes ${params.project} issues; the trailing key is where the board LIVES, which can be another project`
                  : ""
              }:\n${boards
                .map((b: any) => `  ${b.id}  ${b.name} [${b.type}]${b.location?.projectKey ? ` \u2014 ${b.location.projectKey}` : ""}`)
                .join("\n")}`,
            );
          }
          case "backlog": {
            const board = await resolveBoard();
            if ("error" in board) {
              // Team-managed projects / restricted boards: fall back to a rank-ordered JQL scan.
              if (!params.project) return bad(board.error);
              const r = await searchAll(
                creds,
                `project = ${params.project} AND statusCategory != Done ORDER BY Rank ASC`,
                scanLimit,
                ["summary", "status", "assignee", "priority", "updated"],
                signal,
              );
              if (!r.ok) return fin(`${board.error}\nJQL fallback also failed: ${errText(r.err!)}`, true);
              return fin(
                `Backlog fallback for ${params.project} (no board: ${board.error})\nJQL: project = ${params.project} AND statusCategory != Done ORDER BY Rank ASC\n${r.issues.length} issues${
                  r.truncated ? " (truncated \u2014 raise `limit`)" : ""
                }:\n\n${r.issues.map(issueLine).join("\n\n")}`,
              );
            }
            const bl = await fetchBacklog(board.id, scanLimit);
            if (!bl.ok) return fin(errText(bl.err), true);
            if (!bl.issues.length) return fin(`Backlog of ${board.name} is empty.`);
            const foreign = params.project
              ? [...new Set(bl.issues.map((i: any) => String(i.key).split("-")[0]))].filter(
                  (p) => p !== params.project!.toUpperCase(),
                )
              : [];
            return fin(
              `${board.warn ? `\u26a0 ${board.warn}\n` : ""}${
                foreign.length ? `\u26a0 Backlog also contains issues from: ${foreign.join(", ")}\n` : ""
              }Backlog of ${board.name} \u2014 ${bl.issues.length} issues in rank order:\n\n${bl.issues
                .map((i: any, n: number) => `${String(n + 1).padStart(3)}. ${issueLine(i).replace(/\n/g, "\n     ")}`)
                .join("\n")}`,
            );
          }
          case "find_duplicates": {
            const threshold = Math.max(0.2, Math.min(params.threshold ?? 0.55, 0.99));
            let issues: any[] = [];
            let scope: string;
            let truncated = false;
            if (params.board_id) {
              const bl = await fetchBacklog(params.board_id, scanLimit);
              if (!bl.ok) return fin(errText(bl.err), true);
              issues = bl.issues;
              scope = `backlog of board ${params.board_id}`;
            } else {
              const jql =
                params.jql?.trim() ||
                (params.project
                  ? `project = ${params.project} AND statusCategory != Done ORDER BY created ASC`
                  : "");
              if (!jql) return bad("action=find_duplicates needs project, jql or board_id.");
              const r = await searchAll(creds, jql, scanLimit, SCAN_FIELDS, signal);
              if (!r.ok) return fin(errText(r.err!), true);
              issues = r.issues;
              truncated = r.truncated;
              scope = jql;
            }
            if (issues.length < 2) return fin(`Only ${issues.length} issue(s) in scope (${scope}) \u2014 nothing to compare.`);

            const docs = issues.map(toDoc);
            const { clusters, pairCount, compared } = findDuplicateClusters(docs, threshold);
            const head = [
              `Duplicate scan \u2014 scope: ${scope}`,
              `Scanned ${docs.length} issues${truncated ? " (TRUNCATED \u2014 raise `limit` to cover the whole backlog)" : ""}, ${compared} pairs compared, threshold ${threshold}`,
              `Found ${clusters.length} candidate cluster(s) from ${pairCount} matching pair(s).`,
              "",
              "Scores are lexical similarity of summary (+description), NOT a verdict \u2014 review each cluster before acting.",
            ];
            if (!clusters.length)
              return fin([...head, `No pairs at or above ${threshold}. Retry with a lower threshold (e.g. ${(threshold - 0.1).toFixed(2)}).`].join("\n"));

            const CAP = 40;
            const shown = clusters.slice(0, CAP);
            const blocks = shown.map((c, n) => {
              const rows = c.members
                .slice()
                .sort((a, b) => a.created.localeCompare(b.created))
                .map((m) => {
                  const mark = m.key === c.canonical.key ? "*" : " ";
                  const dup = m.dupLinks.size ? ` [dup-linked: ${[...m.dupLinks].join(",")}]` : "";
                  return `   ${mark} ${m.key}  ${m.type}/${m.status}  created ${m.created}  ${m.assignee}${dup}\n       "${m.summary}"`;
                });
              return [
                `Cluster ${n + 1} \u2014 ${c.members.length} issues, max score ${c.maxScore.toFixed(2)}${
                  c.alreadyLinked ? "  [already linked as duplicates \u2014 likely nothing to do]" : ""
                }`,
                ...rows,
                c.siblingSeries
                  ? `   \u26a0 every issue has a unique term (${c.distinct
                      .map((d) => `${d.key}: ${d.only.slice(0, 3).join("/")}`)
                      .join("; ")}) \u2014 this looks like a TEMPLATE SERIES (same wording, different target), not duplicates. Verify before closing.`
                  : `   no distinguishing terms between these issues \u2014 strong duplicate signal`,
                `   suggested canonical: ${c.canonical.key} (most progressed / most linked / oldest)`,
                `   cleanup: {"action":"link","issue_keys":[${c.members
                  .filter((m) => m.key !== c.canonical.key)
                  .map((m) => `"${m.key}"`)
                  .join(",")}],"link_type":"duplicates","target_key":"${c.canonical.key}"}`,
              ].join("\n");
            });
            return fin(
              `${head.join("\n")}\n\n${blocks.join("\n\n")}${
                clusters.length > CAP ? `\n\n(+${clusters.length - CAP} more clusters not shown \u2014 raise the threshold to narrow.)` : ""
              }`,
            );
          }
          case "transitions": {
            if (!params.issue_key) return bad("issue_key is required for action=transitions.");
            const r = await api(creds, 2, `issue/${encodeURIComponent(params.issue_key)}/transitions`, "GET", undefined, signal);
            if (!r.ok) return fin(errText(r), true);
            const ts = r.json?.transitions ?? [];
            if (!ts.length) return fin(`${params.issue_key} has no available transitions for this account.`);
            return fin(
              `Transitions available for ${params.issue_key}:\n${ts
                .map((t: any) => `  ${t.id}  "${t.name}" \u2192 ${t.to?.name ?? "?"} [${t.to?.statusCategory?.name ?? "?"}]`)
                .join("\n")}`,
            );
          }
          case "link_types": {
            const r = await api(creds, 2, "issueLinkType", "GET", undefined, signal);
            if (!r.ok) return fin(errText(r), true);
            const types = r.json?.issueLinkTypes ?? [];
            return fin(
              `Available link types:\n${types
                .map((t: any) => `  ${t.name}\n    inward:  ${t.inward}\n    outward: ${t.outward}`)
                .join("\n")}`,
            );
          }
          case "createmeta": {
            if (!params.project) return bad("project is required for action=createmeta (e.g. ADA).");
            const pk = encodeURIComponent(params.project);
            const tr = await api(creds, 3, `issue/createmeta/${pk}/issuetypes`, "GET", undefined, signal);
            if (!tr.ok) return fin(errText(tr), true);
            const types = tr.json?.issueTypes ?? [];
            if (!params.issue_type)
              return fin(
                `Issue types for ${params.project}:\n${types.map((t: any) => `  ${t.id}  ${t.name}`).join("\n")}\n\nCall again with issue_type to see fields.`,
              );
            const match = types.find(
              (t: any) => String(t.name).toLowerCase() === params.issue_type!.toLowerCase(),
            );
            if (!match)
              return bad(
                `Issue type '${params.issue_type}' not found in ${params.project}. Available: ${types
                  .map((t: any) => t.name)
                  .join(", ")}`,
              );
            const fr = await api(creds, 3, `issue/createmeta/${pk}/issuetypes/${match.id}`, "GET", undefined, signal);
            if (!fr.ok) return fin(errText(fr), true);
            const flds = fr.json?.fields ?? [];
            const lines = flds.map((f: any) => {
              const vals = (f.allowedValues ?? [])
                .slice(0, 6)
                .map((v: any) => `${v.id}: ${v.value ?? v.name ?? "?"}`)
                .join(", ");
              return `${f.required ? "* " : "  "}${f.fieldId}  [${f.name}]${vals ? `\n    Values: ${vals}` : ""}`;
            });
            return fin(`Fields for ${params.project} / ${match.name} (* = required):\n${lines.join("\n")}`);
          }
          case "create": {
            const fields = unwrapFields(params.fields);
            if (!fields) return bad('fields is required for action=create, e.g. {"project":{"key":"ADA"},"issuetype":{"name":"Story"},"summary":"..."}');
            const r = await api(creds, 2, "issue", "POST", { fields }, signal);
            if (!r.ok || !r.json?.key) return fin(`Failed to create issue.\n${errText(r)}`, true);
            return fin(`Created ${r.json.key}\nURL: ${creds.url}/browse/${r.json.key}`);
          }
          case "update": {
            if (!params.issue_key) return bad("issue_key is required for action=update.");
            const fields = unwrapFields(params.fields);
            if (!fields || !Object.keys(fields).length)
              return bad('fields is required for action=update, e.g. {"summary":"New title"}');
            const r = await api(
              creds,
              2,
              `issue/${encodeURIComponent(params.issue_key)}`,
              "PUT",
              { fields },
              signal,
            );
            if (!r.ok) return fin(`Failed to update ${params.issue_key}.\n${errText(r)}`, true);
            return fin(
              `Updated ${params.issue_key} (${Object.keys(fields).join(", ")})\nURL: ${creds.url}/browse/${params.issue_key}`,
            );
          }
          case "link": {
            if (!targets.length || !params.link_type || !params.target_key)
              return bad(
                "action=link requires issue_key or issue_keys (sources), link_type and target_key. link_type: " +
                  Object.keys(LINK_SHORTCUTS).join(" | ") +
                  " or a raw Jira link type name (see action=link_types).",
              );
            const sc = LINK_SHORTCUTS[params.link_type.toLowerCase()];
            const typeName = sc?.type ?? params.link_type;
            // Raw type names: source is sent as inwardIssue, i.e. source reads with the
            // type's OUTWARD phrase (check action=link_types to confirm the wording).
            const sourceIsInward = sc ? sc.sourceIsInward : true;
            const res = await perKey(targets, async (key) => {
              if (key === params.target_key!.toUpperCase()) return `  \u2717 ${key}: cannot link an issue to itself`;
              const inward = sourceIsInward ? key : params.target_key!;
              const outward = sourceIsInward ? params.target_key! : key;
              const r = await api(
                creds,
                2,
                "issueLink",
                "POST",
                { type: { name: typeName }, inwardIssue: { key: inward }, outwardIssue: { key: outward } },
                signal,
              );
              return r.ok
                ? `  \u2713 ${key} ${params.link_type} ${params.target_key}`
                : `  \u2717 ${key}: ${errText(r)}`;
            });
            return fin(
              `Link (Jira type "${typeName}"): ${res.ok} succeeded, ${res.failed} failed\n${res.text}`,
              res.failed > 0,
            );
          }
          case "comment": {
            if (!targets.length) return bad("issue_key or issue_keys is required for action=comment.");
            if (!params.body?.trim()) return bad("body is required for action=comment.");
            const res = await perKey(targets, async (key) => {
              const r = await api(creds, 2, `issue/${encodeURIComponent(key)}/comment`, "POST", { body: params.body }, signal);
              return r.ok ? `  \u2713 ${key} commented` : `  \u2717 ${key}: ${errText(r)}`;
            });
            return fin(`Comment on ${targets.length} issue(s): ${res.ok} ok, ${res.failed} failed\n${res.text}`, res.failed > 0);
          }
          case "transition": {
            if (!targets.length) return bad("issue_key or issue_keys is required for action=transition.");
            if (!params.transition?.trim())
              return bad("transition is required (name or id) \u2014 call action=transitions on the issue to see what it allows.");
            const want = params.transition.trim().toLowerCase();
            const res = await perKey(targets, async (key) => {
              const tr = await api(creds, 2, `issue/${encodeURIComponent(key)}/transitions`, "GET", undefined, signal);
              if (!tr.ok) return `  \u2717 ${key}: ${errText(tr)}`;
              const ts = tr.json?.transitions ?? [];
              // Match on transition name, destination status name, or numeric id.
              const t =
                ts.find((x: any) => String(x.id) === want) ??
                ts.find((x: any) => String(x.name).toLowerCase() === want) ??
                ts.find((x: any) => String(x.to?.name ?? "").toLowerCase() === want) ??
                ts.find((x: any) => String(x.name).toLowerCase().includes(want));
              if (!t)
                return `  \u2717 ${key}: no transition matching "${params.transition}" (available: ${ts
                  .map((x: any) => `${x.name}\u2192${x.to?.name}`)
                  .join(", ")})`;
              const build = (withRes: boolean) => {
                const payload: Record<string, any> = { transition: { id: t.id } };
                if (withRes && params.resolution) payload.fields = { resolution: { name: params.resolution } };
                if (params.body?.trim()) payload.update = { comment: [{ add: { body: params.body } }] };
                return payload;
              };
              let r = await api(creds, 2, `issue/${encodeURIComponent(key)}/transitions`, "POST", build(true), signal);
              let note = "";
              // A resolution that isn't on the transition screen is rejected with 400; the
              // status change itself is still valid, so retry without it rather than failing.
              if (!r.ok && params.resolution && r.status === 400) {
                const retry = await api(creds, 2, `issue/${encodeURIComponent(key)}/transitions`, "POST", build(false), signal);
                if (retry.ok) {
                  r = retry;
                  note = ` (resolution "${params.resolution}" not on the transition screen \u2014 status changed without it)`;
                }
              }
              return r.ok
                ? `  \u2713 ${key} \u2192 ${t.to?.name ?? t.name}${params.body ? " + comment" : ""}${note}`
                : `  \u2717 ${key}: ${errText(r)}`;
            });
            return fin(
              `Transition "${params.transition}": ${res.ok} ok, ${res.failed} failed\n${res.text}`,
              res.failed > 0,
            );
          }
          case "delete": {
            if (!targets.length) return bad("issue_key or issue_keys is required for action=delete.");
            if (params.confirm_delete !== true)
              return bad(
                "action=delete is irreversible and requires confirm_delete:true. Deletion is rarely what a backlog cleanup needs \u2014 prefer link duplicates + transition to Done/Duplicate, and only delete when the user explicitly asked to destroy the issue.",
              );
            const res = await perKey(targets, async (key) => {
              const r = await api(creds, 2, `issue/${encodeURIComponent(key)}?deleteSubtasks=true`, "DELETE", undefined, signal);
              return r.ok ? `  \u2713 ${key} deleted permanently` : `  \u2717 ${key}: ${errText(r)}`;
            });
            return fin(`Delete: ${res.ok} deleted, ${res.failed} failed\n${res.text}`, res.failed > 0);
          }
          default:
            return bad(`Unknown action '${(params as any).action}'. Valid: ${actionEnum.join(", ")}`);
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return fin("Cancelled.", true);
        return fin(`Request failed: ${e?.message ?? String(e)} (check JIRA_URL=${creds.url} and network access)`, true);
      }
    },
    renderCall(args: JiraToolInput, theme) {
      const keys = args.issue_keys?.length
        ? args.issue_keys.length <= 3
          ? args.issue_keys.join(",")
          : `${args.issue_keys.slice(0, 3).join(",")}+${args.issue_keys.length - 3}`
        : args.issue_key;
      const bits = [
        keys,
        args.jql && `"${args.jql}"`,
        args.project && `${args.project}${args.issue_type ? `/${args.issue_type}` : ""}`,
        args.board_id && `board ${args.board_id}`,
        args.threshold !== undefined && `\u2265${args.threshold}`,
        args.transition && `\u2192 ${args.transition}`,
        args.resolution && `(${args.resolution})`,
        args.link_type && args.target_key && `${args.link_type} ${args.target_key}`,
      ].filter(Boolean);
      return new Text(
        `${theme.fg("accent", "jira")} ${theme.bold(args.action)}${bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""}`,
        0,
        0,
      );
    },
  });
}
