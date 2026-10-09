/**
 * Podman Sandbox - route the bash tool into an isolated Podman container
 *
 * Runs a single long-lived, sleeping Podman container per project directory
 * and executes every `bash` tool call (and `!`/`!!` user-bash command) inside
 * it via `podman exec`, instead of on the host. The host project directory
 * is bind-mounted read/write into the container at /workspace, so `read`,
 * `write`, `edit`, `grep`, `find`, and `ls` are left untouched and keep
 * running on the host - they see the exact same files, because the bind
 * mount makes them the same underlying files. Only process execution is
 * isolated: separate filesystem root, separate PID/user namespace, dropped
 * capabilities, and (by default) a separate network namespace.
 *
 * This means provider API keys and pi's own session/auth files never enter
 * the sandbox (unlike running the whole `pi` process inside a container) -
 * only whatever `env` you explicitly configure is forwarded.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/extensions/podman-sandbox.json (global)
 * - <cwd>/.pi/podman-sandbox.json (project-local)
 *
 * Example .pi/podman-sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "image": "docker.io/library/node:22-bookworm-slim",
 *   "network": "bridge",
 *   "memory": "4g",
 *   "cpus": "4",
 *   "env": { "CI": "true" },
 *   "extraMounts": [{ "hostPath": "~/.cache/npm", "containerPath": "/root/.npm" }]
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./podman-sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./podman-sandbox --no-podman-sandbox` - disable, run bash on host
 * - `/podman-sandbox` - show current status
 * - `/podman-sandbox rebuild` - stop, remove, and recreate the container
 * - `/podman-sandbox stop` - stop the container now (recreated on next use)
 *
 * Requirements: Podman installed and on PATH. On macOS/Windows, a `podman
 * machine` is started automatically if one exists but is stopped.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BashOperations, CONFIG_DIR_NAME, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as podman from "./podman.ts";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_TIMEOUT_SEC = 120;

interface ExtraMount {
	hostPath: string;
	containerPath: string;
	readOnly?: boolean;
}

interface PodmanSandboxConfig {
	enabled?: boolean;
	image?: string;
	network?: "bridge" | "none" | "host";
	memory?: string;
	cpus?: string;
	pidsLimit?: number;
	readOnlyRootfs?: boolean;
	dropAllCapabilities?: boolean;
	noNewPrivileges?: boolean;
	env?: Record<string, string>;
	extraMounts?: ExtraMount[];
	extraRunArgs?: string[];
	/** Keep the container running across sessions instead of removing it on shutdown. Default: false. */
	keepAlive?: boolean;
	/**
	 * If true, bash calls fail loudly when the sandbox isn't available instead
	 * of silently running unsandboxed on the host. Default: false (fail-open,
	 * matching this repo's other sandbox extension), but every fallback
	 * execution is tagged in its own output either way.
	 */
	failClosed?: boolean;
}

const DEFAULT_CONFIG: Required<
	Pick<
		PodmanSandboxConfig,
		| "enabled"
		| "image"
		| "network"
		| "pidsLimit"
		| "readOnlyRootfs"
		| "dropAllCapabilities"
		| "noNewPrivileges"
		| "keepAlive"
		| "failClosed"
	>
> = {
	enabled: true,
	image: "docker.io/library/node:22-bookworm-slim",
	network: "bridge",
	pidsLimit: 512,
	readOnlyRootfs: false,
	dropAllCapabilities: true,
	noNewPrivileges: true,
	keepAlive: false,
	failClosed: false,
};

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function loadConfig(cwd: string): PodmanSandboxConfig {
	const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "podman-sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "podman-sandbox.json");

	let globalConfig: Partial<PodmanSandboxConfig> = {};
	let projectConfig: Partial<PodmanSandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}
	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}

/** Deterministic container name for this cwd + effective config, so a config change forces a fresh container instead of silently reusing stale settings. */
function containerNameFor(cwd: string, config: PodmanSandboxConfig): string {
	const hash = createHash("sha256").update(JSON.stringify({ cwd, config })).digest("hex").slice(0, 12);
	return `pi-sandbox-${hash}`;
}

function buildRunArgs(name: string, cwd: string, config: PodmanSandboxConfig): string[] {
	const args: string[] = [
		"-d",
		"--name",
		name,
		"--label",
		"pi.sandbox=1",
		"--label",
		`pi.sandbox.cwd=${cwd}`,
		"--init",
		"-v",
		`${cwd}:${GUEST_WORKSPACE}`,
		"--workdir",
		GUEST_WORKSPACE,
		"--network",
		config.network ?? DEFAULT_CONFIG.network,
		"--pids-limit",
		String(config.pidsLimit ?? DEFAULT_CONFIG.pidsLimit),
	];

	if (config.memory) args.push("--memory", config.memory);
	if (config.cpus) args.push("--cpus", config.cpus);
	if (config.readOnlyRootfs ?? DEFAULT_CONFIG.readOnlyRootfs) {
		args.push("--read-only", "--tmpfs", "/tmp:rw,size=512m", "--tmpfs", "/run:rw");
	}
	if (config.dropAllCapabilities ?? DEFAULT_CONFIG.dropAllCapabilities) {
		args.push("--cap-drop", "ALL");
	}
	if (config.noNewPrivileges ?? DEFAULT_CONFIG.noNewPrivileges) {
		args.push("--security-opt", "no-new-privileges");
	}
	for (const mount of config.extraMounts ?? []) {
		const host = expandHome(mount.hostPath);
		args.push("-v", `${host}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`);
	}
	for (const [key, value] of Object.entries(config.env ?? {})) {
		args.push("-e", `${key}=${value}`);
	}
	args.push(...(config.extraRunArgs ?? []));
	args.push(config.image ?? DEFAULT_CONFIG.image, "sleep", "infinity");
	return args;
}

type SandboxStatus =
	| { kind: "ready"; containerName: string; shell: { bin: string; loginArgs: string[] } }
	| { kind: "disabled"; reason: string }
	| { kind: "unavailable"; reason: string };

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-podman-sandbox", {
		description: "Disable Podman sandboxing for the bash tool (run bash on the host instead)",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let config: PodmanSandboxConfig = DEFAULT_CONFIG;
	let containerName = "";
	let status: SandboxStatus = { kind: "unavailable", reason: "not initialized yet" };
	let ensurePromise: Promise<SandboxStatus> | undefined;

	function setUiStatus(ctx: ExtensionContext | undefined) {
		if (!ctx) return;
		if (status.kind === "ready") {
			ctx.ui.setStatus("podman-sandbox", ctx.ui.theme.fg("accent", `\u{1F512} podman: ${status.containerName.slice(-12)}`));
		} else if (status.kind === "disabled") {
			ctx.ui.setStatus("podman-sandbox", undefined);
		} else {
			ctx.ui.setStatus("podman-sandbox", ctx.ui.theme.fg("warning", "\u26A0 podman: unavailable (fallback to host)"));
		}
	}

	async function initSandbox(ctx?: ExtensionContext): Promise<SandboxStatus> {
		const noSandbox = pi.getFlag("no-podman-sandbox") as boolean;
		if (noSandbox) {
			status = { kind: "disabled", reason: "disabled via --no-podman-sandbox" };
			return status;
		}

		config = loadConfig(ctx?.cwd ?? localCwd);
		if (!config.enabled) {
			status = { kind: "disabled", reason: "disabled via config" };
			return status;
		}

		const version = await podman.podmanVersion();
		if (!version) {
			status = { kind: "unavailable", reason: "podman binary not found on PATH" };
			return status;
		}

		const cwd = ctx?.cwd ?? localCwd;
		containerName = containerNameFor(cwd, config);

		const machineError = await podman.ensureMachineRunning((text) =>
			ctx?.ui.setStatus("podman-sandbox", ctx.ui.theme.fg("accent", `podman: ${text}`)),
		);
		if (machineError) {
			status = { kind: "unavailable", reason: machineError };
			return status;
		}

		try {
			const state = await podman.containerState(containerName);
			if (state === "running") {
				const shell = await podman.probeShell(containerName);
				status = { kind: "ready", containerName, shell };
				return status;
			}
			if (state === "stopped") {
				await podman.startContainer(containerName);
				const shell = await podman.probeShell(containerName);
				status = { kind: "ready", containerName, shell };
				return status;
			}

			const image = config.image ?? DEFAULT_CONFIG.image;
			const hasImage = await podman.imageExistsLocally(image);
			if (!hasImage) {
				await podman.pullImage(image, (text) =>
					ctx?.ui.setStatus("podman-sandbox", ctx.ui.theme.fg("accent", `podman: ${text}`)),
				);
			}
			await podman.runContainer(buildRunArgs(containerName, cwd, config));
			const shell = await podman.probeShell(containerName);
			if (shell.bin === "/bin/sh") {
				ctx?.ui.notify(
					`podman-sandbox: image "${image}" has no bash; falling back to /bin/sh inside the container (some bash-only syntax in commands may fail).`,
					"warning",
				);
			}
			status = { kind: "ready", containerName, shell };
			return status;
		} catch (err) {
			status = { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
			return status;
		}
	}

	async function ensureSandbox(ctx?: ExtensionContext): Promise<SandboxStatus> {
		if (status.kind === "ready") return status;
		if (!ensurePromise) {
			ensurePromise = initSandbox(ctx).finally(() => {
				ensurePromise = undefined;
				setUiStatus(ctx);
			});
		}
		return ensurePromise;
	}

	function createPodmanBashOps(name: string, shell: { bin: string; loginArgs: string[] }): BashOperations {
		return {
			async exec(command, cwd, { onData, signal, timeout, env }) {
				const tag = `pi-sandbox-cmd-${Math.random().toString(36).slice(2)}`;
				return podman.execInContainer(name, command, {
					onData,
					signal,
					timeout: timeout ?? DEFAULT_TIMEOUT_SEC,
					env,
					workdir: GUEST_WORKSPACE,
					tag,
					shell,
				});
			},
		};
	}

	async function runBashRouted(
		id: string,
		params: { command: string; timeout?: number },
		signal: AbortSignal | undefined,
		onUpdate: Parameters<typeof localBash.execute>[3],
		ctx: ExtensionContext,
	) {
		const result = await ensureSandbox(ctx);
		setUiStatus(ctx);

		if (result.kind === "ready") {
			const sandboxedBash = createBashTool(GUEST_WORKSPACE, {
				operations: createPodmanBashOps(result.containerName, result.shell),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		}

		if (result.kind === "unavailable" && config.failClosed) {
			// The bash tool contract marks a result as an error by throwing, not by
			// a returned `isError` field (AgentToolResult has no such field - a
			// literal `isError: true` here is silently ignored by the framework,
			// confirmed empirically: tool_execution_end.isError stayed false until
			// this was changed to throw).
			throw new Error(
				`[podman-sandbox: BLOCKED] Sandbox unavailable (${result.reason}) and failClosed is enabled, so bash execution was refused instead of running unsandboxed on the host. Fix podman (see /podman-sandbox) or set "failClosed": false to allow host fallback.`,
			);
		}

		// Fail-open fallback: run on the host, but make the degraded mode
		// machine-visible in the tool's own output, not just in prose docs.
		const fallback = await localBash.execute(id, params, signal, onUpdate);
		const reason = result.reason;
		const tag = `[podman-sandbox: UNSANDBOXED fallback - ${reason}]\n`;
		return {
			...fallback,
			content: [{ type: "text" as const, text: tag }, ...fallback.content],
		};
	}

	pi.registerTool({
		...localBash,
		label: "bash (podman sandbox)",
		async execute(id, params, signal, onUpdate, ctx) {
			return runBashRouted(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		const result = await ensureSandbox(ctx);
		setUiStatus(ctx);
		if (result.kind !== "ready") return undefined;
		return { operations: createPodmanBashOps(result.containerName, result.shell) };
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureSandbox(ctx);
		setUiStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		let note: string;
		if (status.kind === "ready") {
			note = `bash commands run inside an isolated Podman container (${status.containerName}); read/write/edit/grep/find/ls run on the host and see the same files via a bind mount at ${GUEST_WORKSPACE}.`;
		} else if (status.kind === "unavailable" && config.failClosed) {
			note = `Podman sandbox is not active (${status.reason}) and failClosed is enabled: bash calls will be BLOCKED, not run on the host.`;
		} else {
			note = `Podman sandbox is not active (${status.kind === "unavailable" || status.kind === "disabled" ? status.reason : "unknown"}); bash falls back to running directly on the host, and each fallback result is tagged "[podman-sandbox: UNSANDBOXED fallback ...]".`;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
	});

	pi.on("session_shutdown", async () => {
		if (status.kind === "ready" && !config.keepAlive) {
			await podman.stopContainer(status.containerName);
			await podman.removeContainer(status.containerName);
		}
	});

	pi.registerCommand("podman-sandbox", {
		description: "Show/manage the Podman sandbox container",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "rebuild") {
				if (containerName) {
					await podman.stopContainer(containerName);
					await podman.removeContainer(containerName);
				}
				status = { kind: "unavailable", reason: "rebuilding" };
				const result = await ensureSandbox(ctx);
				setUiStatus(ctx);
				ctx.ui.notify(
					result.kind === "ready" ? `Rebuilt container ${result.containerName}` : `Rebuild failed: ${result.reason}`,
					result.kind === "ready" ? "info" : "error",
				);
				return;
			}
			if (sub === "stop") {
				if (containerName) {
					await podman.stopContainer(containerName);
					ctx.ui.notify(`Stopped ${containerName}`, "info");
				}
				status = { kind: "unavailable", reason: "stopped via /podman-sandbox stop" };
				setUiStatus(ctx);
				return;
			}

			const result = await ensureSandbox(ctx);
			setUiStatus(ctx);
			const lines = [
				"Podman Sandbox:",
				result.kind === "ready" ? `  Status: ready (${result.containerName})` : `  Status: ${result.kind} - ${result.reason}`,
				`  Image: ${config.image ?? DEFAULT_CONFIG.image}`,
				`  Network: ${config.network ?? DEFAULT_CONFIG.network}`,
				`  Workspace mount: ${ctx.cwd} -> ${GUEST_WORKSPACE}`,
				`  Keep alive across sessions: ${Boolean(config.keepAlive)}`,
				`  Fail closed on unavailability: ${Boolean(config.failClosed)}`,
				"",
				"Subcommands: /podman-sandbox rebuild | /podman-sandbox stop",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
