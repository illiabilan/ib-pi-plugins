/**
 * Turn human references (names, URLs, short links) into Trello ids.
 * Ambiguity is always an error that lists the candidates; nothing is guessed.
 */
import { TrelloError } from "./client.mjs";

export const HEX24 = /^[0-9a-f]{24}$/i;
export const SHORT = /^[A-Za-z0-9]{8}$/;

/** Extract the short link from a trello.com/b/<id>/... or /c/<id>/... URL; otherwise return the input. */
export function stripUrl(ref) {
  const m = String(ref).match(/trello\.com\/[bc]\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(ref).trim();
}

/** Pick one item by exact (case-insensitive) name, then by unique substring. */
export function pickByName(items, ref, kind, nameOf = (x) => x.name, describe = (x) => `${nameOf(x)} (${x.id})`) {
  const q = String(ref).trim().toLowerCase();
  const exact = items.filter((x) => String(nameOf(x) ?? "").toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const pool = exact.length > 1 ? exact : items.filter((x) => String(nameOf(x) ?? "").toLowerCase().includes(q));
  if (pool.length === 1) return pool[0];
  if (!pool.length) {
    const avail = items.slice(0, 25).map((x) => `  - ${describe(x)}`).join("\n");
    throw new TrelloError(`No ${kind} matches "${ref}".${items.length ? `\nAvailable:\n${avail}` : ""}`, { code: "no_match" });
  }
  throw new TrelloError(
    `"${ref}" matches ${pool.length} ${kind}s, be more specific or use the id:\n${pool.slice(0, 15).map((x) => `  - ${describe(x)}`).join("\n")}`,
    { code: "ambiguous" },
  );
}

export async function resolveBoard(client, ref, env = process.env) {
  const raw = ref || env.TRELLO_BOARD;
  if (!raw) throw new TrelloError("A board is required: pass --board <name|id|url> or set TRELLO_BOARD.", { code: "usage" });
  const r = stripUrl(raw);
  if (HEX24.test(r) || SHORT.test(r)) {
    try {
      const b = await client.get(`/boards/${r}`, { fields: "name,shortLink,url,closed" });
      return { id: b.id, name: b.name, shortLink: b.shortLink, url: b.url };
    } catch (e) {
      // An 8-char word such as "Personal" is also a valid name: fall through to name matching.
      if (!(SHORT.test(r) && (e.status === 404 || e.status === 400))) throw e;
    }
  }
  const boards = await client.get("/members/me/boards", { filter: "open", fields: "name,shortLink,url" });
  const b = pickByName(boards, r, "board", (x) => x.name, (x) => `${x.name} [${x.shortLink}]`);
  return { id: b.id, name: b.name, shortLink: b.shortLink, url: b.url };
}

export async function resolveList(client, ref, board) {
  if (!ref) throw new TrelloError("A list is required: pass --list <name|id>.", { code: "usage" });
  if (HEX24.test(ref)) {
    const l = await client.get(`/lists/${ref}`, { fields: "name,idBoard" });
    return { id: l.id, name: l.name, idBoard: l.idBoard };
  }
  if (!board) throw new TrelloError(`Resolving list "${ref}" by name needs a board: pass --board <name|id|url> (or use the list id).`, { code: "usage" });
  const lists = await client.get(`/boards/${board.id}/lists`, { filter: "open", fields: "name" });
  const l = pickByName(lists, ref, "list");
  return { id: l.id, name: l.name, idBoard: board.id };
}

/** Card info needed by write commands: full id, name, board id. */
export async function cardInfo(client, ref) {
  if (!ref) throw new TrelloError("A card is required (short link, id or trello.com/c/... URL).", { code: "usage" });
  const c = await client.get(`/cards/${stripUrl(ref)}`, { fields: "name,idBoard,idList,idLabels,idMembers,shortLink,url,closed" });
  return c;
}

export async function resolveLabels(client, boardId, refs) {
  if (!refs.length) return [];
  const labels = await client.get(`/boards/${boardId}/labels`, { fields: "name,color", limit: 1000 });
  return refs.map((ref) => {
    const byId = labels.find((l) => l.id === ref);
    if (byId) return byId;
    const named = labels.filter((l) => (l.name || "").toLowerCase() === ref.toLowerCase());
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new TrelloError(`Label "${ref}" is ambiguous on this board (${named.map((l) => l.id).join(", ")}). Use an id.`, { code: "ambiguous" });
    // Unnamed labels are shown by color only.
    const colored = labels.filter((l) => !l.name && l.color === ref.toLowerCase());
    if (colored.length === 1) return colored[0];
    throw new TrelloError(
      `No label "${ref}" on this board.\nAvailable: ${labels.map((l) => l.name || `(${l.color})`).join(", ") || "(none)"}`,
      { code: "no_match" },
    );
  });
}

export async function resolveMembers(client, boardId, refs) {
  if (!refs.length) return [];
  const members = await client.get(`/boards/${boardId}/members`, { fields: "username,fullName" });
  return refs.map((ref) => {
    const r = ref.replace(/^@/, "");
    const hit =
      members.find((m) => m.id === r) ||
      members.find((m) => m.username.toLowerCase() === r.toLowerCase()) ||
      pickByName(members, r, "member", (m) => m.fullName, (m) => `@${m.username} (${m.fullName})`);
    return hit;
  });
}
