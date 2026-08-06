/**
 * Jira extension for pi.
 *
 * Configuration comes ONLY from environment variables (never hardcoded):
 *   JIRA_USERNAME   your Atlassian account email        (required)
 *   JIRA_API_TOKEN  Atlassian API token                 (required)
 *   JIRA_URL        instance base URL                   (optional, default https://grubhub.atlassian.net)
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

const DEFAULT_URL = "https://grubhub.atlassian.net";
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

async function api(
  creds: Creds,
  version: 2 | 3,
  endpoint: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResult> {
  const auth = Buffer.from(`${creds.username}:${creds.token}`).toString("base64");
  const res = await fetch(`${creds.url}/rest/api/${version}/${endpoint}`, {
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

const actionEnum = [
  "show",
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
        "show=one issue; list=my issues; search=JQL; projects; me; stats; sprint_stats; link_types; createmeta=creatable fields; create; update; link; test_token",
    },
  ),
  issue_key: Type.Optional(Type.String({ description: "Issue key, e.g. ADA-123. For show/update/link (source)." })),
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "jira",
    label: "Jira",
    description: `Query and modify Jira issues over the REST API (credentials from JIRA_USERNAME / JIRA_API_TOKEN / JIRA_URL env vars).

Read actions: show (one issue with description), list (issues assigned to you), search (JQL), projects, me, stats, sprint_stats, link_types, createmeta, test_token.
Write actions: create, update, link. These mutate real shared Jira state — only call them after the user has seen the exact payload and explicitly approved it. In interactive sessions jira also asks the user to confirm each write.

Prefer jira over running curl/jira_cli.sh in bash for anything Jira — it needs no shell profile sourcing and returns compact pre-formatted text.
Examples:
  {"action":"show","issue_key":"ADA-123"}
  {"action":"search","jql":"project = ADA AND status = \\"In Progress\\"","limit":20}
  {"action":"createmeta","project":"ADA","issue_type":"Story"}
  {"action":"create","fields":{"project":{"key":"ADA"},"issuetype":{"name":"Story"},"summary":"My ticket"}}
  {"action":"update","issue_key":"ADA-123","fields":{"summary":"New title"}}
  {"action":"link","issue_key":"ADA-123","link_type":"blocks","target_key":"ADA-124"}

Every result ends with a "config_source:" marker: "env" means credentials came from the process environment (normal); "shell-profile" means they were recovered by probing a login shell, which is slower and means the user's env was not inherited — mention it if they hit auth problems.`,
    promptSnippet: "Read/search/create/update/link Jira issues via the Jira REST API",
    promptGuidelines: [
      "jira actions create, update and link mutate real shared Jira state: never call them until the user has seen the exact payload/relationship in a message and explicitly approved it. Present a preview and stop instead of calling; after a change request, show the revised preview again rather than writing.",
      "Use jira for ALL Jira access (reading, searching, creating, updating, linking issues) instead of bash+curl or any jira_cli.sh script; it reads credentials from JIRA_USERNAME/JIRA_API_TOKEN env vars itself and needs no shell profile sourcing.",
      "When the user mentions an issue key like ADA-123 or BOF-205 and wants information about it, call jira with {action:'show', issue_key:'ADA-123'} before answering rather than guessing.",
      "Before jira action='create' on an unfamiliar project, call jira action='createmeta' with the project (and issue_type) to learn required/custom field ids instead of guessing field names.",
      "If jira returns an auth error (HTTP 401/403), tell the user to regenerate their Atlassian API token and re-export JIRA_API_TOKEN in their shell profile — do not retry blindly.",
      "If a jira result reports config_source: shell-profile, note that pi did not inherit the Jira env vars and the user should restart pi from a shell where their profile is loaded.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const WRITE_ACTIONS = new Set(["create", "update", "link"]);
      if (WRITE_ACTIONS.has(params.action) && ctx.hasUI) {
        const summary =
          params.action === "link"
            ? `${params.issue_key} ${params.link_type} ${params.target_key}`
            : `${params.issue_key ?? "new issue"}: ${JSON.stringify(unwrapFields(params.fields) ?? {}).slice(0, 800)}`;
        const approved = await ctx.ui.confirm(`Jira ${params.action}`, summary);
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
            if (!params.issue_key) return bad("issue_key is required for action=show (e.g. ADA-123).");
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
                typeof f.description === "string" && f.description.trim()
                  ? f.description
                  : f.description
                    ? JSON.stringify(f.description)
                    : "No description",
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
            const r = await searchJql(creds, params.jql, limit, ["summary", "status", "assignee", "priority"], signal);
            if (!r.ok) return fin(errText(r), true);
            const issues = r.json?.issues ?? [];
            if (!issues.length) return fin(`No issues matched: ${params.jql}`);
            return fin(
              `Search: ${params.jql}\nResults (${issues.length} shown${
                r.json.total !== undefined ? `, ${r.json.total} total` : ""
              }):\n\n${issues.map(issueLine).join("\n\n")}`,
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
            if (!params.issue_key || !params.link_type || !params.target_key)
              return bad(
                "action=link requires issue_key (source), link_type and target_key. link_type: " +
                  Object.keys(LINK_SHORTCUTS).join(" | ") +
                  " or a raw Jira link type name (see action=link_types).",
              );
            const sc = LINK_SHORTCUTS[params.link_type.toLowerCase()];
            const typeName = sc?.type ?? params.link_type;
            // Raw type names: source is sent as inwardIssue, i.e. source reads with the
            // type's OUTWARD phrase (check action=link_types to confirm the wording).
            const sourceIsInward = sc ? sc.sourceIsInward : true;
            const inward = sourceIsInward ? params.issue_key : params.target_key;
            const outward = sourceIsInward ? params.target_key : params.issue_key;
            const r = await api(
              creds,
              2,
              "issueLink",
              "POST",
              { type: { name: typeName }, inwardIssue: { key: inward }, outwardIssue: { key: outward } },
              signal,
            );
            if (!r.ok) return fin(`Failed to link ${params.issue_key} ${params.link_type} ${params.target_key}.\n${errText(r)}`, true);
            return fin(
              `Linked: ${params.issue_key} ${params.link_type} ${params.target_key} (Jira link type "${typeName}")`,
            );
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
      const bits = [
        args.issue_key,
        args.jql && `"${args.jql}"`,
        args.project && `${args.project}${args.issue_type ? `/${args.issue_type}` : ""}`,
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
