# podman-sandbox

Routes pi's `bash` tool (and `!`/`!!` user-bash commands) into an isolated
**Podman** container instead of running them directly on the host.

## How it works

- One long-lived, sleeping container per project directory (`podman run -d
  ... sleep infinity`), reused across `bash` calls within a session.
- The host project directory is bind-mounted read/write into the container
  at `/workspace`. Because it's a bind mount, `read`, `write`, `edit`,
  `grep`, `find`, and `ls` are **not** overridden - they keep running on the
  host and see exactly the same files the container sees. Only *process
  execution* is isolated: separate filesystem root, separate PID namespace,
  dropped Linux capabilities, `no-new-privileges`, and (by default) a
  separate network namespace.
- Because the whole `pi` process still runs on the host, provider API keys
  and pi's own session/auth files never enter the container - unlike running
  the entire `pi` process inside a container (see Pi's `containerization.md`
  "Plain Docker" pattern). Only what you put in `env`/`extraMounts` is
  exposed to the sandbox.
- On macOS/Windows, a stopped `podman machine` is started automatically
  (first boot can take ~20-60s; subsequent calls in the same session reuse
  the already-running container).

## Setup

```bash
# Requires podman on PATH (macOS/Windows also need `podman machine init`
# done once; this extension auto-starts a stopped machine, but won't
# create one from scratch).
cp -R extensions/podman-sandbox ~/.pi/agent/extensions/
cd /path/to/project
pi   # or: pi -e /path/to/podman-sandbox for a one-off test
```

## Usage

- `pi -e ./podman-sandbox` - sandbox active with default/config settings
- `pi --no-podman-sandbox` - disable, run bash on the host
- `/podman-sandbox` - show current status (container, image, network, flags)
- `/podman-sandbox rebuild` - stop, remove, and recreate the container
  (e.g. after changing the image)
- `/podman-sandbox stop` - stop the container now

## Config

Merged, project overrides global:

- `~/.pi/agent/extensions/podman-sandbox.json` (global)
- `<project>/.pi/podman-sandbox.json` (project-local)

```json
{
  "enabled": true,
  "image": "docker.io/library/node:22-bookworm-slim",
  "network": "bridge",
  "memory": "4g",
  "cpus": "4",
  "pidsLimit": 512,
  "readOnlyRootfs": false,
  "dropAllCapabilities": true,
  "noNewPrivileges": true,
  "env": { "CI": "true" },
  "extraMounts": [{ "hostPath": "~/.cache/npm", "containerPath": "/root/.npm" }],
  "keepAlive": false,
  "failClosed": false
}
```

- **`image`**: any Podman/Docker-compatible image. Doesn't need bash - the
  extension probes for it and falls back to `/bin/sh` (with a one-time
  warning) for shells like Alpine's ash that don't ship bash.
- **`network`**: `"bridge"` (default, isolated netns + outbound internet),
  `"none"` (fully isolated, no network), or `"host"` (defeats network
  isolation - only for compatibility).
- **`keepAlive`**: if `false` (default), the container is stopped and
  removed on `session_shutdown` (ephemeral). If `true`, it's left running so
  the next session reuses it immediately instead of paying container-create
  cost again. A config change (different image, mounts, etc.) always forces
  a fresh container - the container name is a hash of `{cwd, config}`, so
  stale settings are never silently reused.
- **`failClosed`**: if the sandbox is unavailable (podman missing, machine
  won't start, container creation failed) and `failClosed` is `false`
  (default), `bash` **falls back to running directly on the host** and tags
  the tool result: `[podman-sandbox: UNSANDBOXED fallback - <reason>]`. This
  fail-open behavior matches this repo's other `sandbox` extension. Set
  `failClosed: true` to instead refuse execution (`[podman-sandbox:
  BLOCKED] ...`, marked as a tool error) rather than ever running
  unsandboxed - use this if the sandbox is a hard security requirement, not
  a best-effort convenience.

## Known limitations (found during validation, not just theoretical)

- **Abort is best-effort, not a guaranteed full process-tree kill.** A
  timeout is enforced *inside* the container via the `timeout` command
  (reliable - confirmed to kill within the requested window even for a
  detached `sleep`). A user-triggered abort (Esc) without an explicit
  timeout only reliably kills the top-level shell process for that call
  (matched via a per-call tag in its argv) - grandchild processes it may
  have spawned are not individually hunted down. They're cleaned up when the
  container is removed (default: end of session).
- **`network: "bridge"` allows outbound internet from the sandbox.** It
  isolates the container's network namespace from the host's, but does not
  block internet access. There's no allow/deny-list proxy in this version
  (unlike the OS-level `sandbox` extension's domain allowlist) - use
  `network: "none"` if you need to guarantee no network access at all.
- **`readOnlyRootfs: false` by default** for out-of-the-box compatibility
  with tools that write outside `/workspace` (e.g. global npm/pip caches
  under a container-local home directory). Set it to `true` for a stricter
  posture once you've confirmed your workflow doesn't need root-fs writes
  outside the bind mount.
- Podman machine auto-start only *starts* an existing machine; it does not
  run `podman machine init` for you on a fresh install.
