import { parseArgs } from "node:util";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Client, TrelloError, loadCreds } from "./client.mjs";
import { cardInfo, pickByName, resolveBoard, resolveLabels, resolveList, resolveMembers, stripUrl, HEX24 } from "./resolve.mjs";
import {
  attachmentsText,
  boardOverview,
  boardsText,
  cardDetail,
  cardLine,
  dryRunText,
  fmtSize,
  listsText,
  searchText,
} from "./format.mjs";

const CARD_FIELDS = "name,due,dueComplete,labels,idMembers,shortLink,idList,closed";

/** Superset of every flag. Each command declares which subset it accepts (typos fail loudly). */
const OPTION_TYPES = {
  board: { type: "string" },
  list: { type: "string" },
  name: { type: "string" },
  desc: { type: "string" },
  "desc-file": { type: "string" },
  "desc-stdin": { type: "boolean" },
  due: { type: "string" },
  "clear-due": { type: "boolean" },
  complete: { type: "boolean" },
  incomplete: { type: "boolean" },
  label: { type: "string", multiple: true },
  member: { type: "string", multiple: true },
  add: { type: "string", multiple: true },
  remove: { type: "string", multiple: true },
  pos: { type: "string" },
  limit: { type: "string" },
  "per-list": { type: "string" },
  comments: { type: "string" },
  query: { type: "string" },
  all: { type: "boolean" },
  yes: { type: "boolean" },
  file: { type: "string" },
  stdin: { type: "boolean" },
  url: { type: "string" },
  out: { type: "string" },
  item: { type: "string", multiple: true },
  param: { type: "string", multiple: true },
  data: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const GLOBAL_OPTS = ["json", "dry-run", "help"];

const usageErr = (m) => new TrelloError(m, { code: "usage" });
const csv = (arr = []) => arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
const intFlag = (v, def, name) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw usageErr(`--${name} must be a non-negative integer, got "${v}".`);
  return n;
};
const need = (v, what) => {
  if (v === undefined || v === "") throw usageErr(`Missing ${what}.`);
  return v;
};

/** Trello wants ISO-8601. A bare date becomes 12:00 UTC so it displays as the same day in most timezones. */
export function parseDue(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw usageErr(`Invalid --due "${s}". Use YYYY-MM-DD or an ISO-8601 timestamp.`);
  return new Date(t).toISOString();
}

const parsePos = (s) => (s === undefined ? undefined : /^\d+(\.\d+)?$/.test(s) ? Number(s) : s === "top" || s === "bottom" ? s : (() => { throw usageErr(`--pos must be top, bottom or a number, got "${s}".`); })());

/** Text from a flag, a file or stdin. Returns undefined when none was given. */
function readText(v, valueKey, fileKey, stdinKey) {
  const given = [valueKey, fileKey, stdinKey].filter((k) => k && v[k] !== undefined && v[k] !== false);
  if (given.length > 1) throw usageErr(`Use only one of ${[valueKey, fileKey, stdinKey].filter(Boolean).map((k) => `--${k}`).join(", ")}.`);
  if (valueKey && v[valueKey] !== undefined) return v[valueKey];
  if (fileKey && v[fileKey] !== undefined) return readFileSync(expand(v[fileKey]), "utf8");
  if (stdinKey && v[stdinKey]) return readFileSync(0, "utf8");
  return undefined;
}
const expand = (p) => resolvePath(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const cardUrlLine = (c) => `[${c.shortLink}] "${c.name}" ${c.url ?? ""}`.trimEnd();

/* ------------------------------------------------------------------ commands */

const COMMANDS = {
  auth: {
    usage: "auth",
    desc: "Print how to obtain TRELLO_API_KEY and TRELLO_TOKEN. Makes no API call.",
    opts: [],
    noClient: true,
    async run({ env }) {
      const key = env.TRELLO_API_KEY;
      const lines = [
        "1. Create a Power-Up at https://trello.com/power-ups/admin and copy its API key.",
        '2. export TRELLO_API_KEY="<key>"',
        "3. Open this URL while logged in, click Allow, copy the token:",
        key
          ? `   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=trello&key=${encodeURIComponent(key)}`
          : "   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=trello&key=<key>",
        '4. export TRELLO_TOKEN="<token>"',
        "5. Verify: trello me",
        "Use expiration=30days for a short-lived token. Scope read,write is required for any write command.",
      ];
      return { data: { key_set: !!key }, text: lines.join("\n") };
    },
  },

  me: {
    usage: "me",
    desc: "Show the authenticated member (also verifies credentials).",
    opts: [],
    async run({ client }) {
      const m = await client.get("/members/me", { fields: "username,fullName,url" });
      return { data: m, text: `@${m.username} (${m.fullName}) id ${m.id} ${m.url ?? ""}`.trimEnd() };
    },
  },

  boards: {
    usage: "boards [--query <text>] [--all]",
    desc: "List your boards (open by default; --all includes closed). --query filters by name.",
    opts: ["query", "all"],
    async run({ client, v }) {
      let boards = await client.get("/members/me/boards", { filter: v.all ? "all" : "open", fields: "name,shortLink,url,closed,dateLastActivity" });
      if (v.query) boards = boards.filter((b) => b.name.toLowerCase().includes(v.query.toLowerCase()));
      boards.sort((a, b) => String(b.dateLastActivity).localeCompare(String(a.dateLastActivity)));
      return { data: boards, text: boardsText(boards) };
    },
  },

  board: {
    usage: "board <board> [--per-list N]",
    desc: "Board overview: every open list with its cards (default 30 cards per list). <board> is a name, short link, id or URL.",
    opts: ["per-list"],
    async run({ client, pos, v, env }) {
      const board = await resolveBoard(client, pos[0], env);
      const [lists, members] = await Promise.all([
        client.get(`/boards/${board.id}/lists`, { filter: "open", fields: "name", cards: "open", card_fields: CARD_FIELDS }),
        client.get(`/boards/${board.id}/members`, { fields: "username" }),
      ]);
      const users = Object.fromEntries(members.map((m) => [m.id, m.username]));
      return { data: { board, lists }, text: boardOverview(board, lists, users, intFlag(v["per-list"], 30, "per-list")) };
    },
  },

  lists: {
    usage: "lists <board> [--all]",
    desc: "List the lists of a board with their ids (--all includes archived lists).",
    opts: ["all"],
    async run({ client, pos, v, env }) {
      const board = await resolveBoard(client, pos[0], env);
      const lists = await client.get(`/boards/${board.id}/lists`, { filter: v.all ? "all" : "open", fields: "name,closed" });
      return { data: lists, text: listsText(board, lists) };
    },
  },

  "list create": {
    usage: 'list create <name> --board <board> [--pos top|bottom|N]',
    desc: "Create a list on a board.",
    opts: ["board", "pos"],
    async run({ client, pos, v, env }) {
      const name = need(pos[0], "list name");
      const board = await resolveBoard(client, v.board, env);
      client.intent(`Create list "${name}" on board "${board.name}"`);
      const l = await client.post("/lists", { name, idBoard: board.id, pos: parsePos(v.pos) });
      return { data: l, text: `Created list "${name}" (id ${l.id}) on "${board.name}".` };
    },
  },

  "list archive": {
    usage: "list archive <list> --board <board>",
    desc: "Archive a list (reversible in the Trello UI).",
    opts: ["board"],
    async run({ client, pos, v, env }) {
      const board = HEX24.test(pos[0] ?? "") ? undefined : await resolveBoard(client, v.board, env);
      const list = await resolveList(client, need(pos[0], "list"), board);
      client.intent(`Archive list "${list.name}"`);
      await client.put(`/lists/${list.id}/closed`, { value: true });
      return { data: { id: list.id, closed: true }, text: `Archived list "${list.name}".` };
    },
  },

  cards: {
    usage: "cards --board <board> [--list <list>] [--limit N]",
    desc: "List open cards of a board, or of one list (default limit 50).",
    opts: ["board", "list", "limit"],
    async run({ client, v, env }) {
      const limit = intFlag(v.limit, 50, "limit");
      const board = await resolveBoard(client, v.board, env);
      const [members, lists] = await Promise.all([
        client.get(`/boards/${board.id}/members`, { fields: "username" }),
        client.get(`/boards/${board.id}/lists`, { filter: "open", fields: "name" }),
      ]);
      const users = Object.fromEntries(members.map((m) => [m.id, m.username]));
      const listName = Object.fromEntries(lists.map((l) => [l.id, l.name]));
      let cards;
      if (v.list) {
        const list = await resolveList(client, v.list, board);
        cards = await client.get(`/lists/${list.id}/cards`, { fields: CARD_FIELDS });
      } else {
        cards = await client.get(`/boards/${board.id}/cards`, { filter: "open", fields: CARD_FIELDS });
      }
      const shown = cards.slice(0, limit);
      const lines = shown.map((c) => cardLine(c, users, v.list ? {} : { list: listName[c.idList] }));
      const more = cards.length > shown.length ? `\n... ${cards.length - shown.length} more (raise --limit)` : "";
      const head = `${cards.length} card(s) on "${board.name}"${v.list ? ` in list "${v.list}"` : ""}${cards.length ? ":" : "."}`;
      return { data: shown, text: [head, ...lines.map((l) => `  ${l}`)].join("\n") + more };
    },
  },

  card: {
    usage: "card <card> [--comments N]",
    desc: "Show one card: description, labels, members, checklists, attachments and the latest comments (default 5). <card> is a short link, id or URL.",
    opts: ["comments"],
    async run({ client, pos, v }) {
      const ref = stripUrl(need(pos[0], "card"));
      const n = intFlag(v.comments, 5, "comments");
      const [card, comments] = await Promise.all([
        client.get(`/cards/${ref}`, {
          fields: "name,desc,due,dueComplete,idList,idBoard,labels,shortLink,url,closed,dateLastActivity",
          members: true,
          member_fields: "username,fullName",
          checklists: "all",
          attachments: true,
          attachment_fields: "name,url,bytes,mimeType,isUpload,date",
          board: true,
          board_fields: "name",
          list: true,
          list_fields: "name",
        }),
        n ? client.get(`/cards/${ref}/actions`, { filter: "commentCard", limit: n }) : Promise.resolve([]),
      ]);
      return { data: { card, comments }, text: cardDetail(card, comments) };
    },
  },

  comments: {
    usage: "comments <card> [--limit N]",
    desc: "Show the latest comments of a card (default 20, newest first).",
    opts: ["limit"],
    async run({ client, pos, v }) {
      const ref = stripUrl(need(pos[0], "card"));
      const limit = intFlag(v.limit, 20, "limit");
      const acts = await client.get(`/cards/${ref}/actions`, { filter: "commentCard", limit });
      const text = acts.length
        ? acts.map((a) => `${a.date?.slice(0, 16)}Z ${a.memberCreator?.fullName ?? "?"}:\n${(a.data?.text ?? "").split("\n").map((l) => `  ${l}`).join("\n")}`).join("\n")
        : "No comments.";
      return { data: acts, text };
    },
  },

  "card create": {
    usage: 'card create <name> --board <board> --list <list> [--desc T | --desc-file F | --desc-stdin] [--due D] [--label a,b] [--member u1,u2] [--pos top|bottom|N]',
    desc: "Create a card. Labels and members are resolved by name on the board.",
    opts: ["board", "list", "desc", "desc-file", "desc-stdin", "due", "label", "member", "pos"],
    async run({ client, pos, v, env }) {
      const name = need(pos[0], "card name");
      const board = await resolveBoard(client, v.board, env);
      const list = await resolveList(client, v.list, board);
      const labels = await resolveLabels(client, board.id, csv(v.label));
      const members = await resolveMembers(client, board.id, csv(v.member));
      const desc = readText(v, "desc", "desc-file", "desc-stdin");
      const body = {
        idList: list.id,
        name,
        desc,
        due: v.due ? parseDue(v.due) : undefined,
        idLabels: labels.length ? labels.map((l) => l.id).join(",") : undefined,
        idMembers: members.length ? members.map((m) => m.id).join(",") : undefined,
        pos: parsePos(v.pos),
      };
      client.intent(
        `Create card "${name}" in list "${list.name}" of board "${board.name}"` +
          (labels.length ? `, labels: ${labels.map((l) => l.name || l.color).join(",")}` : "") +
          (members.length ? `, members: ${members.map((m) => `@${m.username}`).join(",")}` : "") +
          (body.due ? `, due ${body.due}` : ""),
      );
      const c = await client.post("/cards", body);
      return { data: c, text: `Created card ${cardUrlLine({ ...c, name })} in "${list.name}".` };
    },
  },

  "card update": {
    usage: "card update <card> [--name N] [--desc T | --desc-file F | --desc-stdin] [--due D | --clear-due] [--complete | --incomplete]",
    desc: "Change a card's name, description or due date. --complete / --incomplete toggle the due-date check mark.",
    opts: ["name", "desc", "desc-file", "desc-stdin", "due", "clear-due", "complete", "incomplete"],
    async run({ client, pos, v }) {
      if (v.due && v["clear-due"]) throw usageErr("Use either --due or --clear-due.");
      if (v.complete && v.incomplete) throw usageErr("Use either --complete or --incomplete.");
      const body = {};
      if (v.name !== undefined) body.name = v.name;
      const desc = readText(v, "desc", "desc-file", "desc-stdin");
      if (desc !== undefined) body.desc = desc;
      if (v.due) body.due = parseDue(v.due);
      if (v["clear-due"]) body.due = null;
      if (v.complete) body.dueComplete = true;
      if (v.incomplete) body.dueComplete = false;
      if (!Object.keys(body).length) throw usageErr("Nothing to update: pass at least one of --name, --desc, --due, --clear-due, --complete, --incomplete.");
      const info = await cardInfo(client, pos[0]);
      client.intent(`Update card [${info.shortLink}] "${info.name}": ${Object.keys(body).join(", ")}`);
      await client.put(`/cards/${info.id}`, body);
      return { data: { id: info.id, updated: Object.keys(body) }, text: `Updated ${Object.keys(body).join(", ")} on [${info.shortLink}] "${body.name ?? info.name}".` };
    },
  },

  "card move": {
    usage: "card move <card> --list <list> [--board <board>] [--pos top|bottom|N]",
    desc: "Move a card to a list. The list is looked up on the card's current board unless --board is given.",
    opts: ["list", "board", "pos"],
    async run({ client, pos, v, env }) {
      const info = await cardInfo(client, pos[0]);
      const board = v.board ? await resolveBoard(client, v.board, env) : { id: info.idBoard, name: info.idBoard };
      const list = await resolveList(client, need(v.list, "--list"), board);
      const body = { idList: list.id, pos: parsePos(v.pos) };
      if (board.id !== info.idBoard) body.idBoard = board.id;
      client.intent(`Move card [${info.shortLink}] "${info.name}" to list "${list.name}"${body.idBoard ? ` on board "${board.name}"` : ""}`);
      await client.put(`/cards/${info.id}`, body);
      return { data: { id: info.id, idList: list.id }, text: `Moved [${info.shortLink}] "${info.name}" to "${list.name}".` };
    },
  },

  "card comment": {
    usage: 'card comment <card> <text> | card comment <card> --file F | card comment <card> --stdin',
    desc: "Add a comment to a card.",
    opts: ["file", "stdin"],
    async run({ client, pos, v }) {
      const text = readText({ text: pos[1], file: v.file, stdin: v.stdin }, "text", "file", "stdin");
      if (!text?.trim()) throw usageErr("Comment text is empty: pass it as an argument, --file or --stdin.");
      const info = await cardInfo(client, pos[0]);
      client.intent(`Comment on [${info.shortLink}] "${info.name}": ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
      const a = await client.post(`/cards/${info.id}/actions/comments`, { text });
      return { data: a, text: `Commented on [${info.shortLink}] "${info.name}".` };
    },
  },

  "card archive": {
    usage: "card archive <card>",
    desc: "Archive a card (reversible: card unarchive).",
    opts: [],
    async run({ client, pos }) {
      const info = await cardInfo(client, pos[0]);
      client.intent(`Archive card [${info.shortLink}] "${info.name}"`);
      await client.put(`/cards/${info.id}`, { closed: true });
      return { data: { id: info.id, closed: true }, text: `Archived [${info.shortLink}] "${info.name}".` };
    },
  },

  "card unarchive": {
    usage: "card unarchive <card>",
    desc: "Restore an archived card.",
    opts: [],
    async run({ client, pos }) {
      const info = await cardInfo(client, pos[0]);
      client.intent(`Unarchive card [${info.shortLink}] "${info.name}"`);
      await client.put(`/cards/${info.id}`, { closed: false });
      return { data: { id: info.id, closed: false }, text: `Restored [${info.shortLink}] "${info.name}".` };
    },
  },

  "card delete": {
    usage: "card delete <card> --yes",
    desc: "Permanently delete a card. IRREVERSIBLE: prefer card archive. Requires --yes.",
    opts: ["yes"],
    async run({ client, pos, v }) {
      const info = await cardInfo(client, pos[0]);
      if (!v.yes && !client.dryRun) throw usageErr(`Refusing to delete [${info.shortLink}] "${info.name}" without --yes. This cannot be undone; card archive is reversible.`);
      client.intent(`PERMANENTLY DELETE card [${info.shortLink}] "${info.name}"`);
      await client.delete(`/cards/${info.id}`);
      return { data: { id: info.id, deleted: true }, text: `Deleted [${info.shortLink}] "${info.name}".` };
    },
  },

  "card label": {
    usage: "card label <card> [--add a,b] [--remove c]",
    desc: "Add or remove labels on a card (resolved by name or color on the card's board).",
    opts: ["add", "remove"],
    async run({ client, pos, v }) {
      const add = csv(v.add);
      const remove = csv(v.remove);
      if (!add.length && !remove.length) throw usageErr("Pass --add and/or --remove.");
      const info = await cardInfo(client, pos[0]);
      const have = new Set(info.idLabels ?? []);
      const toAdd = (await resolveLabels(client, info.idBoard, add)).filter((l) => !have.has(l.id));
      const toRemove = (await resolveLabels(client, info.idBoard, remove)).filter((l) => have.has(l.id));
      client.intent(`Card [${info.shortLink}] "${info.name}": add labels [${toAdd.map((l) => l.name || l.color)}], remove [${toRemove.map((l) => l.name || l.color)}]`);
      for (const l of toAdd) await client.post(`/cards/${info.id}/idLabels`, { value: l.id });
      for (const l of toRemove) await client.delete(`/cards/${info.id}/idLabels/${l.id}`);
      return { data: { added: toAdd.map((l) => l.id), removed: toRemove.map((l) => l.id) }, text: `[${info.shortLink}] labels: +${toAdd.length} -${toRemove.length} (already-correct entries skipped).` };
    },
  },

  "card member": {
    usage: "card member <card> [--add user1,user2] [--remove user]",
    desc: "Assign or unassign members (username, @username or full name, must be on the card's board).",
    opts: ["add", "remove"],
    async run({ client, pos, v }) {
      const add = csv(v.add);
      const remove = csv(v.remove);
      if (!add.length && !remove.length) throw usageErr("Pass --add and/or --remove.");
      const info = await cardInfo(client, pos[0]);
      const have = new Set(info.idMembers ?? []);
      const toAdd = (await resolveMembers(client, info.idBoard, add)).filter((m) => !have.has(m.id));
      const toRemove = (await resolveMembers(client, info.idBoard, remove)).filter((m) => have.has(m.id));
      client.intent(`Card [${info.shortLink}] "${info.name}": assign [${toAdd.map((m) => `@${m.username}`)}], unassign [${toRemove.map((m) => `@${m.username}`)}]`);
      for (const m of toAdd) await client.post(`/cards/${info.id}/idMembers`, { value: m.id });
      for (const m of toRemove) await client.delete(`/cards/${info.id}/idMembers/${m.id}`);
      return { data: { added: toAdd.map((m) => m.id), removed: toRemove.map((m) => m.id) }, text: `[${info.shortLink}] members: +${toAdd.length} -${toRemove.length} (already-correct entries skipped).` };
    },
  },

  "checklist add": {
    usage: 'checklist add <card> <name> [--item "step 1" --item "step 2"]',
    desc: "Add a checklist to a card, optionally pre-filled with items.",
    opts: ["item"],
    async run({ client, pos, v }) {
      const name = need(pos[1], "checklist name");
      const info = await cardInfo(client, pos[0]);
      const items = v.item ?? [];
      client.intent(`Add checklist "${name}" with ${items.length} item(s) to [${info.shortLink}] "${info.name}"`);
      const cl = await client.post("/checklists", { idCard: info.id, name });
      for (const it of items) await client.post(`/checklists/${cl.id}/checkItems`, { name: it });
      return { data: cl, text: `Added checklist "${name}" (id ${cl.id}) with ${items.length} item(s) to [${info.shortLink}].` };
    },
  },

  "checklist item-add": {
    usage: "checklist item-add <card> <checklist name|id> <item name>",
    desc: "Add an item to an existing checklist of a card.",
    opts: [],
    async run({ client, pos }) {
      const itemName = need(pos[2], "item name");
      const info = await cardInfo(client, pos[0]);
      const cl = await findChecklist(client, info.id, need(pos[1], "checklist"));
      client.intent(`Add item "${itemName}" to checklist "${cl.name}" on [${info.shortLink}] "${info.name}"`);
      const it = await client.post(`/checklists/${cl.id}/checkItems`, { name: itemName });
      return { data: it, text: `Added "${itemName}" to checklist "${cl.name}".` };
    },
  },

  "checklist check": {
    usage: "checklist check <card> <item name|id>",
    desc: "Mark a checklist item complete.",
    opts: [],
    run: (ctx) => setCheckState(ctx, "complete"),
  },
  "checklist uncheck": {
    usage: "checklist uncheck <card> <item name|id>",
    desc: "Mark a checklist item incomplete.",
    opts: [],
    run: (ctx) => setCheckState(ctx, "incomplete"),
  },

  attachments: {
    usage: "attachments <card>",
    desc: "List attachments of a card (id, name, size, url).",
    opts: [],
    async run({ client, pos }) {
      const atts = await client.get(`/cards/${stripUrl(need(pos[0], "card"))}/attachments`, { fields: "name,url,bytes,mimeType,isUpload,date" });
      return { data: atts, text: attachmentsText(atts) };
    },
  },

  "attachment add": {
    usage: "attachment add <card> (--file <path> | --url <url>) [--name N]",
    desc: "Attach a local file (uploaded) or a URL (link) to a card.",
    opts: ["file", "url", "name"],
    async run({ client, pos, v }) {
      if (!!v.file === !!v.url) throw usageErr("Pass exactly one of --file or --url.");
      const info = await cardInfo(client, pos[0]);
      if (v.url) {
        client.intent(`Attach link ${v.url} to [${info.shortLink}] "${info.name}"`);
        const a = await client.post(`/cards/${info.id}/attachments`, { url: v.url, name: v.name });
        return { data: a, text: `Attached link to [${info.shortLink}] (id ${a.id}).` };
      }
      const path = expand(v.file);
      let st;
      try {
        st = statSync(path);
      } catch {
        throw usageErr(`File not found: ${path}`);
      }
      if (!st.isFile() || st.size === 0) throw usageErr(`Not a non-empty regular file: ${path}`);
      if (st.size > 250 * 1024 * 1024) throw usageErr(`File too large for Trello (${fmtSize(st.size)}, limit 250 MB): ${path}`);
      client.intent(`Upload ${basename(path)} (${fmtSize(st.size)}) to [${info.shortLink}] "${info.name}"`);
      let a;
      if (client.dryRun) {
        a = await client.request("POST", `/cards/${info.id}/attachments`, { formLabel: path });
      } else {
        const form = new FormData();
        form.set("file", new Blob([readFileSync(path)]), v.name || basename(path));
        if (v.name) form.set("name", v.name);
        a = await client.request("POST", `/cards/${info.id}/attachments`, { form });
      }
      return { data: a, text: `Uploaded ${basename(path)} to [${info.shortLink}] (attachment id ${a.id}).` };
    },
  },

  "attachment get": {
    usage: "attachment get <card> <attachment id|name> [--out <dir>]",
    desc: "Download an uploaded attachment (default dir: system temp). Link attachments are not downloaded; their URL is printed.",
    opts: ["out"],
    async run({ client, pos, v }) {
      const cardRef = stripUrl(need(pos[0], "card"));
      const atts = await client.get(`/cards/${cardRef}/attachments`, { fields: "name,url,bytes,mimeType,isUpload,fileName" });
      const ref = need(pos[1], "attachment");
      const att = atts.find((a) => a.id === ref) ?? pickByName(atts, ref, "attachment", (a) => a.name, (a) => `${a.name} (${a.id})`);
      if (!att.isUpload) return { data: att, text: `"${att.name}" is a link, not an upload: ${att.url}` };
      const buf = await client.download(att.url);
      const dir = v.out ? expand(v.out) : join(tmpdir(), "trello");
      mkdirSync(dir, { recursive: true });
      const safe = (att.fileName || att.name || "attachment").replace(/[^\w.\-+ ()]/g, "_");
      const target = join(dir, safe);
      writeFileSync(target, buf);
      const data = { path: target, name: att.name, mimeType: att.mimeType, bytes: buf.length };
      return { data, text: `Saved ${target}\nName: ${att.name}  Type: ${att.mimeType ?? "?"}  Size: ${fmtSize(buf.length)}` };
    },
  },

  search: {
    usage: 'search <query> [--board <board>] [--limit N]',
    desc: "Search cards by text. Supports Trello operators in the query (e.g. @me, label:bug, list:Doing, due:week, is:open). Default limit 20.",
    opts: ["board", "limit"],
    async run({ client, pos, v, env }) {
      const query = need(pos[0], "query");
      const limit = Math.min(intFlag(v.limit, 20, "limit"), 1000) || 20;
      const board = v.board ? await resolveBoard(client, v.board, env) : undefined;
      const res = await client.get("/search", {
        query,
        modelTypes: "cards",
        cards_limit: limit,
        card_fields: CARD_FIELDS,
        card_board: true,
        card_list: true,
        idBoards: board?.id,
        partial: true,
      });
      const cards = res.cards ?? [];
      return { data: cards, text: searchText(cards, query) };
    },
  },

  api: {
    usage: "api <GET|POST|PUT|DELETE> <path> [--param k=v ...] [--data '<json>']",
    desc: "Raw REST escape hatch (path relative to the API base, e.g. /members/me). Always prints JSON. Writes honor --dry-run.",
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

async function findChecklist(client, cardId, ref) {
  const cls = await client.get(`/cards/${cardId}/checklists`, { fields: "name", checkItem_fields: "name,state" });
  return cls.find((c) => c.id === ref) ?? pickByName(cls, ref, "checklist");
}

async function setCheckState({ client, pos }, state) {
  const info = await cardInfo(client, pos[0]);
  const ref = need(pos[1], "item");
  const cls = await client.get(`/cards/${info.id}/checklists`, { fields: "name", checkItem_fields: "name,state" });
  const all = cls.flatMap((c) => (c.checkItems ?? []).map((i) => ({ ...i, checklist: c.name })));
  const item = all.find((i) => i.id === ref) ?? pickByName(all, ref, "checklist item", (i) => i.name, (i) => `${i.name} [${i.checklist}] (${i.id})`);
  client.intent(`Mark item "${item.name}" ${state} on [${info.shortLink}] "${info.name}"`);
  await client.put(`/cards/${info.id}/checkItem/${item.id}`, { state });
  return { data: { id: item.id, state }, text: `Item "${item.name}" is now ${state}.` };
}

/* ------------------------------------------------------------------ help */

function helpText(cmdName) {
  if (cmdName && COMMANDS[cmdName]) {
    const c = COMMANDS[cmdName];
    return `${c.desc}\n\nUsage: trello ${c.usage}\nFlags valid for every command: --json, --dry-run (writes only), --help`;
  }
  const rows = Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.desc}`);
  return [
    "trello: Trello from the terminal, built for scripts and AI agents.",
    "",
    "Auth: TRELLO_API_KEY and TRELLO_TOKEN (run `trello auth`). Optional: TRELLO_BOARD default board, TRELLO_API_BASE.",
    "Output: compact text by default, --json for raw JSON. Errors go to stderr, exit code 1 (2 for usage errors).",
    "References: boards/lists/labels/members by name, id or short link; cards by short link, id or trello.com/c/... URL.",
    "Every write supports --dry-run: it resolves names with read calls, prints what would be sent, and sends nothing.",
    "Values starting with '-' must use --flag=value (--desc=\"- first item\"). A positional starting with '-' goes after '--', which then also takes the command words: trello --board=X --list=Y -- card create \"- title\".",
    "",
    "Commands:",
    ...rows,
  ].join("\n");
}

/* ------------------------------------------------------------------ main */

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl } = {}) {
  const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const err = (s) => stderr.write(s.endsWith("\n") ? s : `${s}\n`);
  let json = argv.includes("--json");
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTION_TYPES, allowPositionals: true, strict: true });
    } catch (e) {
      throw usageErr(`${e.message}\nRun "trello --help" for usage.`);
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
      throw usageErr(`Unknown command "${two}".${known.length ? ` Did you mean: ${known.join(", ")}?` : ""}\nRun "trello --help".`);
    }
    if (v.help) {
      out(helpText(name));
      return 0;
    }
    const cmd = COMMANDS[name];
    const allowed = new Set([...cmd.opts, ...GLOBAL_OPTS]);
    const extra = Object.keys(v).filter((k) => !allowed.has(k));
    if (extra.length) throw usageErr(`Flag(s) not valid for "${name}": ${extra.map((k) => `--${k}`).join(", ")}.\nUsage: trello ${cmd.usage}`);
    const pos = positionals.slice(name.split(" ").length);

    let client = null;
    if (!cmd.noClient) {
      client = new Client(loadCreds(env), { base: env.TRELLO_API_BASE, dryRun: !!v["dry-run"], fetchImpl });
    } else {
      client = new Client({ key: "", token: "" }, { dryRun: true });
    }
    const result = await cmd.run({ client, pos, v, env });

    if (v["dry-run"] && client.planned.length) {
      out(json ? JSON.stringify({ dryRun: true, intents: client.intents, requests: client.planned }) : dryRunText(client));
    } else if (v["dry-run"] && !cmd.noClient) {
      out(json ? JSON.stringify({ dryRun: true, intents: [], requests: [], note: "read-only command, executed normally", data: result.data }) : result.text);
    } else {
      out(json || result.forceJson ? JSON.stringify(result.data) : result.text);
    }
    return 0;
  } catch (e) {
    const status = e instanceof TrelloError ? e.status : undefined;
    const message = e?.message ?? String(e);
    err(json ? JSON.stringify({ error: message, status, code: e?.code }) : `Error: ${message}`);
    return e?.code === "usage" ? 2 : 1;
  }
}
