/**
 * Trello extension for pi: a thin wrapper over the standalone `trello-cli`
 * (tools/trello). All Trello logic lives in the CLI so Claude Code, Antigravity and
 * plain shells use the exact same behavior. This file only maps tool params to CLI argv,
 * gates writes behind an approval dialog (using the CLI's own --dry-run output), and turns
 * downloaded files into model-readable content.
 *
 * Configuration: TRELLO_API_KEY and TRELLO_TOKEN (run `node tools/trello/script/trello.mjs auth`), optional TRELLO_BOARD.
 * CLI lookup order: $TRELLO_CLI, the repo copy at ../../tools/trello, `trello-cli` on PATH.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeFile, type Block } from "./filecontent.ts";

const MAX_OUTPUT_CHARS = 40_000;
const PROFILES = [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc", ".profile"];

/* ------------------------------------------------------------------ CLI discovery */

type Cli = { cmd: string; pre: string[]; where: string };

function findCli(): Cli {
  const fromEnv = process.env.TRELLO_CLI?.trim();
  if (fromEnv) return { cmd: fromEnv, pre: [], where: "TRELLO_CLI" };
  try {
    const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
    const script = join(here, "..", "..", "tools", "trello", "script", "trello.mjs");
    if (existsSync(script)) return { cmd: process.execPath, pre: [script], where: script };
  } catch {
    /* fall through to PATH */
  }
  return { cmd: "trello-cli", pre: [], where: "PATH" };
}

type RunResult = { code: number; stdout: string; stderr: string; missing?: boolean };

function runCli(cli: Cli, argv: string[], opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cli.cmd,
      [...cli.pre, ...argv],
      { env: opts.env ?? process.env, signal: opts.signal, timeout: opts.timeout ?? 60_000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (e && (e.code === "ENOENT" || e.code === "EACCES"))
          return resolve({ code: 127, stdout: "", stderr: `Cannot run trello-cli (${cli.cmd}): ${e.message}`, missing: true });
        if (e && e.name === "AbortError") return resolve({ code: 130, stdout, stderr: "Cancelled." });
        const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** pi may have been launched without the shell profile sourced (GUI launch, CI): probe once. */
let probed: NodeJS.ProcessEnv | null | undefined;
function probeLoginShell(): Promise<NodeJS.ProcessEnv | null> {
  if (probed !== undefined) return Promise.resolve(probed);
  return new Promise((resolve) => {
    if (!PROFILES.some((p) => existsSync(join(homedir(), p)))) return resolve((probed = null));
    execFile(
      process.env.SHELL || "/bin/zsh",
      ["-l", "-i", "-c", 'printf "%s\\n%s\\n%s\\n" "$TRELLO_API_KEY" "$TRELLO_TOKEN" "$TRELLO_BOARD"'],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err && !stdout) return resolve((probed = null));
        const [key = "", token = "", board = ""] = stdout.split("\n").map((s) => s.trim());
        if (!key || !token) return resolve((probed = null));
        resolve((probed = { TRELLO_API_KEY: key, TRELLO_TOKEN: token, ...(board ? { TRELLO_BOARD: board } : {}) }));
      },
    );
  });
}

const hasCreds = () => !!process.env.TRELLO_API_KEY && !!process.env.TRELLO_TOKEN;

/* ------------------------------------------------------------------ schema */

const ACTIONS = [
  "me", "boards", "board", "lists", "cards", "show", "comments", "search",
  "attachments", "download_attachment",
  "create_card", "update_card", "move_card", "comment", "archive_card", "unarchive_card", "delete_card",
  "set_labels", "set_members", "create_list", "archive_list",
  "add_checklist", "add_check_item", "check_item", "uncheck_item", "add_attachment",
] as const;

const WRITE = new Set<string>([
  "create_card", "update_card", "move_card", "comment", "archive_card", "unarchive_card", "delete_card",
  "set_labels", "set_members", "create_list", "archive_list",
  "add_checklist", "add_check_item", "check_item", "uncheck_item", "add_attachment",
]);

const schema = Type.Object({
  action: Type.Union(ACTIONS.map((a) => Type.Literal(a)), { description: "What to do. See the tool description." }),
  board: Type.Optional(Type.String({ description: "Board name, short link, id or trello.com/b/... URL. Falls back to $TRELLO_BOARD." })),
  list: Type.Optional(Type.String({ description: "List name (needs board unless it is the card's own board) or list id." })),
  card: Type.Optional(Type.String({ description: "Card short link (8 chars), id, or trello.com/c/... URL." })),
  name: Type.Optional(Type.String({ description: "Card/list/checklist/check-item name, or attachment display name." })),
  desc: Type.Optional(Type.String({ description: "Card description (markdown)." })),
  due: Type.Optional(Type.String({ description: "YYYY-MM-DD (stored as 12:00 UTC) or ISO-8601 timestamp." })),
  clear_due: Type.Optional(Type.Boolean({ description: "update_card: remove the due date." })),
  complete: Type.Optional(Type.Boolean({ description: "update_card: true marks the due date done, false reopens it." })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "create_card: label names (or colors for unnamed labels)." })),
  members: Type.Optional(Type.Array(Type.String(), { description: "create_card: usernames or full names." })),
  add_labels: Type.Optional(Type.Array(Type.String())),
  remove_labels: Type.Optional(Type.Array(Type.String())),
  add_members: Type.Optional(Type.Array(Type.String())),
  remove_members: Type.Optional(Type.Array(Type.String())),
  position: Type.Optional(Type.String({ description: "top, bottom, or a number." })),
  text: Type.Optional(Type.String({ description: "Comment text." })),
  query: Type.Optional(Type.String({ description: "search: text plus Trello operators (label:bug list:Doing @me due:week is:open). boards: name filter." })),
  limit: Type.Optional(Type.Number({ description: "Max rows for cards/search/comments." })),
  comments: Type.Optional(Type.Number({ description: "show: how many latest comments to include (default 5, 0 = none)." })),
  per_list: Type.Optional(Type.Number({ description: "board: cards shown per list (default 30)." })),
  items: Type.Optional(Type.Array(Type.String(), { description: "add_checklist: initial checklist items." })),
  checklist: Type.Optional(Type.String({ description: "add_check_item: checklist name or id." })),
  item: Type.Optional(Type.String({ description: "check_item/uncheck_item: item name or id." })),
  attachment: Type.Optional(Type.String({ description: "download_attachment: attachment id or name." })),
  file_path: Type.Optional(Type.String({ description: "add_attachment: local file to upload." })),
  url: Type.Optional(Type.String({ description: "add_attachment: URL to attach as a link." })),
  save_to: Type.Optional(Type.String({ description: "download_attachment: directory (default: system temp dir)." })),
  confirm_delete: Type.Optional(Type.Boolean({ description: "Required true for delete_card. Set only when the user explicitly asked to DELETE (not archive)." })),
});

export type TrelloToolInput = Static<typeof schema>;

/* ------------------------------------------------------------------ param -> argv */

type Built = { argv: string[]; words: string[]; flags: string[] };

/** Flags use --k=v so values starting with '-' survive; words go after `--` for the same reason. */
function build(p: TrelloToolInput): Built | { error: string } {
  const flags: string[] = [];
  const f = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") flags.push(`--${k}=${v}`);
  };
  const list = (k: string, vs?: string[]) => (vs ?? []).forEach((v) => flags.push(`--${k}=${v}`));
  const need = (v: unknown, what: string): string => {
    if (v === undefined || v === null || v === "") throw new Error(`action=${p.action} needs \`${what}\`.`);
    return String(v);
  };
  try {
    let words: string[];
    switch (p.action) {
      case "me": words = ["me"]; break;
      case "boards": f("query", p.query); words = ["boards"]; break;
      case "board": f("per-list", p.per_list); words = ["board", ...(p.board ? [p.board] : [])]; break;
      case "lists": words = ["lists", ...(p.board ? [p.board] : [])]; break;
      case "cards": f("board", p.board); f("list", p.list); f("limit", p.limit); words = ["cards"]; break;
      case "show": f("comments", p.comments); words = ["card", need(p.card, "card")]; break;
      case "comments": f("limit", p.limit); words = ["comments", need(p.card, "card")]; break;
      case "search": f("board", p.board); f("limit", p.limit); words = ["search", need(p.query, "query")]; break;
      case "attachments": words = ["attachments", need(p.card, "card")]; break;
      case "download_attachment":
        f("out", p.save_to);
        words = ["attachment", "get", need(p.card, "card"), need(p.attachment, "attachment")];
        break;
      case "create_card":
        f("board", p.board); f("list", need(p.list, "list")); f("desc", p.desc); f("due", p.due); f("pos", p.position);
        list("label", p.labels); list("member", p.members);
        words = ["card", "create", need(p.name, "name")];
        break;
      case "update_card":
        f("name", p.name); f("desc", p.desc); f("due", p.due);
        if (p.clear_due) flags.push("--clear-due");
        if (p.complete === true) flags.push("--complete");
        if (p.complete === false) flags.push("--incomplete");
        words = ["card", "update", need(p.card, "card")];
        break;
      case "move_card": f("list", need(p.list, "list")); f("board", p.board); f("pos", p.position); words = ["card", "move", need(p.card, "card")]; break;
      case "comment": words = ["card", "comment", need(p.card, "card"), need(p.text, "text")]; break;
      case "archive_card": words = ["card", "archive", need(p.card, "card")]; break;
      case "unarchive_card": words = ["card", "unarchive", need(p.card, "card")]; break;
      case "delete_card":
        if (!p.confirm_delete) throw new Error("delete_card is irreversible and needs confirm_delete:true. Prefer archive_card.");
        flags.push("--yes");
        words = ["card", "delete", need(p.card, "card")];
        break;
      case "set_labels":
        list("add", p.add_labels); list("remove", p.remove_labels);
        words = ["card", "label", need(p.card, "card")];
        break;
      case "set_members":
        list("add", p.add_members); list("remove", p.remove_members);
        words = ["card", "member", need(p.card, "card")];
        break;
      case "create_list": f("board", p.board); f("pos", p.position); words = ["list", "create", need(p.name, "name")]; break;
      case "archive_list": f("board", p.board); words = ["list", "archive", need(p.list, "list")]; break;
      case "add_checklist": list("item", p.items); words = ["checklist", "add", need(p.card, "card"), need(p.name, "name")]; break;
      case "add_check_item": words = ["checklist", "item-add", need(p.card, "card"), need(p.checklist, "checklist"), need(p.name, "name")]; break;
      case "check_item": words = ["checklist", "check", need(p.card, "card"), need(p.item, "item")]; break;
      case "uncheck_item": words = ["checklist", "uncheck", need(p.card, "card"), need(p.item, "item")]; break;
      case "add_attachment":
        if (!!p.file_path === !!p.url) throw new Error("add_attachment needs exactly one of `file_path` or `url`.");
        f("file", p.file_path); f("url", p.url); f("name", p.name);
        words = ["attachment", "add", need(p.card, "card")];
        break;
      default:
        throw new Error(`Unknown action ${String((p as any).action)}.`);
    }
    return { argv: [...flags, "--", ...words], words, flags };
  } catch (e: any) {
    return { error: e.message };
  }
}

/* ------------------------------------------------------------------ approval */

function uiExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { __piUiDialogQueue?: Promise<void> };
  const next = (g.__piUiDialogQueue ?? Promise.resolve()).then(fn, fn);
  g.__piUiDialogQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const cap = (s: string) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars; narrow the query]` : s);

/* ------------------------------------------------------------------ extension */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "trello",
    label: "Trello",
    // Raises an approval dialog: must never run concurrently with another tool call.
    executionMode: "sequential",
    description: `Read and modify Trello boards, lists and cards through the standalone trello-cli (credentials from TRELLO_API_KEY / TRELLO_TOKEN env vars).

Read: me, boards, board (overview of all lists + cards), lists, cards, show (one card with checklists, attachments, latest comments), comments, search (Trello operators), attachments, download_attachment (images/text are returned inline).
Write (approval required): create_card, update_card, move_card, comment, archive_card, unarchive_card, delete_card (irreversible, needs confirm_delete:true), set_labels, set_members, create_list, archive_list, add_checklist, add_check_item, check_item, uncheck_item, add_attachment.

Boards, lists, labels and members are referenced by NAME (case-insensitive, unique substring ok; ambiguity is an error that lists candidates). Cards are referenced by short link (8 chars shown as [AbCd1234]), id or URL. Moving a card between lists is move_card; there is no status/transition concept.

Examples:
  {"action":"board","board":"Mobile Roadmap"}
  {"action":"search","query":"label:bug list:Doing @me"}
  {"action":"show","card":"AbCd1234"}
  {"action":"create_card","board":"Mobile Roadmap","list":"To Do","name":"Fix login crash","desc":"Cold start on Pixel 8","labels":["bug"],"due":"2026-08-01"}
  {"action":"move_card","card":"AbCd1234","list":"Doing"}`,
    promptSnippet: "Read/search/create/update/move Trello cards via the trello-cli",
    promptGuidelines: [
      "Use trello for ALL Trello access instead of bash+curl or the Trello REST API; it resolves board, list, label and member names for you.",
      "trello write actions (create_card, update_card, move_card, comment, archive_card, unarchive_card, delete_card, set_labels, set_members, create_list, archive_list, add_checklist, add_check_item, check_item, uncheck_item, add_attachment) ask the user for approval themselves: call the action once with full parameters and do not ask for permission in prose first.",
      "When the user pastes a trello.com/c/... or trello.com/b/... URL, pass it as `card` or `board` as is; do not strip it.",
      "Start with trello action=board for an overview of a board before searching card by card; use action=search with operators (label:, list:, @me, due:, is:open) for targeted lookups.",
      "Prefer archive_card over delete_card. delete_card is permanent and only for an explicit user request to delete.",
      "If trello reports missing credentials, tell the user to set TRELLO_API_KEY and TRELLO_TOKEN (`node tools/trello/script/trello.mjs auth` prints how) and restart pi; do not retry.",
    ],
    parameters: schema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cli = findCli();
      const fin = (text: string, isError = false, extra: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text: cap(text) }],
        details: { action: params.action, isError, ...extra },
        isError,
      });

      const built = build(params);
      if ("error" in built) return fin(`Error: ${built.error}`, true);

      // Credentials: inherit env, else probe the login shell once.
      let env: NodeJS.ProcessEnv = process.env;
      if (!hasCreds()) {
        const probe = await probeLoginShell();
        if (probe) env = { ...process.env, ...probe };
      }
      const exec = (argv: string[]) => runCli(cli, argv, { env, signal });
      const failure = (r: RunResult) =>
        r.missing
          ? `${r.stderr}\n\nInstall/locate the CLI: run it from the pi-plugins repo (tools/trello), or set TRELLO_CLI, or put trello-cli on PATH.`
          : (r.stderr || r.stdout || `trello-cli exited with code ${r.code}`).trim();

      try {
        if (WRITE.has(params.action)) {
          // Dry-run first: names are resolved with read calls, so the dialog shows the exact intent.
          const dry = await exec(["--dry-run", ...built.argv]);
          if (dry.code !== 0) return fin(`Error: ${failure(dry)}`, true);
          const preview = dry.stdout.trim();

          if (!ctx.hasUI && process.env.PI_TRELLO_ALLOW_UNATTENDED_WRITES !== "1") {
            return fin(
              `Refusing to run trello ${params.action}: this session has no interactive UI, so no human could confirm it. Nothing was sent.\n\n${preview}\n\nTell the user this needs an interactive pi session (or PI_TRELLO_ALLOW_UNATTENDED_WRITES=1, which only they can set).`,
              true,
              { refused: true },
            );
          }
          if (ctx.hasUI) {
            const ok = await uiExclusive(() => ctx.ui.confirm(`Trello ${params.action}`, preview.slice(0, 4000)));
            if (!ok) return fin(`User declined the trello ${params.action}. Nothing was sent. Ask what to change instead of retrying.`, true, { declined: true });
          }
        }

        const r = await exec(built.argv);
        if (r.code !== 0) return fin(`Error: ${failure(r)}`, true);

        if (params.action === "download_attachment") {
          // The CLI prints a path; add model-readable content for images and small text files.
          const j = await exec(["--json", ...built.argv]);
          try {
            const meta = JSON.parse(j.stdout);
            if (meta?.path && statSync(meta.path).isFile()) {
              const blocks: Block[] = describeFile(meta.path, meta.name ?? meta.path, meta.mimeType, meta.bytes ?? statSync(meta.path).size);
              return { content: blocks, details: { action: params.action, path: meta.path }, isError: false };
            }
          } catch {
            /* link attachment or unexpected output: fall through to the plain text */
          }
        }
        return fin(r.stdout.trim() || "(no output)");
      } catch (e: any) {
        return fin(`trello failed: ${e?.message ?? String(e)}`, true);
      }
    },
    renderCall(args: TrelloToolInput, theme) {
      const bits = [args.board, args.list && `list ${args.list}`, args.card, args.name && `"${args.name.slice(0, 50)}"`, args.query && `"${args.query}"`].filter(Boolean);
      return new Text(
        `${theme.fg("accent", "trello")} ${theme.bold(args.action)}${bits.length ? ` ${theme.fg("dim", bits.join(" "))}` : ""}`,
        0,
        0,
      );
    },
  });
}
