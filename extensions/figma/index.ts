/**
 * figma — Figma design context for Pi, bridged through headless Claude Code.
 *
 * WHY THIS EXISTS
 * ---------------
 * Figma's hosted MCP server (https://mcp.figma.com/mcp) allow-lists OAuth client
 * registration: POST https://api.figma.com/v1/oauth/mcp/register answers 403
 * Forbidden for anything that is not in the Figma MCP Catalog, so pi's MCP
 * adapter can never obtain the `mcp:connect` scope. Claude Code IS in that
 * catalog and ships a pre-registered client id, so it holds a working token.
 *
 * The desktop (Dev Mode) server at 127.0.0.1:3845 would need no OAuth at all,
 * but its "Enable desktop MCP server" toggle requires a Dev/Full seat on a paid
 * plan and is absent for this account.
 *
 * So this tool does not talk to Figma. It runs `claude -p` as a one-shot
 * subprocess, restricted to the Figma MCP tools and with every built-in Claude
 * tool disabled, and returns Claude's answer. Claude is used purely as an
 * authenticated transport, not as a coding agent.
 *
 * SAFETY POSTURE
 * --------------
 * - `--tools ""` removes Bash/Edit/Write/Read from the child entirely, so the
 *   subprocess cannot touch this machine outside of Figma MCP calls.
 * - `--strict-mcp-config` + an inline `--mcp-config` means ONLY the figma server
 *   is loaded — cs-subscriptions, google-workspace and friends never start.
 * - mode:"read" (the default) allow-lists individual read-only Figma tools by
 *   name. Canvas writes, asset uploads and plugin/shader mutation are simply not
 *   in the allow-list, so a prompt injected through design content cannot reach
 *   them.
 * - mode:"write" hands over the whole server and is therefore opt-in per call.
 * - The child runs in an empty scratch directory, not pi's project directory, so the
 *   read-only file tools it keeps (needed to re-read oversized MCP responses) cannot
 *   reach the user's source, .env or credentials. mode:"assets" is the deliberate
 *   exception: it must write images into a real directory.
 * - The child's environment is an ALLOW-LIST (PATH/HOME/proxy/Claude's own auth). pi's
 *   process env carries SLACK_TOKEN, DD_API_KEY, JIRA_API_TOKEN, GH_TOKEN and provider
 *   keys; none of them are needed to read a design, so none of them are inherited.
 *
 * Both of the last two exist because the input is untrusted: text inside a Figma file is
 * attacker-controllable and ends up in the child's context. Treat every such call as
 * "a stranger writes part of the prompt".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Hard cap on returned text. */
const MAX_TEXT = 24_000;
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_MODEL = "sonnet";

/** Inline MCP config: the ONLY server the child is allowed to see. */
const FIGMA_MCP_CONFIG = JSON.stringify({
  mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } },
});

/**
 * Read-only Figma tools, listed individually rather than as the `mcp__figma`
 * wildcard. The wildcard would also grant create_new_file, generate_figma_design,
 * upload_assets, update_shader and send_code_connect_mappings.
 */
const READ_TOOLS = [
  "mcp__figma__get_design_context",
  "mcp__figma__get_metadata",
  "mcp__figma__get_screenshot",
  "mcp__figma__get_variable_defs",
  "mcp__figma__get_code_connect_map",
  "mcp__figma__get_code_connect_suggestions",
  "mcp__figma__get_context_for_code_connect",
  "mcp__figma__get_figjam",
  "mcp__figma__get_libraries",
  "mcp__figma__get_motion_context",
  "mcp__figma__get_shader",
  "mcp__figma__get_generative_plugin",
  "mcp__figma__list_file_components_for_code_connect",
  "mcp__figma__list_file_shaders",
  "mcp__figma__list_shaders",
  "mcp__figma__list_generative_plugins",
  "mcp__figma__search_design_system",
  "mcp__figma__whoami",
];

/** Read + the two tools that write files into the working directory. */
const ASSET_TOOLS = [...READ_TOOLS, "mcp__figma__download_assets", "mcp__figma__export_video"];

/** Everything the server exposes, including canvas mutation. */
const WRITE_TOOLS = ["mcp__figma"];

/**
 * Read-only FILE tools the child keeps. These are not a convenience: when a
 * Figma tool's response exceeds Claude's output limit (get_metadata on a whole
 * section is ~1M chars / ~339k tokens), Claude Code does not truncate it — it
 * writes the payload to
 *   ~/.claude/projects/<slug>/<session>/tool-results/mcp-figma-<tool>-<ts>.txt
 * and tells the model the path. Without a file tool the child can only report
 * "the response was too large", which is exactly how this tool failed its first
 * real query. Bash/Edit/Write stay removed.
 */
const FILE_TOOLS = ["Read", "Grep", "Glob"];

/** Where Claude Code parks oversized tool results; must be reachable under --restricted. */
const CLAUDE_TOOL_RESULTS_DIR = join(homedir(), ".claude", "projects");

const MODES = ["read", "assets", "write"] as const;
type Mode = (typeof MODES)[number];

const SYSTEM_SUFFIX = [
  "You are a non-interactive bridge between a caller and the Figma MCP server.",
  "Never ask clarifying questions and never offer to do follow-up work: your output is consumed by another program, not a human in a chat.",
  "If the request is ambiguous, state the assumption you made in one line and answer anyway.",
  "Report exactly what the Figma tools returned. If a tool fails or returns nothing, say so plainly instead of guessing or inventing design values.",
  "If a Figma tool's response is too large and gets saved to a file, use Grep/Read on that file to extract what was asked for instead of giving up: that is what those tools are there for.",
  "If a node turns out to be a section or page containing many screens rather than a single frame, do not dump it: list its direct children (id, name, size) so the caller can re-ask about one screen.",
  "Tool choice matters: get_design_context (with excludeScreenshot: true unless a screenshot was asked for) is the primary tool. get_metadata has no depth parameter and returns the ENTIRE subtree — on a large node that is ~1M characters and will exhaust the time budget, so call it ONLY when the caller explicitly wants an inventory of node ids/names.",
  "A modal or bottom-sheet frame usually also contains the full screen rendered behind it. Describe the named overlay in detail, state in one line that a background screen is present, and do not fetch code for every background layer.",
  "Be dense: no preamble, no 'I'll help you with that', no closing summary.",
].join(" ");

const schema = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("ask"), Type.Literal("status")], {
      description:
        "ask (default) = run a Figma query through headless Claude; status = report whether the bridge is installed and authenticated (cheap, no model call).",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "What to get from Figma, in plain language. Required for action='ask'. Ex: 'Give me the exact colors, spacing and font sizes of the header frame' or 'Describe every component in this file and its variants'.",
    }),
  ),
  figmaUrl: Type.Optional(
    Type.String({
      description:
        "Figma link the prompt refers to. The hosted server is link-based: copy the file URL for whole-file context, or right-click a layer -> 'Copy link to selection' for one frame. Without a link Claude can only use what the prompt itself names.",
    }),
  ),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal("read"), Type.Literal("assets"), Type.Literal("write")],
      {
        description:
          "read (default) = read-only Figma tools; assets = also download_assets/export_video, which WRITE image files into cwd; write = the whole Figma server including canvas creation/modification. Use the narrowest mode that answers the question.",
      },
    ),
  ),
  model: Type.Optional(
    Type.String({
      description: `Model for the child Claude process (alias like 'sonnet', 'haiku', 'opus', or a full name). Default '${DEFAULT_MODEL}'. Figma's tool definitions cost ~40k prompt tokens per cold call, so prefer 'haiku' for simple lookups.`,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the child process. Only matters for mode='assets', which writes downloaded images there. Defaults to pi's cwd.",
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `Kill the child after this many seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}). The whole process group is killed, so no orphaned Claude process survives.`,
    }),
  ),
});

type FigmaInput = Static<typeof schema>;

/** Shape of `claude -p --output-format json`. Only the fields we actually read. */
interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  permission_denials?: Array<{ tool_name?: string }>;
  session_id?: string;
}

interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a command detached so the ENTIRE process group can be killed. `claude`
 * starts its own children (MCP transports, model requests); killing only the
 * direct pid leaves those running and the timeout would not actually free the
 * machine.
 */
/**
 * Environment handed to the child.
 *
 * pi's own process environment holds every credential the user has exported —
 * SLACK_TOKEN/SLACK_COOKIE, DD_API_KEY/DD_APP_KEY, JIRA_API_TOKEN, GH_TOKEN,
 * provider API keys. None of that is needed to ask Claude about a Figma frame, and
 * the child is driven by UNTRUSTED input: the text inside a Figma design is
 * attacker-controllable and lands in the child's context, which is the textbook
 * prompt-injection setup. So the child gets an allow-list: what a CLI needs to run
 * plus what Claude Code needs to authenticate ITSELF.
 *
 * Anything not listed here simply does not exist inside the subprocess.
 */
const ENV_ALLOW_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Claude Code's own auth/config. Without these the bridge cannot log in at all.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALLOW_EXACT.has(k)) out[k] = v;
  }
  return out;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(),
      });
    } catch (e: any) {
      reject(e);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 3_000).unref?.();
    }, opts.timeoutMs);

    const onAbort = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 3_000).unref?.();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code, sig) =>
      finish(() => resolve({ code, signal: sig, stdout, stderr, timedOut })),
    );
  });
}

function toolsForMode(mode: Mode): string[] {
  if (mode === "write") return WRITE_TOOLS;
  if (mode === "assets") return ASSET_TOOLS;
  return READ_TOOLS;
}

/**
 * Claude prints its JSON result on stdout, but a warning line can precede it.
 * Take the last line that parses as an object with a `type`.
 */
function parseClaudeJson(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeResult;
  } catch {
    /* fall through to line scan */
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed as ClaudeResult;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

const AUTH_HINT =
  "The Figma MCP session is not authenticated. Run `claude mcp login figma` in an interactive terminal and approve in the browser, then retry.";

function looksLikeAuthProblem(text: string): boolean {
  return /needs authentication|not authenticated|unauthorized|401|invalid_token|mcp:connect|oauth/i.test(
    text,
  );
}

async function runStatus(signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown> }> {
  let out: RunOutcome;
  try {
    out = await run("claude", ["mcp", "get", "figma"], { timeoutMs: 30_000, signal });
  } catch (e: any) {
    if (e?.code === "ENOENT")
      return {
        text: "figma bridge UNAVAILABLE: the `claude` CLI is not installed or not on PATH.\nInstall Claude Code, then run `claude mcp add --transport http --scope user figma https://mcp.figma.com/mcp` and `claude mcp login figma`.",
        details: { available: false, reason: "claude-not-installed" },
      };
    throw e;
  }
  const raw = `${out.stdout}${out.stderr}`.trim();
  const connected = /✔|Connected/i.test(raw);
  const needsAuth = /Needs authentication/i.test(raw);
  const header = connected
    ? "figma bridge READY — Claude Code holds a valid Figma MCP session."
    : needsAuth
      ? `figma bridge NOT AUTHENTICATED.\n${AUTH_HINT}`
      : "figma bridge UNKNOWN state — see the raw `claude mcp get figma` output below.";
  return {
    text: `${header}\n\n${raw || "(no output)"}`,
    details: { available: true, connected, needsAuth, raw },
  };
}

async function runAsk(
  p: FigmaInput,
  ctxCwd: string | undefined,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const prompt = (p.prompt ?? "").trim();
  if (!prompt) throw new Error("figma: `prompt` is required for action='ask'.");

  const mode: Mode = (p.mode as Mode) ?? "read";
  if (!MODES.includes(mode))
    throw new Error(`figma: unknown mode '${String(p.mode)}'. Valid modes: ${MODES.join(", ")}.`);

  const model = p.model?.trim() || DEFAULT_MODEL;
  const timeoutSec = Math.min(Math.max(p.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 5), MAX_TIMEOUT_SEC);
  const allowed = toolsForMode(mode);

  const fullPrompt = p.figmaUrl?.trim()
    ? `Figma link: ${p.figmaUrl.trim()}\n\n${prompt}`
    : prompt;

  /*
   * Working directory = file-read scope.
   *
   * `--restricted` confines Read/Grep/Glob to the child's cwd plus every --add-dir.
   * Running it in pi's project directory therefore handed the child the whole repo,
   * including .env / .envrc / credentials checked out locally — and the child's
   * context is filled with UNTRUSTED text from the Figma design, which can instruct
   * it to read a file and paste the contents into its answer.
   *
   * So: an empty scratch directory by default. The file tools exist only to re-read
   * oversized MCP responses that Claude parked under CLAUDE_TOOL_RESULTS_DIR, and
   * that path is added explicitly.
   *
   * mode:'assets' is the documented exception — its whole purpose is writing
   * downloaded images into a real directory, so that directory is the cwd and is
   * necessarily readable. That is why 'assets' must be asked for deliberately.
   */
  const wantsRealDir = mode === "assets";
  const scratchDir = wantsRealDir ? null : mkdtempSync(join(tmpdir(), "pi-figma-"));
  const workDir = wantsRealDir ? p.cwd || ctxCwd : scratchDir!;

  const args = [
    "-p",
    fullPrompt,
    "--output-format",
    "json",
    "--model",
    model,
    // Read-only file tools only (no Bash/Edit/Write/WebFetch), and --restricted
    // confines them to cwd + the --add-dir list, which for a read/write call is an
    // empty scratch dir plus Claude's own tool-results dir. Nothing of the user's
    // project, and nothing like ~/.ssh, is reachable.
    "--tools",
    FILE_TOOLS.join(","),
    "--restricted",
    "--add-dir",
    CLAUDE_TOOL_RESULTS_DIR,
    "--allowedTools",
    [...allowed, ...FILE_TOOLS].join(","),
    "--mcp-config",
    FIGMA_MCP_CONFIG,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--append-system-prompt",
    SYSTEM_SUFFIX,
  ];

  const started = Date.now();
  let out: RunOutcome;
  try {
    out = await run("claude", args, {
      cwd: workDir,
      timeoutMs: timeoutSec * 1_000,
      signal,
    });
  } catch (e: any) {
    if (e?.code === "ENOENT")
      throw new Error(
        "figma: the `claude` CLI is not installed or not on PATH. This tool bridges to Figma through Claude Code; install it, then run `claude mcp login figma`.",
      );
    throw e;
  } finally {
    if (scratchDir) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        /* best effort: an empty temp dir left behind is harmless */
      }
    }
  }

  if (out.timedOut)
    throw new Error(
      `figma: the Claude subprocess did not finish within ${timeoutSec}s and was killed (process group terminated). Raise timeoutSec, narrow the prompt, or check \`figma\` action='status'.`,
    );

  const parsed = parseClaudeJson(out.stdout);
  const stderr = out.stderr.trim();

  if (!parsed) {
    const detail = stderr || out.stdout.trim() || "(no output)";
    if (looksLikeAuthProblem(detail)) throw new Error(`figma: ${AUTH_HINT}\n\n${detail.slice(0, 1_000)}`);
    throw new Error(
      `figma: could not parse the Claude result (exit ${out.code ?? out.signal}).\n${detail.slice(0, 2_000)}`,
    );
  }

  const answer = (parsed.result ?? "").trim();
  const denials = parsed.permission_denials ?? [];

  if (parsed.is_error || parsed.subtype !== "success") {
    if (looksLikeAuthProblem(answer || stderr)) throw new Error(`figma: ${AUTH_HINT}`);
    throw new Error(
      `figma: Claude reported ${parsed.subtype ?? "an error"}.\n${(answer || stderr || "(no detail)").slice(0, 2_000)}`,
    );
  }

  if (!answer && looksLikeAuthProblem(stderr)) throw new Error(`figma: ${AUTH_HINT}`);

  const wallSec = ((Date.now() - started) / 1_000).toFixed(1);
  const cost = typeof parsed.total_cost_usd === "number" ? `$${parsed.total_cost_usd.toFixed(4)}` : "?";
  const footerBits = [
    `mode=${mode}`,
    `model=${model}`,
    `turns=${parsed.num_turns ?? "?"}`,
    `${wallSec}s`,
    `cost=${cost}`,
  ];
  if (denials.length)
    footerBits.push(
      `DENIED=${denials.map((d) => d.tool_name ?? "?").join(",")} (not in mode='${mode}' — raise mode if that tool was actually needed)`,
    );

  const text = `${answer || "(Claude returned an empty answer — the Figma tools may have returned nothing for this link.)"}\n\n--- via claude ${footerBits.join(" | ")}`;

  return {
    text,
    details: {
      mode,
      model,
      allowedTools: allowed,
      numTurns: parsed.num_turns,
      durationMs: parsed.duration_ms,
      costUsd: parsed.total_cost_usd,
      permissionDenials: denials,
      sessionId: parsed.session_id,
      figmaUrl: p.figmaUrl ?? null,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "figma",
    label: "Figma",
    description: `Read Figma designs (frames, components, variables, screenshots, Code Connect) by delegating to a headless Claude Code subprocess that holds the Figma MCP session.
Pi cannot talk to Figma directly: the hosted server allow-lists OAuth clients and refuses pi's registration with HTTP 403, so Claude Code is used purely as an authenticated transport. The child runs with every built-in Claude tool disabled and only the Figma MCP server loaded.
Pass a Figma link whenever you have one — the server is link-based (whole-file URL, or right-click a layer -> "Copy link to selection").
Ex: {"prompt":"Give me exact colors, spacing, font sizes and border radii for the header, as a token list","figmaUrl":"https://figma.com/design/abc/Encore?node-id=12-34"}
mode='read' (default) is read-only; 'assets' also downloads image files into cwd; 'write' unlocks canvas creation/modification and must be requested deliberately.
action='status' checks the bridge without spending a model call.`,
    promptSnippet:
      "Query Figma designs via a headless Claude Code subprocess that owns the Figma MCP session (pi itself is not allow-listed by Figma)",
    promptGuidelines: [
      "Use figma for anything about a Figma design — extracting colors/spacing/typography, listing components and variants, reading variables, getting a screenshot or Code Connect mappings — instead of asking the user to paste design values by hand. Always pass figmaUrl when the user gave a link; without one the Figma server has no file to look at.",
      "Each figma action='ask' call spawns a fresh Claude process that re-sends ~40k tokens of Figma tool definitions, so it costs real money and several seconds: ask for everything you need about one frame in ONE call with a specific prompt, rather than making several narrow calls. Use model='haiku' for simple lookups.",
      "Keep figma at the default mode='read'. Use mode='assets' only when image/SVG files should actually be written into the working directory, and mode='write' only when the user explicitly asked to create or modify content in Figma — that mode hands the subprocess the whole Figma server, including canvas mutation.",
      "If figma reports an authentication problem, tell the user to run `claude mcp login figma` in an interactive terminal (it needs a TTY and a browser) — do not retry the call, and do not try to authenticate through pi's own mcp tool, which Figma rejects with 403.",
      "Read the `--- via claude` footer of a figma result: a DENIED entry means the answer is incomplete because the tool it wanted was outside the requested mode, not because the design lacks that information.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as FigmaInput;
      try {
        const action = p.action ?? "ask";
        const out =
          action === "status"
            ? await runStatus(signal)
            : await runAsk(p, (ctx as any)?.cwd, signal);
        let text = out.text;
        if (text.length > MAX_TEXT)
          text = `${text.slice(0, MAX_TEXT)}\n... [figma output truncated at ${MAX_TEXT} chars — ask a narrower question]`;
        return { content: [{ type: "text" as const, text }], details: out.details };
      } catch (e: any) {
        if (e?.name === "AbortError") throw new Error("figma: cancelled.");
        throw e instanceof Error ? e : new Error(`figma failed: ${String(e)}`);
      }
    },
    renderCall(args: FigmaInput, theme) {
      const a = args ?? ({} as FigmaInput);
      if ((a.action ?? "ask") === "status")
        return new Text(`${theme.fg("accent", "figma")} ${theme.bold("status")}`, 0, 0);
      const p = (a.prompt ?? "").replace(/\s+/g, " ").trim();
      const shown = p.length > 70 ? `${p.slice(0, 70)}...` : p;
      const mode = a.mode ?? "read";
      const suffix = a.figmaUrl ? theme.fg("dim", " +link") : "";
      return new Text(
        `${theme.fg("accent", "figma")} ${theme.bold(mode)} ${shown}${suffix}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Asking Figma via Claude..."), 0, 0);
      const first = result.content[0];
      const content = (first && "text" in first ? first.text : undefined) ?? "";
      if (/^figma(:| failed)/.test(content) && !content.includes("\n"))
        return new Text(theme.fg("error", content), 0, 0);
      const lines = content.split("\n");
      if (!expanded && lines.length > 20)
        return new Text(`${lines.slice(0, 20).join("\n")}\n... and ${lines.length - 20} more lines`, 0, 0);
      return new Text(content, 0, 0);
    },
  });
}
