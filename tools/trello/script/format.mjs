/** Compact text renderers. Text is the default output (token-cheap); --json bypasses all of this. */

export const fmtDue = (c) => (c.due ? `${c.due.slice(0, 16)}Z${c.dueComplete ? " done" : ""}` : "");
export const fmtDay = (iso) => (iso ? iso.slice(0, 10) : "?");

export function fmtSize(n) {
  if (!Number.isFinite(n)) return "?";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export const labelText = (l) => l.name || `(${l.color ?? "no color"})`;

/** One card per line. `users` maps member id → username (optional). */
export function cardLine(c, users = {}, extra = {}) {
  const parts = [`[${c.shortLink ?? c.id}] ${c.name}`];
  if (extra.list) parts.push(`list: ${extra.list}`);
  if (extra.board) parts.push(`board: ${extra.board}`);
  if (c.due) parts.push(`due ${fmtDue(c)}`);
  if (c.labels?.length) parts.push(c.labels.map(labelText).join(","));
  const who = (c.idMembers ?? []).map((id) => (users[id] ? `@${users[id]}` : null)).filter(Boolean);
  if (who.length) parts.push(who.join(" "));
  if (c.closed) parts.push("ARCHIVED");
  return parts.join(" | ");
}

export function boardsText(boards) {
  if (!boards.length) return "No boards.";
  return [`Boards (${boards.length}):`, ...boards.map((b) => `  [${b.shortLink}] ${b.name}${b.closed ? " (closed)" : ""}  last activity ${fmtDay(b.dateLastActivity)}  ${b.url ?? ""}`.trimEnd())].join("\n");
}

export function listsText(board, lists) {
  return [`Lists on "${board.name}" (${lists.length}):`, ...lists.map((l) => `  ${l.id}  ${l.name}${l.closed ? " (archived)" : ""}`)].join("\n");
}

export function boardOverview(board, lists, users, perList) {
  const total = lists.reduce((n, l) => n + (l.cards?.length ?? 0), 0);
  const out = [`Board "${board.name}" [${board.shortLink}] ${board.url ?? ""}`.trimEnd(), `${lists.length} lists, ${total} open cards`, ""];
  for (const l of lists) {
    const cards = l.cards ?? [];
    out.push(`## ${l.name}  (list id ${l.id}, ${cards.length} cards)`);
    for (const c of cards.slice(0, perList)) out.push(`  ${cardLine(c, users)}`);
    if (cards.length > perList) out.push(`  ... ${cards.length - perList} more (use: cards --board ... --list "${l.name}" --limit N)`);
  }
  return out.join("\n");
}

export function cardDetail(c, comments, users = {}) {
  const out = [`[${c.shortLink}] ${c.name}`, `url: ${c.url}`];
  out.push(`board: ${c.board?.name ?? c.idBoard} | list: ${c.list?.name ?? c.idList} | ${c.closed ? "ARCHIVED" : "open"}`);
  if (c.due) out.push(`due: ${fmtDue(c)}`);
  if (c.labels?.length) out.push(`labels: ${c.labels.map((l) => `${labelText(l)}${l.name && l.color ? ` (${l.color})` : ""}`).join(", ")}`);
  const members = (c.members ?? []).map((m) => `@${m.username}`);
  if (members.length) out.push(`members: ${members.join(", ")}`);
  out.push(`last activity: ${c.dateLastActivity ?? "?"}`);
  out.push("description:", c.desc ? indent(c.desc) : "  (none)");
  for (const cl of c.checklists ?? []) {
    const items = cl.checkItems ?? [];
    const done = items.filter((i) => i.state === "complete").length;
    out.push(`checklist "${cl.name}" (id ${cl.id}) ${done}/${items.length}`);
    for (const i of items) out.push(`  [${i.state === "complete" ? "x" : " "}] ${i.name}  (id ${i.id})`);
  }
  if (c.attachments?.length) {
    out.push(`attachments (${c.attachments.length}):`);
    for (const a of c.attachments) out.push(`  ${a.id}  ${a.name}${a.isUpload ? `  ${fmtSize(a.bytes)}  ${a.mimeType ?? ""}` : "  (link)"}  ${a.url}`.trimEnd());
  }
  if (comments?.length) {
    out.push(`comments (latest ${comments.length}, newest first):`);
    for (const a of comments) out.push(`  ${fmtDay(a.date)} ${a.memberCreator?.fullName ?? a.memberCreator?.username ?? "?"}: ${oneLine(a.data?.text, 600)}`);
  }
  return out.join("\n");
}

export function searchText(cards, query) {
  if (!cards.length) return `No cards match "${query}".`;
  return [`${cards.length} card(s) match "${query}":`, ...cards.map((c) => `  ${cardLine(c, {}, { board: c.board?.name, list: c.list?.name })}`)].join("\n");
}

export function attachmentsText(atts) {
  if (!atts.length) return "No attachments.";
  return [`Attachments (${atts.length}):`, ...atts.map((a) => `  ${a.id}  ${a.name}${a.isUpload ? `  ${fmtSize(a.bytes)}  ${a.mimeType ?? ""}` : "  (link)"}  ${a.url}`.trimEnd())].join("\n");
}

export function dryRunText(client) {
  const out = ["DRY RUN: nothing was sent."];
  for (const i of client.intents) out.push(`  ${i}`);
  out.push("Requests that would be sent:");
  for (const r of client.planned) {
    const bits = [`  ${r.method} ${r.path}`];
    if (r.query && Object.keys(r.query).length) bits.push(`?${JSON.stringify(r.query)}`);
    if (r.body !== undefined) bits.push(` ${JSON.stringify(r.body)}`);
    if (r.file) bits.push(` file=${r.file}`);
    out.push(bits.join(""));
  }
  return out.join("\n");
}

const indent = (s) => s.split("\n").map((l) => `  ${l}`).join("\n");
const oneLine = (s = "", max = 300) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};
