/** ADF flattening and compact text renderers. Text is the default output; --json bypasses all of this. */

export const day = (s) => (s ? String(s).split("T")[0] : "?");

export function fmtSize(n) {
  if (n === undefined || n === null || !Number.isFinite(n)) return "?";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Flatten Atlassian Document Format to plain text.
 * The v3 endpoints return rich text as ADF; v2 returns a plain string.
 */
export function adfToText(node, depth = 0) {
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

export const descText = (d) => (typeof d === "string" ? d : d ? adfToText(d).replace(/\n{3,}/g, "\n\n").trim() : "");

/**
 * Fields shown on a bug's "Details" tab. They are custom fields whose ids differ per site/project,
 * so they are matched by display name (from `expand=names`), in this order.
 */
const DETAIL_FIELD_NAMES = ["Environment", "Preconditions", "Steps to Reproduce", "Expected Result", "Actual Result"];

/** Render a field value (string, ADF, option, array of options) as plain text. */
export function fieldText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (v.type === "doc" || Array.isArray(v.content)) return descText(v);
  return String(v.value ?? v.name ?? v.displayName ?? "").trim();
}

/** Collect the "Details" tab fields of an issue (empty ones skipped). */
export function detailSections(fields, names) {
  const byName = new Map();
  for (const [id, name] of Object.entries(names ?? {})) byName.set(String(name).toLowerCase(), id);
  const out = [];
  for (const label of DETAIL_FIELD_NAMES) {
    const id = byName.get(label.toLowerCase());
    const text = id ? fieldText(fields?.[id]) : "";
    if (text) out.push("", `${label}:`, text);
  }
  return out;
}

export function issueLine(i) {
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

export function counts(issues, pick) {
  const m = new Map();
  for (const i of issues) {
    const k = pick(i.fields ?? {});
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

export const attLine = (a) =>
  `  [${a.id}] ${a.filename} (${a.mimeType ?? "?"}, ${fmtSize(a.size)}, ${a.author?.displayName ?? "?"}, ${day(a.created)})`;

export function showText(issue, baseUrl) {
  const f = issue.fields ?? {};
  const links = (f.issuelinks ?? [])
    .map((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      const dir = l.outwardIssue ? l.type?.outward : l.type?.inward;
      return other ? `  ${dir} ${other.key} (${other.fields?.summary ?? ""})` : null;
    })
    .filter(Boolean);
  return [
    `Issue:    ${issue.key}`,
    `URL:      ${baseUrl}/browse/${issue.key}`,
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
    ...(Array.isArray(f.attachment) && f.attachment.length
      ? ["Attachments (download: attachment get <id>):", ...f.attachment.map(attLine)]
      : []),
    "",
    "Description:",
    descText(f.description) || "No description",
    ...detailSections(f, issue.names ?? {}),
  ].join("\n");
}

export function duplicatesText({ clusters, pairCount, compared }, { scope, scanned, truncated, threshold }) {
  const head = [
    `Duplicate scan - scope: ${scope}`,
    `Scanned ${scanned} issues${truncated ? " (TRUNCATED - raise --limit to cover the whole backlog)" : ""}, ${compared} pairs compared, threshold ${threshold}`,
    `Found ${clusters.length} candidate cluster(s) from ${pairCount} matching pair(s).`,
    "",
    "Scores are lexical similarity of summary (+description), NOT a verdict - review each cluster before acting.",
  ];
  if (!clusters.length) return [...head, `No pairs at or above ${threshold}. Retry with a lower threshold (e.g. --threshold ${(threshold - 0.1).toFixed(2)}).`].join("\n");
  const CAP = 40;
  const blocks = clusters.slice(0, CAP).map((c, n) => {
    const rows = c.members
      .slice()
      .sort((a, b) => a.created.localeCompare(b.created))
      .map((m) => {
        const mark = m.key === c.canonical.key ? "*" : " ";
        const dup = m.dupLinks.size ? ` [dup-linked: ${[...m.dupLinks].join(",")}]` : "";
        return `   ${mark} ${m.key}  ${m.type}/${m.status}  created ${m.created}  ${m.assignee}${dup}\n       "${m.summary}"`;
      });
    const others = c.members.filter((m) => m.key !== c.canonical.key).map((m) => m.key);
    return [
      `Cluster ${n + 1} - ${c.members.length} issues, max score ${c.maxScore.toFixed(2)}${c.alreadyLinked ? "  [already linked as duplicates - likely nothing to do]" : ""}`,
      ...rows,
      c.siblingSeries
        ? `   WARNING: every issue has a unique term (${c.distinct.map((d) => `${d.key}: ${d.only.slice(0, 3).join("/")}`).join("; ")}) - this looks like a TEMPLATE SERIES (same wording, different target), not duplicates. Verify before closing.`
        : "   no distinguishing terms between these issues - strong duplicate signal",
      `   suggested canonical: ${c.canonical.key} (most progressed / most linked / oldest)`,
      `   cleanup: jira link ${others.join(" ")} --type duplicates --target ${c.canonical.key}`,
    ].join("\n");
  });
  return `${head.join("\n")}\n\n${blocks.join("\n\n")}${clusters.length > CAP ? `\n\n(+${clusters.length - CAP} more clusters not shown - raise --threshold to narrow.)` : ""}`;
}

export function dryRunText(client) {
  const out = ["DRY RUN: nothing was sent."];
  for (const i of client.intents) out.push(`  ${i}`);
  out.push("Requests that would be sent:");
  for (const r of client.planned) {
    const bits = [`  ${r.method} ${r.path}`];
    if (r.body !== undefined) bits.push(` ${JSON.stringify(r.body)}`);
    if (r.files?.length) bits.push(` multipart file(s)=${r.files.join(", ")}`);
    out.push(bits.join(""));
  }
  return out.join("\n");
}
