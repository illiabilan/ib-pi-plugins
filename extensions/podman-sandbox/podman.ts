/**
 * Low-level Podman CLI process management.
 *
 * Everything here shells out to the `podman` binary directly via
 * node:child_process (array-argv spawn, never a shell string) - no npm
 * dependency on any container SDK. Kept free of extension/UI concerns so it
 * can be unit-exercised on its own.
 */

import { spawn } from "node:child_process";

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	input?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Run a podman (or arbitrary) CLI command to completion, buffering output. */
export function run(bin: string, args: string[], options: RunOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;

		if (options.timeoutMs && options.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs);
		}

		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (d) => {
			stdout += d.toString("utf8");
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString("utf8");
		});
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (timedOut) {
				reject(new Error(`${bin} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
				return;
			}
			resolve({ code, stdout, stderr });
		});

		if (options.input !== undefined) child.stdin.write(options.input);
		child.stdin.end();
	});
}

/**
 * Checks that the `podman` binary itself is present and executable.
 *
 * Deliberately uses `podman --version` (client-only, never touches the
 * daemon/machine) rather than `podman version` (which reports a non-zero
 * exit code - 125 - when the machine/daemon is unreachable, even though it
 * still prints the client version to stdout first). Using the latter here
 * would misreport "podman not found" whenever the machine is merely
 * stopped, short-circuiting past the machine auto-start logic that's meant
 * to handle exactly that case.
 */
export async function podmanVersion(): Promise<string | undefined> {
	try {
		const r = await run("podman", ["--version"], { timeoutMs: 10_000 });
		if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
	} catch {
		// binary missing or not executable
	}
	return undefined;
}

interface PodmanMachineInfo {
	Name: string;
	Running?: boolean;
	Default?: boolean;
}

/**
 * On macOS/Windows, podman needs a running Linux VM ("podman machine").
 * Returns undefined when no machine is required/found (e.g. native Linux),
 * or an error string describing what's wrong when a machine exists but isn't
 * usable and couldn't be auto-started.
 */
export async function ensureMachineRunning(onStatus: (text: string) => void): Promise<string | undefined> {
	let listResult: ExecResult;
	try {
		listResult = await run("podman", ["machine", "list", "--format", "json"], { timeoutMs: 15_000 });
	} catch (err) {
		// "machine" subcommand unsupported/unavailable (rootful Linux, etc.) - nothing to do.
		return undefined;
	}
	if (listResult.code !== 0) return undefined;

	let machines: PodmanMachineInfo[] = [];
	try {
		machines = JSON.parse(listResult.stdout || "[]");
	} catch {
		return undefined;
	}
	if (!Array.isArray(machines) || machines.length === 0) return undefined;

	if (machines.some((m) => m.Running)) return undefined;

	const target = machines.find((m) => m.Default) ?? machines[0];
	if (!target) return undefined;

	onStatus(`starting podman machine "${target.Name}" (first run can take ~30-60s)...`);
	try {
		const startResult = await run("podman", ["machine", "start", target.Name], { timeoutMs: 120_000 });
		if (startResult.code !== 0) {
			return `podman machine start "${target.Name}" failed: ${startResult.stderr.trim() || startResult.stdout.trim()}`;
		}
	} catch (err) {
		return `podman machine start "${target.Name}" failed: ${err instanceof Error ? err.message : String(err)}`;
	}
	return undefined;
}

export type ContainerState = "running" | "stopped" | "missing";

export async function containerState(name: string): Promise<ContainerState> {
	const r = await run("podman", ["inspect", "--format", "{{.State.Running}}", name], { timeoutMs: 15_000 });
	if (r.code !== 0) return "missing";
	return r.stdout.trim() === "true" ? "running" : "stopped";
}

export async function imageExistsLocally(image: string): Promise<boolean> {
	const r = await run("podman", ["image", "exists", image], { timeoutMs: 15_000 });
	return r.code === 0;
}

export async function pullImage(image: string, onStatus: (text: string) => void): Promise<void> {
	onStatus(`pulling image ${image}...`);
	const r = await run("podman", ["pull", image], { timeoutMs: 10 * 60_000 });
	if (r.code !== 0) {
		throw new Error(`podman pull ${image} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	}
}

export async function startContainer(name: string): Promise<void> {
	const r = await run("podman", ["start", name], { timeoutMs: 30_000 });
	if (r.code !== 0) throw new Error(`podman start ${name} failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

export async function runContainer(args: string[]): Promise<void> {
	const r = await run("podman", ["run", ...args], { timeoutMs: 60_000 });
	if (r.code !== 0) throw new Error(`podman run failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

export async function removeContainer(name: string, force = true): Promise<void> {
	await run("podman", ["rm", ...(force ? ["-f"] : []), name], { timeoutMs: 30_000 }).catch(() => undefined);
}

export async function stopContainer(name: string): Promise<void> {
	await run("podman", ["stop", "-t", "5", name], { timeoutMs: 20_000 }).catch(() => undefined);
}

/** Best-effort kill of a specific tagged exec invocation still running inside the container. */
export async function killTaggedExec(name: string, tag: string): Promise<void> {
	await run("podman", ["exec", name, "pkill", "-9", "-f", tag], { timeoutMs: 10_000 }).catch(() => undefined);
}

/**
 * Not every image ships bash (e.g. `alpine` only has `/bin/sh`/ash). Probe
 * once per container so exec calls use a shell that actually exists instead
 * of failing with a cryptic "exec: bash: no such file or directory" (exit
 * 127) on every single command.
 */
export async function probeShell(containerName: string): Promise<{ bin: string; loginArgs: string[] }> {
	try {
		const r = await run("podman", ["exec", containerName, "sh", "-c", "command -v bash || true"], {
			timeoutMs: 10_000,
		});
		const bashPath = r.stdout.trim();
		if (r.code === 0 && bashPath) return { bin: bashPath, loginArgs: ["-lc"] };
	} catch {
		// fall through to sh
	}
	return { bin: "/bin/sh", loginArgs: ["-c"] };
}

export interface ExecStreamOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	workdir: string;
	/** Unique tag appended as the shell's $0, used for best-effort abort-time pkill -f matching. */
	tag: string;
	/** Shell binary + invocation args to run the command with (from probeShell). Defaults to bash -lc. */
	shell?: { bin: string; loginArgs: string[] };
}

/** Stream-execute a command inside a running container via `podman exec`. */
export function execInContainer(
	containerName: string,
	command: string,
	options: ExecStreamOptions,
): Promise<{ exitCode: number | null }> {
	const args = ["exec", "-i", "--workdir", options.workdir];
	if (options.env) {
		for (const [key, value] of Object.entries(options.env)) {
			if (typeof value === "string") args.push("-e", `${key}=${value}`);
		}
	}
	args.push(containerName);

	// Container-side timeout enforcement: `timeout` reliably signals the whole
	// process group inside the container's PID namespace, which is more robust
	// than trying to kill across the podman-exec client/server boundary from
	// the host. `-k 2` sends SIGKILL 2s after SIGTERM if the process ignores it.
	if (options.timeout && options.timeout > 0) {
		args.push("timeout", "-k", "2", `${options.timeout}s`);
	}
	// Extra positional args after the shell script become the shell's $0, $1,
	// ... and are part of the shell process's own argv (visible in the
	// container's process table), so `pkill -f <tag>` can target this exact
	// invocation on abort.
	const shell = options.shell ?? { bin: "bash", loginArgs: ["-lc"] };
	args.push(shell.bin, ...shell.loginArgs, command, options.tag);

	return new Promise((resolve, reject) => {
		const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;

		// Host-side backstop timeout in case the container-side `timeout` above
		// didn't apply (e.g. no timeout requested but caller still passed one
		// via a different path) - kept slightly longer than the container-side
		// deadline so the container-side path wins first when both are set.
		if (options.timeout && options.timeout > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, (options.timeout + 5) * 1000);
		}

		child.stdout?.on("data", options.onData);
		child.stderr?.on("data", options.onData);

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});

		const onAbort = () => {
			child.kill("SIGKILL");
			// Best-effort: also try to stop the in-container process tree. Fire
			// and forget - we don't want abort to hang waiting on this.
			void killTaggedExec(containerName, options.tag);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
			} else if (timedOut) {
				reject(new Error(`timeout:${options.timeout}`));
			} else {
				resolve({ exitCode: code });
			}
		});
	});
}
