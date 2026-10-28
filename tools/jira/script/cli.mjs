import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { Client, JiraError, loadCreds } from "./client.mjs";
import { clusterJson, findDuplicateClusters, toDoc } from "./dedupe.mjs";
import { MAX_DOWNLOAD_BYTES, checkUpload, describeSaved, expandPath, readUpload, safeName, saveBuffer } from "./files.mjs";
import { attLine, counts, dryRunText, duplicatesText, fmtSize, issueLine, showText } from "./format.mjs";

/** Superset of every flag. Each command declares which subset it accepts (typos fail loudly). */
const OPTION_TYPES = {
  limit: { type: "string" },
  days: { type: "string" },
  project: { type: "string" },
  "issue-type": { type: "string" },
  "board-id": { type: "string" },
  jql: { type: "string" },
  threshold: { type: "string" },
  fields: { type: "string" },
  "fields-file": { type: "string" },
  "fields-stdin": { type: "boolean" },
  summary: { type: "string" },
  description: { type: "string" },
  "description-file": { type: "string" },
  type: { type: "string" },
  target: { type: "string" },
  to: { type: "string" },
  resolution: { type: "string" },
  comment: { type: "string" },
  body: { type: "string" },
  file: { type: "string", multiple: true },
  stdin: { type: "boolean" },
  out: { type: "string" },
  yes: { type: "boolean" },
  param: { type: "string", multiple: true },
  data: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const GLOBAL_OPTS = ["json", "dry-run", "help"];

const usageErr = (m) => new JiraError(m, { code: "usage" });
const need = (v, what) => {
  if (v === undefined || v === "") throw usageErr(`Missing ${what}.`);
  return v;
};
const numFlag = (v, def, name, { min = 1, max = Infinity, int = true } = {}) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || (int && !Number.isInteger(n))) throw usageErr(`--${name} must be a${int ? "n integer" : " number"}, got "${v}".`);
  return Math.max(min, Math.min(n, max));
};

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
 */
export const LINK_SHORTCUTS = {
  "child-of": { type: "Child-Issue", sourceIsInward: false },
  "parent-of": { type: "Child-Issue", sourceIsInward: true },
  blocks: { type: "Blocks", sourceIsInward: true },
  "is-blocked-by": { type: "Blocks", sourceIsInward: false },
  "relates-to": { type: "Relates", sourceIsInward: true },
  duplicates: { type: "Duplicate", sourceIsInward: true },
  clones: { type: "Cloners", sourceIsInward: true },
};

const SCAN_FIELDS = ["summary", "description", "status", "issuetype", "assignee", "reporter", "created", "updated", "labels", "priority", "issuelinks"];
const LIST_FIELDS = ["summary", "status", "assignee", "priority", "updated"];

/** PROJ-123, a numeric id, or any URL containing /browse/PROJ-123 or selectedIssue=PROJ-123. */
export function issueKey(ref) {
  const s = String(ref ?? "").trim();
  const m = s.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/) || s.match(/[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/);
  const k = (m ? m[1] : s).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(k) && !/^\d+$/.test(k)) throw usageErr(`"${ref}" is not an issue key (PROJ-123) or a .../browse/PROJ-123 URL.`);
  return k;
}
const issueKeys = (pos, what = "issue key") => {
  if (!pos.length) throw usageErr(`Missing ${what}(s).`);
  return [...new Set(pos.map(issueKey))];
};
const enc = encodeURIComponent;
/** Project key in JQL: bare when it is a plain key, quoted otherwise (names with spaces). */
const jqlProject = (p) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(p) ? p : JSON.stringify(p));

/** Text from a flag, a file or stdin. Returns undefined when none was given. */
function readText(sources) {
  const given = sources.filter(([, val]) => val !== undefined && val !== false);
  if (given.length > 1) throw usageErr(`Use only one of ${sources.map(([n]) => n).join(", ")}.`);
  if (!given.length) return undefined;
  const [name, val] = given[0];
  if (name.endsWith("-stdin") || name === "--stdin") return readFileSync(0, "utf8");
  if (name.endsWith("-file") || name === "--file") return readFileSync(expandPath(Array.isArray(val) ? val[0] : val), "utf8");
  return val;
}

/** Field object from --fields/--fields-file/--fields-stdin. A {"fields":{...}} wrapper is accepted too. */
function readFields(v) {
  const raw = readText([["--fields", v.fields], ["--fields-file", v["fields-file"]], ["--fields-stdin", v["fields-stdin"]]]);
  if (raw === undefined) return {};
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw usageErr("--fields must be a JSON object.");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw usageErr("--fields must be a JSON object.");
  return obj.fields && typeof obj.fields === "object" ? { ...obj.fields } : obj;
}

/** Paginated v3 POST search/jql (follows nextPageToken; v2 POST /search is deprecated). */
async function searchAll(client, jql, cap, fields) {
  const issues = [];
  let nextPageToken;
  let pages = 0;
  while (issues.length < cap && pages < 60) {
    const body = { jql, maxResults: Math.min(100, cap - issues.length), fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const r = await client.api(3, "POST", "search/jql", { body, readOnly: true });
    pages++;
    const page = r?.issues ?? [];
    issues.push(...page);
    nextPageToken = r?.nextPageToken;
    if (!nextPageToken || !page.length) return { issues, truncated: false, pages };
  }
  return { issues, truncated: true, pages };
}

/** Resolve --board-id, or the board owned by --project. */
async function resolveBoard(client, v) {
  if (v["board-id"]) return { id: numFlag(v["board-id"], 0, "board-id"), name: `board ${v["board-id"]}` };
  if (!v.project) return { error: "pass --board-id or --project (see: boards)." };
  let r;
  try {
    r = await client.agile("GET", "board", { query: { projectKeyOrId: v.project, maxResults: 50 } });
  } catch (e) {
    if (e.code !== "http") throw e;
    return { error: e.message };
  }
  const boards = r?.values ?? [];
  if (!boards.length) return { error: `No board found for project ${v.project}.` };
  // projectKeyOrId matches every board whose FILTER can see the project, including boards
  // owned by other projects. Picking boards[0] blindly returns another team's backlog.
  const want = v.project.toUpperCase();
  const owned = boards.filter((b) => String(b.location?.projectKey ?? "").toUpperCase() === want);
  const chosen = owned[0] ?? boards[0];
  return {
    id: chosen.id,
    name: `${chosen.name} (id ${chosen.id}${chosen.location?.projectKey ? `, ${chosen.location.projectKey}` : ""})`,
    warn: owned.length
      ? owned.length > 1
        ? `${owned.length} boards belong to ${want}; using the first. Pass --board-id to choose another (see: boards).`
        : undefined
      : `No board is owned by ${want}; falling back to "${chosen.name}", which lives in ${chosen.location?.projectKey ?? "another project"} and may contain other projects' issues. Pass --board-id explicitly (see: boards).`,
  };
}

/** Ranked backlog of a board, paginated (Agile API, not the platform API). */
async function fetchBacklog(client, boardId, cap) {
  const issues = [];
  let startAt = 0;
  while (issues.length < cap) {
    const r = await client.agile("GET", `board/${enc(boardId)}/backlog`, {
      query: { startAt, maxResults: Math.min(100, cap - issues.length), fields: SCAN_FIELDS.join(",") },
    });
    const page = r?.issues ?? [];
    issues.push(...page);
    startAt += page.length;
    if (!page.length || r?.isLast || startAt >= (r?.total ?? 0)) break;
  }
  return issues;
}

/** Run one write per key; a single failure never aborts the batch. */
async function perKey(client, keys, fn) {
  const lines = [];
  let failed = 0;
  for (const k of keys) {
    try {
      lines.push(`  OK     ${await fn(k)}`);
    } catch (e) {
      if (e?.code === "network" && keys.length === 1) throw e;
      failed++;
      lines.push(`  FAILED ${k}: ${e?.message ?? String(e)}`);
      if (client.dryRun) client.intent(`WOULD FAIL ${k}: ${e?.message ?? String(e)}`);
    }
  }
  return { text: lines.join("\n"), failed, ok: keys.length - failed, lines };
}

/* ------------------------------------------------------------------ commands */

const COMMANDS = {
  me: {
    usage: "me",
    desc: "Show the authenticated user and site.",
    opts: [],
    async run({ client }) {
      const j = await client.api(2, "GET", "myself");
      const text = ["User Profile:", `  Name:    ${j.displayName}`, `  Email:   ${j.emailAddress ?? "(hidden)"}`, `  Account: ${j.accountId}`, `  Active:  ${j.active}`, `  Site:    ${client.base}`].join("\n");
      return { data: j, text };
    },
  },

  "test-token": {
    usage: "test-token",
    desc: "Verify the credentials (exit 1 if the token is invalid or expired).",
    opts: [],
    async run({ client }) {
      let j;
      try {
        j = await client.api(2, "GET", "myself");
      } catch (e) {
        if (e.code === "http") throw new JiraError(`Token invalid or expired.\n${e.message}`, { status: e.status, code: "http" });
        throw e;
      }
      if (!j?.displayName) throw new JiraError("Token invalid or expired (no user returned).", { code: "http" });
      return { data: { ok: true, displayName: j.displayName, emailAddress: j.emailAddress, site: client.base }, text: `Token OK - authenticated as ${j.displayName} <${j.emailAddress ?? "?"}> at ${client.base}` };
    },
  },

  projects: {
    usage: "projects [filter]",
    desc: "List visible projects. Optional case-insensitive key/name filter; the unfiltered list is capped at 40 (100 when filtered).",
    opts: [],
    async run({ client, pos }) {
      const r = await client.api(2, "GET", "project");
      const all = Array.isArray(r) ? r : [];
      const raw = pos.join(" ").trim();
      const q = raw.toLowerCase();
      const list = q ? all.filter((p) => String(p.key).toLowerCase().includes(q) || String(p.name).toLowerCase().includes(q)) : all;
      if (!list.length) return { data: [], text: q ? `No project matches '${raw}' (${all.length} projects visible).` : "No projects visible to this account." };
      const shown = list.slice(0, q ? 100 : 40);
      const head = `Projects (${shown.length} of ${list.length}${q ? ` matching '${raw}'` : ""} shown${list.length > shown.length ? "; pass a filter to narrow" : ""}):`;
      return { data: shown.map((p) => ({ id: p.id, key: p.key, name: p.name })), text: `${head}\n${shown.map((p) => `  [${p.key}] ${p.name}`).join("\n")}` };
    },
  },

  show: {
    usage: "show <issue>",
    desc: "One issue: summary, status, people, epic/parent, links, attachments, description and bug Details fields (Steps to Reproduce, Expected/Actual Result...). <issue> is a key like PROJ-123 or a .../browse/PROJ-123 URL.",
    opts: [],
    async run({ client, pos }) {
      const key = issueKey(need(pos[0], "issue key"));
      const r = await client.api(2, "GET", `issue/${enc(key)}`, { query: { expand: "names" } });
      return { data: r, text: showText(r, client.base) };
    },
  },

  list: {
    usage: "list [--limit N]",
    desc: "Issues assigned to you, most recently updated first (default 10, max 100).",
    opts: ["limit"],
    async run({ client, v }) {
      const limit = numFlag(v.limit, 10, "limit", { max: 100 });
      const r = await client.api(3, "POST", "search/jql", { readOnly: true, body: { jql: "assignee = currentUser() ORDER BY updated DESC", maxResults: limit, fields: ["summary", "status", "priority", "updated"] } });
      const issues = r?.issues ?? [];
      return { data: issues, text: issues.length ? `Your assigned issues (${issues.length} shown):\n\n${issues.map(issueLine).join("\n\n")}` : "No issues assigned to you." };
    },
  },

  search: {
    usage: 'search <jql> [--limit N]',
    desc: 'JQL search, auto-paginated (default 10, max 1000). Quote the JQL as one argument: search \'project = PROJ AND status = "In Progress"\'.',
    opts: ["limit", "jql"],
    async run({ client, pos, v }) {
      const jql = (v.jql ?? pos.join(" ")).trim();
      if (!jql) throw usageErr("JQL is required: search '<jql>'.");
      const r = await searchAll(client, jql, numFlag(v.limit, 10, "limit", { max: 1000 }), LIST_FIELDS);
      if (!r.issues.length) return { data: [], text: `No issues matched: ${jql}` };
      return { data: r.issues, text: `Search: ${jql}\nResults (${r.issues.length} shown${r.truncated ? ", more available - raise --limit" : ""}):\n\n${r.issues.map(issueLine).join("\n\n")}` };
    },
  },

  stats: {
    usage: "stats [--days N]",
    desc: "Your issues updated in the last N days (default 30), counted by status and priority.",
    opts: ["days"],
    async run({ client, v }) {
      const days = numFlag(v.days, 30, "days");
      const { issues } = await searchAll(client, `assignee = currentUser() AND updated >= -${days}d`, 1000, ["status", "priority"]);
      if (!issues.length) return { data: { days, total: 0 }, text: `No issues updated in the last ${days} days.` };
      const text = [`Statistics (last ${days} days)`, `Total issues: ${issues.length}`, "", "By status:", counts(issues, (f) => f.status?.name ?? "Unknown"), "", "By priority:", counts(issues, (f) => f.priority?.name ?? "None")].join("\n");
      return { data: issues, text };
    },
  },

  "sprint-stats": {
    usage: "sprint-stats",
    desc: "Your issues in open sprints, counted by status.",
    opts: [],
    async run({ client }) {
      const { issues } = await searchAll(client, "assignee = currentUser() AND sprint in openSprints()", 1000, ["status", "summary"]);
      if (!issues.length) return { data: [], text: "No issues assigned to you in active sprints." };
      return { data: issues, text: ["Current sprint statistics", `Total issues: ${issues.length}`, "", "By status:", counts(issues, (f) => f.status?.name ?? "Unknown")].join("\n") };
    },
  },

  boards: {
    usage: "boards [--project P]",
    desc: "Agile boards (max 50), optionally those whose filter includes project P. The trailing key is where the board LIVES.",
    opts: ["project"],
    async run({ client, v }) {
      let r;
      try {
        r = await client.agile("GET", "board", { query: { projectKeyOrId: v.project, maxResults: 50 } });
      } catch (e) {
        if (e.code === "http") e.message += "\n(Boards come from the Agile API - a Jira Work Management project has none.)";
        throw e;
      }
      const boards = r?.values ?? [];
      if (!boards.length) return { data: [], text: v.project ? `No boards for project ${v.project}.` : "No boards visible." };
      const head = `Boards (${boards.length}${r?.isLast === false ? "+" : ""})${v.project ? ` - boards whose filter includes ${v.project} issues; the trailing key is where the board LIVES, which can be another project` : ""}:`;
      return { data: boards, text: `${head}\n${boards.map((b) => `  ${b.id}  ${b.name} [${b.type}]${b.location?.projectKey ? ` - ${b.location.projectKey}` : ""}`).join("\n")}` };
    },
  },

  backlog: {
    usage: "backlog (--project P | --board-id N) [--limit N]",
    desc: "Ranked board backlog (Agile API; default 300, max 2000). Prefers a board located in P and warns on fallbacks or foreign issue keys. Projects without a board fall back to a Rank-ordered JQL scan.",
    opts: ["project", "board-id", "limit"],
    async run({ client, v }) {
      const cap = numFlag(v.limit, 300, "limit", { max: 2000 });
      const board = await resolveBoard(client, v);
      if (board.error) {
        // Team-managed projects / restricted boards: fall back to a rank-ordered JQL scan.
        if (!v.project) throw usageErr(board.error);
        const jql = `project = ${jqlProject(v.project)} AND statusCategory != Done ORDER BY Rank ASC`;
        let r;
        try {
          r = await searchAll(client, jql, cap, LIST_FIELDS);
        } catch (e) {
          throw new JiraError(`${board.error}\nJQL fallback also failed: ${e.message}`, { status: e.status, code: e.code });
        }
        return { data: { fallback: true, jql, issues: r.issues }, text: `Backlog fallback for ${v.project} (no board: ${board.error})\nJQL: ${jql}\n${r.issues.length} issues${r.truncated ? " (truncated - raise --limit)" : ""}:\n\n${r.issues.map(issueLine).join("\n\n")}` };
      }
      const issues = await fetchBacklog(client, board.id, cap);
      if (!issues.length) return { data: { board, issues }, text: `Backlog of ${board.name} is empty.` };
      const foreign = v.project ? [...new Set(issues.map((i) => String(i.key).split("-")[0]))].filter((p) => p !== v.project.toUpperCase()) : [];
      const warn = `${board.warn ? `WARNING: ${board.warn}\n` : ""}${foreign.length ? `WARNING: Backlog also contains issues from: ${foreign.join(", ")}\n` : ""}`;
      const rows = issues.map((i, n) => `${String(n + 1).padStart(3)}. ${issueLine(i).replace(/\n/g, "\n     ")}`);
      return { data: { board, warnings: [board.warn, foreign.length ? `foreign: ${foreign.join(",")}` : undefined].filter(Boolean), issues }, text: `${warn}Backlog of ${board.name} - ${issues.length} issues in rank order:\n\n${rows.join("\n")}` };
    },
  },

  "find-duplicates": {
    usage: "find-duplicates (--project P | --jql Q | --board-id N) [--threshold 0.55] [--limit 300]",
    desc: "Cluster near-identical issues locally (no LLM, no extra API calls). Scope: --project (statusCategory != Done), --jql, or a board backlog. Threshold 0.2..0.99 (0.75+ = near-identical only); --limit up to 2000. Clusters are CANDIDATES: show them to the user before closing anything.",
    opts: ["project", "jql", "board-id", "threshold", "limit"],
    async run({ client, v }) {
      const threshold = numFlag(v.threshold, 0.55, "threshold", { min: 0.2, max: 0.99, int: false });
      const cap = numFlag(v.limit, 300, "limit", { max: 2000 });
      let issues;
      let scope;
      let truncated = false;
      if (v["board-id"]) {
        const id = numFlag(v["board-id"], 0, "board-id");
        issues = await fetchBacklog(client, id, cap);
        scope = `backlog of board ${id}`;
      } else {
        const jql = v.jql?.trim() || (v.project ? `project = ${jqlProject(v.project)} AND statusCategory != Done ORDER BY created ASC` : "");
        if (!jql) throw usageErr("find-duplicates needs --project, --jql or --board-id.");
        const r = await searchAll(client, jql, cap, SCAN_FIELDS);
        issues = r.issues;
        truncated = r.truncated;
        scope = jql;
      }
      if (issues.length < 2) return { data: { scope, scanned: issues.length, clusters: [] }, text: `Only ${issues.length} issue(s) in scope (${scope}) - nothing to compare.` };
      const res = findDuplicateClusters(issues.map(toDoc), threshold);
      return {
        data: { scope, scanned: issues.length, truncated, threshold, compared: res.compared, pairCount: res.pairCount, clusters: res.clusters.map(clusterJson) },
        text: duplicatesText(res, { scope, scanned: issues.length, truncated, threshold }),
      };
    },
  },

  transitions: {
    usage: "transitions <issue>",
    desc: "Workflow moves the issue currently allows (id, name, destination status).",
    opts: [],
    async run({ client, pos }) {
      const key = issueKey(need(pos[0], "issue key"));
      const r = await client.api(2, "GET", `issue/${enc(key)}/transitions`);
      const ts = r?.transitions ?? [];
      if (!ts.length) return { data: [], text: `${key} has no available transitions for this account.` };
      return { data: ts, text: `Transitions available for ${key}:\n${ts.map((t) => `  ${t.id}  "${t.name}" -> ${t.to?.name ?? "?"} [${t.to?.statusCategory?.name ?? "?"}]`).join("\n")}` };
    },
  },

  "link-types": {
    usage: "link-types",
    desc: "Issue link types with their inward/outward phrases.",
    opts: [],
    async run({ client }) {
      const types = (await client.api(2, "GET", "issueLinkType"))?.issueLinkTypes ?? [];
      return { data: types, text: `Available link types:\n${types.map((t) => `  ${t.name}\n    inward:  ${t.inward}\n    outward: ${t.outward}`).join("\n")}` };
    },
  },

  createmeta: {
    usage: "createmeta <project> [--issue-type T]",
    desc: "Issue types of a project, or with --issue-type the creatable fields (* = required, with allowed values). Run before create on an unfamiliar project.",
    opts: ["issue-type"],
    async run({ client, pos, v }) {
      const project = need(pos[0], "project key");
      const pk = enc(project);
      const types = (await client.api(3, "GET", `issue/createmeta/${pk}/issuetypes`))?.issueTypes ?? [];
      if (!v["issue-type"]) return { data: types, text: `Issue types for ${project}:\n${types.map((t) => `  ${t.id}  ${t.name}`).join("\n")}\n\nRun again with --issue-type <name> to see fields.` };
      const match = types.find((t) => String(t.name).toLowerCase() === v["issue-type"].toLowerCase());
      if (!match) throw usageErr(`Issue type '${v["issue-type"]}' not found in ${project}. Available: ${types.map((t) => t.name).join(", ")}`);
      const flds = (await client.api(3, "GET", `issue/createmeta/${pk}/issuetypes/${enc(match.id)}`))?.fields ?? [];
      const lines = flds.map((f) => {
        const vals = (f.allowedValues ?? []).slice(0, 6).map((x) => `${x.id}: ${x.value ?? x.name ?? "?"}`).join(", ");
        return `${f.required ? "* " : "  "}${f.fieldId}  [${f.name}]${vals ? `\n    Values: ${vals}` : ""}`;
      });
      return { data: flds, text: `Fields for ${project} / ${match.name} (* = required):\n${lines.join("\n")}` };
    },
  },

  attachments: {
    usage: "attachments <issue>",
    desc: "List files attached to an issue (id, name, type, size, author, date).",
    opts: [],
    async run({ client, pos }) {
      const key = issueKey(need(pos[0], "issue key"));
      const r = await client.api(2, "GET", `issue/${enc(key)}`, { query: { fields: "attachment,summary" } });
      const atts = r?.fields?.attachment ?? [];
      return { data: atts, text: atts.length ? `${atts.length} attachment(s) on ${r.key}:\n${atts.map(attLine).join("\n")}` : `No attachments on ${r.key}.` };
    },
  },

  "attachment get": {
    usage: "attachment get (<attachment-id> | <issue> <filename>) [--out <dir>]",
    desc: "Download an attachment (default dir: system temp/jira; never overwrites). Prints the saved path: Read it afterwards.",
    opts: ["out"],
    async run({ client, pos, v }) {
      const first = need(pos[0], "attachment id or issue key");
      let meta;
      let id;
      if (/^\d+$/.test(first) && pos.length === 1) {
        id = first;
        meta = await client.api(2, "GET", `attachment/${enc(id)}`);
      } else {
        const key = issueKey(first);
        const filename = need(pos.slice(1).join(" "), "filename (or pass a numeric attachment id alone)");
        const r = await client.api(2, "GET", `issue/${enc(key)}`, { query: { fields: "attachment" } });
        const atts = r?.fields?.attachment ?? [];
        meta = atts.filter((a) => a.filename === filename).pop() ?? atts.filter((a) => String(a.filename).toLowerCase() === filename.toLowerCase()).pop();
        if (!meta) throw new JiraError(`No attachment named "${filename}" on ${key}. Available: ${atts.map((a) => a.filename).join(", ") || "none"}`, { code: "no_match" });
        id = String(meta.id);
      }
      if (meta?.size && meta.size > MAX_DOWNLOAD_BYTES) throw new JiraError(`Attachment too large (${fmtSize(meta.size)}).`, { code: "too_large" });
      const got = await client.download(`rest/api/2/attachment/content/${enc(id)}`, MAX_DOWNLOAD_BYTES);
      const name = meta?.filename ?? `attachment-${id}`;
      const mime = meta?.mimeType || got.contentType.split(";")[0];
      const saved = saveBuffer(got.buf, safeName(name), v.out);
      const d = describeSaved(saved, name, mime, got.buf.length);
      return { data: { path: saved, id, name, mimeType: mime, bytes: got.buf.length, kind: d.kind }, text: d.text };
    },
  },

  /* ------------------------------------------------------------ writes */

  create: {
    usage: "create [--fields '<json>' | --fields-file F | --fields-stdin] [--project P] [--issue-type T] [--summary S] [--description D | --description-file F]",
    desc: 'Create an issue (REST v2, plain-text description). Shortcut flags are merged over --fields. Custom fields go in --fields, e.g. --project PROJ --issue-type Story --summary "..." --fields \'{"customfield_10014":"PROJ-900"}\'. Run createmeta first to learn required fields.',
    opts: ["fields", "fields-file", "fields-stdin", "project", "issue-type", "summary", "description", "description-file"],
    async run({ client, v }) {
      const fields = readFields(v);
      if (v.project) fields.project = { key: v.project };
      if (v["issue-type"]) fields.issuetype = { name: v["issue-type"] };
      if (v.summary !== undefined) fields.summary = v.summary;
      const desc = readText([["--description", v.description], ["--description-file", v["description-file"]]]);
      if (desc !== undefined) fields.description = desc;
      if (!Object.keys(fields).length) throw usageErr('Nothing to create: pass --fields \'{"project":{"key":"PROJ"},"issuetype":{"name":"Story"},"summary":"..."}\' or --project/--issue-type/--summary.');
      client.intent(`Create issue: ${JSON.stringify(fields).slice(0, 800)}`);
      const r = await client.api(2, "POST", "issue", { body: { fields } });
      if (!r?.key) throw new JiraError(`Failed to create issue (no key returned): ${JSON.stringify(r).slice(0, 300)}`, { code: "http" });
      return { data: r, text: `Created ${r.key}\nURL: ${client.base}/browse/${r.key}` };
    },
  },

  update: {
    usage: "update <issue> [--fields '<json>' | --fields-file F | --fields-stdin] [--summary S] [--description D | --description-file F]",
    desc: "Edit fields of an issue (PUT, REST v2). Cannot change status: use transition.",
    opts: ["fields", "fields-file", "fields-stdin", "summary", "description", "description-file"],
    async run({ client, pos, v }) {
      const key = issueKey(need(pos[0], "issue key"));
      const fields = readFields(v);
      if (v.summary !== undefined) fields.summary = v.summary;
      const desc = readText([["--description", v.description], ["--description-file", v["description-file"]]]);
      if (desc !== undefined) fields.description = desc;
      if (!Object.keys(fields).length) throw usageErr('Nothing to update: pass --fields \'{"summary":"New title"}\', --summary or --description.');
      client.intent(`Update ${key}: ${JSON.stringify(fields).slice(0, 800)}`);
      await client.api(2, "PUT", `issue/${enc(key)}`, { body: { fields } });
      return { data: { key, updated: Object.keys(fields) }, text: `Updated ${key} (${Object.keys(fields).join(", ")})\nURL: ${client.base}/browse/${key}` };
    },
  },

  transition: {
    usage: "transition <issue...> --to <name|status|id> [--resolution R] [--comment T]",
    desc: "Change status. --to matches transition id, transition name, destination status, then a name substring. If --resolution is not on the transition screen (HTTP 400) it retries without it. Bulk: several keys, per-key results.",
    opts: ["to", "resolution", "comment"],
    async run({ client, pos, v }) {
      const keys = issueKeys(pos);
      const raw = need(v.to?.trim(), "--to (transition name, status or id; see: transitions <issue>)");
      const want = raw.toLowerCase();
      client.intent(`Transition ${keys.join(", ")} -> ${raw}${v.resolution ? ` (resolution: ${v.resolution})` : ""}${v.comment ? `, comment: ${v.comment.slice(0, 300)}` : ""}`);
      const res = await perKey(client, keys, async (key) => {
        const ts = (await client.api(2, "GET", `issue/${enc(key)}/transitions`))?.transitions ?? [];
        const t =
          ts.find((x) => String(x.id) === want) ??
          ts.find((x) => String(x.name).toLowerCase() === want) ??
          ts.find((x) => String(x.to?.name ?? "").toLowerCase() === want) ??
          ts.find((x) => String(x.name).toLowerCase().includes(want));
        if (!t) throw new Error(`no transition matching "${raw}" (available: ${ts.map((x) => `${x.name}->${x.to?.name}`).join(", ") || "none"})`);
        const build = (withRes) => {
          const payload = { transition: { id: t.id } };
          if (withRes && v.resolution) payload.fields = { resolution: { name: v.resolution } };
          if (v.comment?.trim()) payload.update = { comment: [{ add: { body: v.comment } }] };
          return payload;
        };
        let note = "";
        try {
          await client.api(2, "POST", `issue/${enc(key)}/transitions`, { body: build(true) });
        } catch (e) {
          // A resolution that isn't on the transition screen is rejected with 400; the status
          // change itself is still valid, so retry without it rather than failing.
          if (!(v.resolution && e.status === 400)) throw e;
          await client.api(2, "POST", `issue/${enc(key)}/transitions`, { body: build(false) });
          note = ` (resolution "${v.resolution}" not on the transition screen - status changed without it)`;
        }
        return `${key} -> ${t.to?.name ?? t.name}${v.comment ? " + comment" : ""}${note}`;
      });
      return { data: res, text: `Transition "${raw}": ${res.ok} ok, ${res.failed} failed\n${res.text}`, failed: res.failed };
    },
  },

  comment: {
    usage: "comment <issue...> (--body T | --file F | --stdin)",
    desc: "Add a plain-text comment (REST v2) to one or more issues.",
    opts: ["body", "file", "stdin"],
    async run({ client, pos, v }) {
      const keys = issueKeys(pos);
      if ((v.file?.length ?? 0) > 1) throw usageErr("Pass one --file.");
      const body = readText([["--body", v.body], ["--file", v.file?.[0]], ["--stdin", v.stdin]]);
      if (!body?.trim()) throw usageErr("Comment text is empty: pass --body, --file or --stdin.");
      client.intent(`Comment on ${keys.join(", ")}: ${body.slice(0, 600)}${body.length > 600 ? "..." : ""}`);
      const res = await perKey(client, keys, async (key) => {
        await client.api(2, "POST", `issue/${enc(key)}/comment`, { body: { body } });
        return `${key} commented`;
      });
      return { data: res, text: `Comment on ${keys.length} issue(s): ${res.ok} ok, ${res.failed} failed\n${res.text}`, failed: res.failed };
    },
  },

  link: {
    usage: "link <issue...> --type <shortcut|Jira type name> --target <issue>",
    desc: `Link each source issue to --target, read as "<issue> <type> <target>". Shortcuts: ${Object.keys(LINK_SHORTCUTS).join(", ")}. A raw Jira type name sends the source as inwardIssue (it reads with the type's OUTWARD phrase; see link-types).`,
    opts: ["type", "target"],
    async run({ client, pos, v }) {
      const keys = issueKeys(pos, "source issue key");
      const linkType = need(v.type, `--type (${Object.keys(LINK_SHORTCUTS).join(" | ")} or a raw Jira link type name)`);
      const target = issueKey(need(v.target, "--target issue key"));
      const sc = LINK_SHORTCUTS[linkType.toLowerCase()];
      const typeName = sc?.type ?? linkType;
      const sourceIsInward = sc ? sc.sourceIsInward : true;
      client.intent(`Link ${keys.join(", ")} ${linkType} ${target} (Jira type "${typeName}")`);
      const res = await perKey(client, keys, async (key) => {
        if (key === target) throw new Error("cannot link an issue to itself");
        const inward = sourceIsInward ? key : target;
        const outward = sourceIsInward ? target : key;
        await client.api(2, "POST", "issueLink", { body: { type: { name: typeName }, inwardIssue: { key: inward }, outwardIssue: { key: outward } } });
        return `${key} ${linkType} ${target}`;
      });
      return { data: res, text: `Link (Jira type "${typeName}"): ${res.ok} succeeded, ${res.failed} failed\n${res.text}`, failed: res.failed };
    },
  },

  delete: {
    usage: "delete <issue...> --yes",
    desc: "PERMANENTLY delete issues and their sub-tasks. IRREVERSIBLE: closing as duplicate (link + transition) is usually right instead. Requires --yes and an explicit user request to delete.",
    opts: ["yes"],
    async run({ client, pos, v }) {
      const keys = issueKeys(pos);
      if (!v.yes && !client.dryRun) throw usageErr("delete is irreversible and requires --yes. Prefer link --type duplicates + transition; only delete when the user explicitly asked to destroy the issue.");
      client.intent(`IRREVERSIBLE - permanently delete ${keys.length} issue(s) and their sub-tasks: ${keys.join(", ")}`);
      const res = await perKey(client, keys, async (key) => {
        await client.api(2, "DELETE", `issue/${enc(key)}`, { query: { deleteSubtasks: "true" } });
        return `${key} deleted permanently`;
      });
      return { data: res, text: `Delete: ${res.ok} deleted, ${res.failed} failed\n${res.text}`, failed: res.failed };
    },
  },

  "attachment add": {
    usage: "attachment add <issue...> --file <path> [--file <path2> ...]",
    desc: "Upload local file(s) to one or more issues (multipart, max 1 GB each).",
    opts: ["file"],
    async run({ client, pos, v }) {
      const keys = issueKeys(pos);
      const paths = v.file ?? [];
      if (!paths.length) throw usageErr("Pass at least one --file <path>.");
      const files = paths.map(checkUpload);
      const bad = files.find((f) => f.error);
      if (bad) throw usageErr(bad.error);
      client.intent(`Attach ${files.map((f) => `${f.name} (${fmtSize(f.size)})`).join(", ")} to ${keys.join(", ")}`);
      const res = await perKey(client, keys, async (key) => {
        const path = `rest/api/2/issue/${enc(key)}/attachments`;
        const headers = { "X-Atlassian-Token": "no-check" };
        if (client.dryRun) {
          await client.request("POST", path, { files: files.map((f) => f.path), headers });
        } else {
          const form = new FormData();
          for (const f of files) form.append("file", new Blob([readUpload(f)]), f.name);
          await client.request("POST", path, { form, headers });
        }
        return `${key}: attached ${files.map((f) => f.name).join(", ")}`;
      });
      return { data: res, text: `Attach: ${res.ok} ok, ${res.failed} failed\n${res.text}`, failed: res.failed };
    },
  },

  api: {
    usage: "api <GET|POST|PUT|DELETE> <path> [--param k=v ...] [--data '<json>']",
    desc: "Raw REST escape hatch. <path> is relative to JIRA_URL (e.g. rest/api/2/myself); absolute URLs are refused. Always prints JSON. Writes honor --dry-run.",
    opts: ["param", "data"],
    async run({ client, pos, v }) {
      const method = need(pos[0], "HTTP method").toUpperCase();
      if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw usageErr(`Unsupported method ${method}.`);
      const path = need(pos[1], "path");
      const query = {};
      for (const p of v.param ?? []) {
        const i = p.indexOf("=");
        if (i < 1) throw usageErr(`--param expects k=v, got "${p}".`);
        query[p.slice(0, i)] = p.slice(i + 1);
      }
      let body;
      if (v.data !== undefined) {
        try {
          body = JSON.parse(v.data);
        } catch {
          throw usageErr("--data must be valid JSON.");
        }
      }
      client.intent(`${method} ${path}`);
      const data = await client.request(method, path, { query, body });
      return { data, text: JSON.stringify(data, null, 2), forceJson: true };
    },
  },
};

/* ------------------------------------------------------------------ help */

const READ_CMDS = ["me", "test-token", "projects", "show", "list", "search", "stats", "sprint-stats", "boards", "backlog", "find-duplicates", "transitions", "link-types", "createmeta", "attachments", "attachment get"];

function helpText(cmdName) {
  if (cmdName && COMMANDS[cmdName]) {
    const c = COMMANDS[cmdName];
    return `${c.desc}\n\nUsage: jira ${c.usage}\nFlags valid for every command: --json, --dry-run (writes only), --help`;
  }
  const row = (k) => `  ${COMMANDS[k].usage}\n      ${COMMANDS[k].desc}`;
  return [
    "jira: Jira Cloud from the terminal, built for scripts and AI agents.",
    "",
    "Auth (required, no defaults): JIRA_URL (https://yourcompany.atlassian.net), JIRA_USERNAME (Atlassian email), JIRA_API_TOKEN.",
    "Output: compact text by default, --json for raw JSON. Errors go to stderr; exit 0 ok, 1 API/runtime error (or any failed key in a bulk write), 2 usage error.",
    "Issues: keys like PROJ-123 or .../browse/PROJ-123 URLs. Bulk writes take several keys and report each one.",
    "Every write supports --dry-run: it makes the read calls it needs, prints what would be sent, and sends nothing.",
    "Values starting with '-' must use --flag=value (--summary=\"- x\").",
    "",
    "Read commands:",
    ...READ_CMDS.map(row),
    "",
    "Write commands (all accept --dry-run):",
    ...Object.keys(COMMANDS).filter((k) => !READ_CMDS.includes(k)).map(row),
  ].join("\n");
}

/* ------------------------------------------------------------------ main */

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl } = {}) {
  const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  let json = argv.includes("--json");
  let client = null;
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTION_TYPES, allowPositionals: true, strict: true });
    } catch (e) {
      throw usageErr(`${e.message}\nRun "jira --help" for usage.`);
    }
    const { values: v, positionals } = parsed;
    json = !!v.json;
    if (!positionals.length) {
      out(helpText());
      return 0;
    }
    const two = positionals.slice(0, 2).join(" ");
    const name = COMMANDS[two] ? two : COMMANDS[positionals[0]] ? positionals[0] : null;
    if (!name) {
      const known = Object.keys(COMMANDS).filter((k) => k.startsWith(positionals[0]));
      throw usageErr(`Unknown command "${positionals[0]}".${known.length ? ` Did you mean: ${known.join(", ")}?` : ""}\nRun "jira --help".`);
    }
    if (v.help) {
      out(helpText(name));
      return 0;
    }
    const cmd = COMMANDS[name];
    const allowed = new Set([...cmd.opts, ...GLOBAL_OPTS]);
    const extra = Object.keys(v).filter((k) => !allowed.has(k));
    if (extra.length) throw usageErr(`Flag(s) not valid for "${name}": ${extra.map((k) => `--${k}`).join(", ")}.\nUsage: jira ${cmd.usage}`);
    const pos = positionals.slice(name.split(" ").length);

    client = new Client(loadCreds(env), { dryRun: !!v["dry-run"], fetchImpl });

    const result = await cmd.run({ client, pos, v, env });
    const failedCode = result.failed ? 1 : 0;

    if (v["dry-run"] && (client.planned.length || client.intents.length) && !READ_CMDS.includes(name)) {
      out(json ? JSON.stringify({ dryRun: true, intents: client.intents, requests: client.planned }) : dryRunText(client));
    } else {
      out(json || result.forceJson ? JSON.stringify(result.data) : result.text);
    }
    return failedCode;
  } catch (e) {
    const status = e instanceof JiraError ? e.status : undefined;
    const raw = e?.message ?? String(e);
    const message = client ? client.redact(raw) : raw;
    stderr.write(`${json ? JSON.stringify({ error: message, status, code: e?.code }) : `Error: ${message}`}\n`);
    return e?.code === "usage" ? 2 : 1;
  }
}

