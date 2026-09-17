/**
 * bash-guardrail — steers the agent away from shelling out when a purpose-built
 * tool is an exact substitute.
 *
 * This extension registers NO tool: its entire prompt footprint is zero tokens.
 * It works by intercepting `bash` tool calls. Four modes:
 *
 *   on      LOCKDOWN (default). Every bash call is blocked. The agent cannot
 *           lift this by any means available to it: no escape comment, no
 *           retry, no rephrasing. Only the human can — by switching mode, or
 *           by dictating the exact command themselves.
 *   assist  The old selective behaviour: block a single-intent command that has
 *           an exact tool equivalent, nudge composites, allow the rest.
 *   nudge   Never block; only append a one-line hint.
 *   off     Fully inert.
 *
 * Safety properties, in order of importance:
 *   1. Fails OPEN on internal errors. A crash in this extension must never make
 *      bash unusable. (In lockdown the classifier is sandboxed separately, so a
 *      classifier bug degrades the *hint*, not the block.)
 *   2. In lockdown, no agent-controllable bypass exists. The escape comment is
 *      inert, and a repeat of a blocked command is blocked again.
 *   3. In assist mode, precision over recall: anything not fully understood is
 *      allowed, the same command is never blocked twice, and a replacement tool
 *      that is not loaded is never suggested.
 *   4. The single human-controlled bypass in every mode: a command the user
 *      typed verbatim in a recent message runs untouched.
 */

import { existsSync, statSync, appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, renderBlock, renderCall, renderNudge, type Decision, type Intent, type PathKind } from "./classify.ts";

type Mode = "on" | "assist" | "nudge" | "off";

const ESCAPE_RE = /#\s*guardrail:\s*allow/i;
const stripEscape = (s: string) => s.replace(/#\s*guardrail:\s*allow/gi, "");

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
  if (v === "assist" || v === "selective" || v === "legacy") return "assist";
  return "on";
}

/**
 * The refusal shown in lockdown. It deliberately does NOT offer the agent a way
 * out: the only listed remedies are tool calls and asking the human.
 */
function renderLockdown(command: string, hint: Decision | null, escaped: boolean): string {
  const lines = [
    "[bash-guardrail] bash is locked down (mode=on). Nothing was executed.",
    "",
    `  ${norm(command).slice(0, 300)}`,
    "",
  ];
  if (hint && hint.kind !== "allow") {
    const call = hint.kind === "block" ? renderCall(hint.call) : hint.call ? renderCall(hint.call) : hint.tool;
    lines.push(`Use the tool instead — ${hint.tool}:`, `  ${call}`, "");
  } else {
    lines.push(
      "Express this with the purpose-built tools (read/multi_file_read, grep, code_search,",
      "list_files, path_stats, file_ops, git, diff, env_info, node_project, process, ...).",
      "",
    );
  }
  if (escaped) {
    lines.push("`# guardrail:allow` has no effect in this mode — it is not an agent-facing switch.", "");
  }
  lines.push(
    "There is no self-service bypass: re-sending this command, with or without a comment",
    "marker, will be blocked again. If the shell is genuinely required, say so and let the",
    "user decide — they can run `/guardrail assist` (selective) or `/guardrail off`, set",
    "PI_BASH_GUARDRAIL=off, or type the exact command themselves.",
  );
  return lines.join("\n");
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
   * Did the user ask for the shell here?
   *  - "verbatim": the command (or its post-`cd` core) appears in a recent user
   *    message. The agent cannot fabricate this — it can only be produced by the
   *    human typing the command. This is the one bypass honoured in LOCKDOWN.
   *  - "worded": the user asked for a shell/bash/one-liner solution in prose.
   *    Fuzzy, so it only relaxes ASSIST mode, never lockdown.
   */
  function userWantsShell(command: string, ctx: ExtensionContext, kind: "verbatim" | "any"): boolean {
    try {
      const needle = norm(stripEscape(command));
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
        if (kind === "any" && EXPLICIT_SHELL_RE.test(hay)) return true;
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

      const escaped = ESCAPE_RE.test(command);
      const key = norm(stripEscape(command));

      // ---- LOCKDOWN ------------------------------------------------------
      // Blocks unconditionally. The only way through is the human: either they
      // change the mode, or they typed this exact command themselves.
      if (m === "on") {
        if (userWantsShell(command, ctx, "verbatim")) {
          suppress("user-dictated-verbatim");
          log({ decision: "allow", why: "user-dictated-verbatim", command });
          return undefined;
        }
        // Sandboxed: a classifier bug must degrade the hint, not the block.
        let hint: Decision | null = null;
        try {
          const d = classify(command, { cwd: ctx.cwd, statPath });
          const tools = activeTools();
          if (d.kind !== "allow" && (!tools || tools.has(d.tool))) hint = d;
        } catch {
          /* no hint, still blocked */
        }
        stats.blocked++;
        bump(hint && hint.kind !== "allow" ? hint.intent : "lockdown", "blocked");
        log({
          decision: "block",
          why: "lockdown",
          command,
          escapeAttempt: escaped || undefined,
          tool: hint && hint.kind !== "allow" ? hint.tool : undefined,
        });
        return { block: true, reason: renderLockdown(command, hint, escaped) };
      }

      // ---- ASSIST / NUDGE ------------------------------------------------
      // The escape comment is honoured only as a re-send of a command this
      // session actually blocked. Used pre-emptively it does nothing, so the
      // agent can no longer opt out of the check before it has run.
      if (escaped) {
        if (blockedOnce.has(key)) {
          suppress("escape-hatch");
          log({ decision: "allow", why: "escape-hatch", command });
          return undefined;
        }
        suppress("escape-hatch-ignored-not-blocked");
        log({ decision: "ignore-escape", why: "never-blocked", command });
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
        if (m === "nudge") {
          effective = { kind: "nudge", intent: decision.intent, tool: decision.tool, note: `Not blocked (nudge-only mode). Equivalent call:`, call: decision.call };
        } else if (!tools) {
          effective = { kind: "nudge", intent: decision.intent, tool: decision.tool, note: `Could not verify that ${decision.tool} is active, so this ran. Equivalent call:`, call: decision.call };
        } else if (userWantsShell(command, ctx, "any")) {
          suppress("user-asked-for-shell");
          log({ decision: "allow", why: "user-asked-for-shell", command });
          return undefined;
        } else if (blockedOnce.has(key)) {
          // Anti-loop guarantee: a command is never blocked twice.
          pendingNudge.set(
            event.toolCallId,
            `[bash-guardrail] Ran this time (a command is never blocked twice). If the tool equivalent fits, prefer it next time: ${decision.tool}.`,
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
    description: "bash-guardrail: show stats, or set mode (on=lockdown|assist|nudge|off)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "assist" || arg === "nudge" || arg === "off") {
        modeOverride = arg as Mode;
        ctx.ui.notify(
          `bash-guardrail mode: ${arg}${arg === "on" ? " (lockdown — all bash blocked)" : ""}`,
          "info",
        );
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
