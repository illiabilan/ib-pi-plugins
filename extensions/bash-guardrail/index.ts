/**
 * bash-guardrail — steers the agent away from shelling out when a purpose-built
 * tool is an exact substitute.
 *
 * This extension registers NO tool: its entire prompt footprint is zero tokens.
 * It works by intercepting `bash` tool calls:
 *
 *   BLOCK  a single-intent command with an exact tool equivalent, returning the
 *          concrete replacement call (arguments filled in from the parsed
 *          command) so the agent can retry in one turn.
 *   NUDGE  a composite command that still has a partial equivalent: it runs
 *          normally and one short line is appended to the result.
 *   ALLOW  everything else, silently.
 *
 * Safety properties, in order of importance:
 *   1. Fails OPEN. Any exception anywhere leaves bash untouched.
 *   2. Precision over recall. Anything not fully understood is allowed.
 *   3. Never blocks the same command twice — the second attempt always runs, so
 *      a wrong block can cost at most one turn and can never loop.
 *   4. Never blocks when the replacement tool is not active in this session,
 *      when the user dictated the command verbatim, or when the command carries
 *      `# guardrail:allow`.
 */

import { existsSync, statSync, appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, renderBlock, renderNudge, type Decision, type Intent, type PathKind } from "./classify.ts";

type Mode = "on" | "nudge" | "off";

const ESCAPE_RE = /#\s*guardrail:\s*allow/i;

/**
 * The user explicitly asking for a shell solution. Deliberately narrow: it wants
 * an imperative ("use the shell", "with a bash one-liner", "run this command"),
 * not any mention of the word shell.
 */
const EXPLICIT_SHELL_RE =
  /\b(?:use|using|via|with|run|write|give me|through)\s+(?:a\s+|an\s+|the\s+|only\s+|just\s+)*(?:shell|bash|zsh|terminal|command[- ]?line|cli|one[- ]?liner|shell\s+one[- ]?liner)\b|\brun\s+(?:this|the following|these)\s+(?:exact\s+)?commands?\b|\bshell\s+one[- ]?liner\b/i;

/** Tools whose absence makes the corresponding block pointless. */
function readMode(): Mode {
  const v = (process.env.PI_BASH_GUARDRAIL ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "nudge" || v === "nudge-only" || v === "warn") return "nudge";
  return "on";
}

function statPath(p: string): PathKind {
  try {
    if (!existsSync(p)) return "missing";
    return statSync(p).isDirectory() ? "dir" : "file";
  } catch {
    return "unknown";
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Stats = {
  seen: number;
  blocked: number;
  nudged: number;
  allowed: number;
  suppressed: Record<string, number>;
  byIntent: Record<string, { blocked: number; nudged: number }>;
};

export default function bashGuardrail(pi: ExtensionAPI) {
  const stats: Stats = { seen: 0, blocked: 0, nudged: 0, allowed: 0, suppressed: {}, byIntent: {} };
  /** Commands already blocked once: a repeat always executes (anti-loop guarantee). */
  const blockedOnce = new Set<string>();
  /** toolCallId -> nudge text to append in tool_result. */
  const pendingNudge = new Map<string, string>();
  /** One nudge per intent per session keeps the context cost negligible. */
  const nudgedIntents = new Set<string>();
  let modeOverride: Mode | null = null;

  const mode = () => modeOverride ?? readMode();

  const bump = (intent: Intent | string, key: "blocked" | "nudged") => {
    const row = (stats.byIntent[intent] ??= { blocked: 0, nudged: 0 });
    row[key]++;
  };
  const suppress = (why: string) => {
    stats.suppressed[why] = (stats.suppressed[why] ?? 0) + 1;
    stats.allowed++;
  };

  const log = (record: Record<string, unknown>) => {
    const file = process.env.PI_BASH_GUARDRAIL_LOG;
    if (!file) return;
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
    } catch {
      /* logging must never break anything */
    }
  };

  /**
   * Did the user ask for the shell here? Two ways count:
   *  - the command (or its post-`cd` core) appears verbatim in a recent user message
   *  - the user explicitly asked for a shell/bash/one-liner solution
   * Both mean a block would be overriding an explicit instruction, so we allow.
   * Verified empirically: without the second rule, "use a shell one-liner to ..."
   * got blocked and cost the agent an extra turn to re-send with the escape hatch.
   */
  function userWantsShell(command: string, ctx: ExtensionContext): boolean {
    try {
      const needle = norm(command);
      if (needle.length < 6) return false;
      const core = needle.replace(/^cd\s+\S+\s*&&\s*/, "");
      const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
      let checked = 0;
      for (let i = entries.length - 1; i >= 0 && checked < 12; i--) {
        const msg = (entries[i] as { message?: { role?: string; content?: unknown } }).message;
        if (!msg || msg.role !== "user") continue;
        checked++;
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : ""))
                  .join("\n")
              : "";
        const hay = norm(text);
        if (!hay) continue;
        if (hay.includes(needle) || (core.length >= 12 && hay.includes(core))) return true;
        if (EXPLICIT_SHELL_RE.test(hay)) return true;
      }
    } catch {
      /* if we cannot tell, treat as not dictated */
    }
    return false;
  }

  function activeTools(): Set<string> | null {
    try {
      const list = pi.getActiveTools();
      if (Array.isArray(list) && list.length) return new Set(list);
    } catch {
      /* fall through */
    }
    return null;
  }

  pi.on("tool_call", (event, ctx) => {
    try {
      if (event.toolName !== "bash") return undefined;
      const command = (event.input as { command?: string } | undefined)?.command;
      if (typeof command !== "string" || !command.trim()) return undefined;

      const m = mode();
      if (m === "off") return undefined;
      stats.seen++;

      if (ESCAPE_RE.test(command)) {
        suppress("escape-hatch");
        log({ decision: "allow", why: "escape-hatch", command });
        return undefined;
      }

      const decision: Decision = classify(command, { cwd: ctx.cwd, statPath });
      if (decision.kind === "allow") {
        stats.allowed++;
        return undefined;
      }

      // Availability: never point at a tool that is not loaded. If detection
      // fails entirely, degrade block -> nudge rather than guessing.
      const tools = activeTools();
      let effective: Decision = decision;
      if (tools && !tools.has(decision.tool)) {
        suppress(`tool-not-active:${decision.tool}`);
        log({ decision: "allow", why: "tool-not-active", tool: decision.tool, command });
        return undefined;
      }

      if (decision.kind === "block") {
        const key = norm(command);
        if (m === "nudge") {
          effective = { kind: "nudge", intent: decision.intent, tool: decision.tool, note: `Not blocked (nudge-only mode). Equivalent call:`, call: decision.call };
        } else if (!tools) {
          effective = { kind: "nudge", intent: decision.intent, tool: decision.tool, note: `Could not verify that ${decision.tool} is active, so this ran. Equivalent call:`, call: decision.call };
        } else if (userWantsShell(command, ctx)) {
          suppress("user-asked-for-shell");
          log({ decision: "allow", why: "user-asked-for-shell", command });
          return undefined;
        } else if (blockedOnce.has(key)) {
          // Anti-loop guarantee: a command is never blocked twice.
          pendingNudge.set(
            event.toolCallId,
            `[bash-guardrail] Ran this time (a command is never blocked twice). If the tool equivalent fits, prefer it next time: ${decision.tool} — otherwise append \` # guardrail:allow\` to skip this check.`,
          );
          suppress("repeat-after-block");
          log({ decision: "allow", why: "repeat-after-block", command });
          return undefined;
        } else {
          blockedOnce.add(key);
          stats.blocked++;
          bump(decision.intent, "blocked");
          log({ decision: "block", intent: decision.intent, tool: decision.tool, command, call: decision.call });
          return { block: true, reason: renderBlock(decision) };
        }
      }

      // A tool_result may never arrive (aborted turn); keep the map bounded.
      if (pendingNudge.size > 100) pendingNudge.clear();

      if (effective.kind === "nudge") {
        stats.nudged++;
        bump(effective.intent, "nudged");
        log({ decision: "nudge", intent: effective.intent, tool: effective.tool, command });
        const cap = nudgedIntents.size >= 8;
        if (!cap && !nudgedIntents.has(effective.intent)) {
          nudgedIntents.add(effective.intent);
          pendingNudge.set(event.toolCallId, renderNudge(effective));
        }
      }
      return undefined;
    } catch (err) {
      // Fail open, always.
      log({ decision: "error", error: String(err) });
      return undefined;
    }
  });

  pi.on("tool_result", (event) => {
    try {
      const note = pendingNudge.get(event.toolCallId);
      if (!note) return undefined;
      pendingNudge.delete(event.toolCallId);
      if (event.isError) return undefined;
      const content = Array.isArray(event.content) ? event.content : [];
      return { content: [...content, { type: "text" as const, text: note }] };
    } catch {
      return undefined;
    }
  });

  pi.on("session_shutdown", () => {
    pendingNudge.clear();
    blockedOnce.clear();
  });

  pi.registerCommand("guardrail", {
    description: "bash-guardrail: show intervention stats, or set mode (on|nudge|off)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "nudge" || arg === "off") {
        modeOverride = arg as Mode;
        ctx.ui.notify(`bash-guardrail mode: ${arg}`, "info");
        return;
      }
      const intents = Object.entries(stats.byIntent)
        .map(([k, v]) => `${k}: ${v.blocked}b/${v.nudged}n`)
        .join(", ");
      const sup = Object.entries(stats.suppressed)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      ctx.ui.notify(
        `bash-guardrail [${mode()}] bash calls seen=${stats.seen} blocked=${stats.blocked} nudged=${stats.nudged} allowed=${stats.allowed}` +
          (intents ? `\nby intent: ${intents}` : "") +
          (sup ? `\nsuppressed: ${sup}` : ""),
        "info",
      );
    },
  });
}
