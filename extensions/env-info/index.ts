/**
 * env_info — environment probing for Pi, with always-on secret redaction.
 *
 * Replaces the environment-probe bash calls that showed up ~28x in real session
 * traces, and removes the need for the agent to invent secret masking on the fly:
 *
 *   which gh / command -v node / type -p rg          -> action:"tools"
 *   env | grep -i API_KEY | sed (hand-rolled masking)   -> action:"env"   (never returns values)
 *   echo $JAVA_HOME / printenv FOO                   -> action:"env"
 *   node -v; uname -sm; echo $SHELL                  -> action:"runtime"
 *   pi --version; readlink ~/.pi/agent/extensions/X  -> action:"pi"
 *   node -e "require('./package.json')" / npm view   -> action:"package"
 *
 * Hard rule: no parameter can disable redaction. Secret values are filtered at
 * extraction time, so they never reach the tool text, `details`, or the session
 * JSONL. Fingerprints are HMACs under a per-process random salt: stable inside
 * one pi process (so "did this change?" is answerable), useless outside it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { access, lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse as parsePath } from "node:path";

/** Hard cap on returned text, mirroring the other extensions in this repo. */
const MAX_TEXT = 24_000;
/** Max tools probed in one call (each may spawn up to 2 short-lived processes). */
const MAX_TOOLS = 24;
/** Max env vars reported in one call. */
const MAX_ENV_VARS = 200;
/** Max declared dependencies listed for action=package. */
const MAX_DEPS = 80;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_TIMEOUT_MS = 20_000;
/** Longest non-secret value echoed verbatim. */
const MAX_VALUE_CHARS = 400;

/* ------------------------------------------------------------------ *
 * Secret handling
 * ------------------------------------------------------------------ */

/** Per-process salt. Never printed, never persisted — makes fingerprints non-reversible. */
const FP_SALT = randomBytes(32);

/** Names that are treated as credentials no matter what the value looks like. */
const SECRET_NAME_RE =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PWD$|PASSPHRASE|CREDENTIAL|CREDS|COOKIE|AUTH|BEARER|PRIVATE|SIGNING|SALT|OTP|SESSION_ID)/i;

/** Known credential shapes — checked even for otherwise-safe variable names. */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["openai-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["atlassian-token", /\bATATT[A-Za-z0-9_\-=]{20,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["pem-private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["url-embedded-credentials", /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/],
];

/**
 * Names whose values are structurally boring but long/diverse enough to trip the
 * entropy heuristic (PATH above all). Being on this list ONLY exempts a value from
 * the entropy heuristic — the secret-name rule and the credential-pattern rule still
 * apply, so `PATH` containing a `ghp_...` segment is still redacted.
 */
const ENTROPY_EXEMPT_NAMES = new Set([
  "PATH", "MANPATH", "INFOPATH", "PYTHONPATH", "CLASSPATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "HOME", "PWD", "OLDPWD", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHLVL", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "EDITOR", "VISUAL", "PAGER", "CI", "NODE_ENV",
  "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_USER_HOME", "GOPATH", "GOROOT",
  "VIRTUAL_ENV", "CONDA_PREFIX", "NVM_DIR", "SDKMAN_DIR", "HOMEBREW_PREFIX", "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY", "LS_COLORS", "LSCOLORS", "DISPLAY", "SSH_AUTH_SOCK", "XPC_SERVICE_NAME",
]);

/** Shannon entropy in bits/char. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/;

/**
 * Heuristic "this segment looks like a credential" test. Deliberately biased toward
 * false positives (over-redaction) because the failure cost is asymmetric: a redacted
 * PATH segment is an annoyance, a leaked token in a session log is a security incident.
 */
function looksHighEntropySecret(value: string): boolean {
  for (const seg of value.split(/[\s:;,]+/)) {
    if (seg.length < 20) continue;
    if (/^(~|\.{0,2}\/)/.test(seg) || seg.includes("://")) continue; // path / URL
    if (!/[A-Za-z]/.test(seg) || !/\d/.test(seg)) continue; // needs letters AND digits
    if (seg.includes(".") && !JWT_SHAPE.test(seg)) continue; // dotted identifiers, versions, hostnames
    if (!/^[A-Za-z0-9_\-+=/.]+$/.test(seg)) continue; // prose / punctuation-heavy
    if (entropy(seg) >= 3.3) return true;
  }
  return false;
}

type Redaction =
  | { secret: false }
  | { secret: true; reason: string };

function classify(name: string, value: string): Redaction {
  if (SECRET_NAME_RE.test(name)) return { secret: true, reason: "secret-name" };
  for (const [label, re] of CREDENTIAL_PATTERNS)
    if (re.test(value)) return { secret: true, reason: `credential-pattern:${label}` };
  if (!ENTROPY_EXEMPT_NAMES.has(name) && looksHighEntropySecret(value))
    return { secret: true, reason: "high-entropy-value" };
  return { secret: false };
}

/**
 * Scrub credential-shaped substrings out of any free text this tool prints from an
 * external source (settings entries, a tool's own --version banner). action=env is not
 * the only way a secret could reach the output: e.g. a pi package spec can embed a git
 * token (`git:x-access-token:<TOKEN>@github.com/...`).
 */
export function scrubText(s: string): string {
  let out = s;
  for (const [label, re] of CREDENTIAL_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    out = out.replace(g, `<redacted:${label}>`);
  }
  return out;
}

/** Salted, truncated HMAC — comparable within this pi process only. */
function fingerprint(value: string): string {
  return createHmac("sha256", FP_SALT).update(value, "utf8").digest("hex").slice(0, 8);
}

/** Make a value safe to print: escape control chars, cap length. */
function displaySafe(value: string): string {
  let out = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  if (out.length > MAX_VALUE_CHARS) out = `${out.slice(0, MAX_VALUE_CHARS)}...(+${out.length - MAX_VALUE_CHARS} chars)`;
  return out;
}

export type EnvVarReport = {
  name: string;
  set: boolean;
  /** Present only for non-secret values. */
  value?: string;
  redacted: boolean;
  /** Why it was redacted; absent when not redacted. */
  reason?: string;
  chars?: number;
  bytes?: number;
  /** First 2 chars, only for redacted values long enough that 2 chars is negligible. */
  prefix?: string;
  /** Salted HMAC-SHA256 prefix; stable within this pi process only. */
  fingerprint?: string;
  empty?: boolean;
};

/**
 * The ONLY place an env value is turned into output. Secret values are dropped here
 * and never propagate to text or `details`.
 */
export function describeEnvVar(name: string, raw: string | undefined): EnvVarReport {
  if (raw === undefined) return { name, set: false, redacted: false };
  const chars = [...raw].length;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (raw.length === 0) return { name, set: true, redacted: false, empty: true, chars: 0, bytes: 0 };
  const verdict = classify(name, raw);
  if (!verdict.secret) return { name, set: true, redacted: false, value: displaySafe(raw), chars, bytes };
  return {
    name,
    set: true,
    redacted: true,
    reason: verdict.reason,
    chars,
    bytes,
    // A 2-char hint is only shown when the value is long enough for it to be
    // information-theoretically negligible; short secrets get no prefix at all.
    ...(raw.length >= 20 ? { prefix: displaySafe(raw.slice(0, 2)) } : {}),
    fingerprint: fingerprint(raw),
  };
}

function envVarLine(r: EnvVarReport, pad: number): string {
  const n = r.name.padEnd(pad);
  if (!r.set) return `  ${n}  unset`;
  if (r.empty) return `  ${n}  set, EMPTY string (len 0)`;
  if (r.redacted) {
    const bits = [
      `set, REDACTED (${r.reason})`,
      `len=${r.chars}${r.bytes !== r.chars ? `/${r.bytes}B` : ""}`,
      r.prefix ? `starts="${r.prefix}"` : "prefix withheld (value too short)",
      `fp=${r.fingerprint}`,
    ];
    return `  ${n}  ${bits.join("  ")}`;
  }
  return `  ${n}  set, ${r.value}`;
}

/* ------------------------------------------------------------------ *
 * Process helper
 * ------------------------------------------------------------------ */

type RunResult = { stdout: string; stderr: string; timedOut: boolean; aborted: boolean; failed: boolean; error?: string };

function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const e = error as (Error & { killed?: boolean; signal?: string; code?: number | string }) | null;
        resolvePromise({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: !!e?.killed && e?.signal === "SIGKILL",
          aborted: e?.name === "AbortError",
          failed: !!e,
          error: e?.message,
        });
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * action: tools
 * ------------------------------------------------------------------ */

const DEFAULT_TOOLS = ["git", "node", "npm", "python3", "rg", "gh", "java", "gradle", "docker"];

/** Tools whose version flag is not `--version`; first entry is tried first. */
const VERSION_FLAGS: Record<string, string[][]> = {
  java: [["-version"], ["--version"]],
  javac: [["-version"]],
  javap: [["-version"]],
  jar: [["--version"], ["-version"]],
  keytool: [["-help"]],
  jarsigner: [["-help"]],
  scalac: [["-version"]],
  kotlinc: [["-version"]],
  go: [["version"]],
  adb: [["--version"], ["version"]],
  dotnet: [["--version"]],
  tsc: [["--version"]],
};

/** `command -v` also resolves builtins; a PATH scan does not. Keep parity explicit. */
const SHELL_BUILTINS = new Set([
  "alias", "bg", "bind", "break", "builtin", "cd", "command", "continue", "declare", "dirs", "echo",
  "eval", "exec", "exit", "export", "fg", "getopts", "hash", "jobs", "kill", "let", "local",
  "printf", "pushd", "popd", "pwd", "read", "readonly", "return", "set", "shift", "source", "test",
  "times", "trap", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait", "which",
]);

export type ToolReport = {
  name: string;
  present: boolean;
  path?: string;
  executable?: boolean;
  version?: string;
  versionLine?: string;
  /** Which flag produced the version (provenance), e.g. "--version". */
  versionSource?: string;
  versionStatus: "ok" | "no-version-output" | "timeout" | "failed" | "skipped" | "not-executable" | "aborted";
  kind?: "binary" | "shell-builtin" | "shell-builtin+binary";
  note?: string;
};

/** Resolve a bare command name against PATH the way `command -v` does (binaries only). */
async function resolveInPath(name: string): Promise<{ path?: string; executable: boolean; candidates: string[] }> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const candidates: string[] = [];
  let firstFound: { path: string; executable: boolean } | undefined;
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      let st;
      try {
        st = await stat(full); // follows symlinks; a dangling link is "absent"
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      candidates.push(full);
      let executable = true;
      try {
        await access(full, FS.X_OK);
      } catch {
        executable = false;
      }
      // `command -v` only reports executables; keep a non-executable hit as a
      // reportable finding but do not let it mask a later, usable one.
      if (!firstFound || (!firstFound.executable && executable)) firstFound = { path: full, executable };
      if (executable) return { path: full, executable: true, candidates };
    }
  }
  return { path: firstFound?.path, executable: firstFound?.executable ?? false, candidates };
}

function extractVersion(text: string): string | undefined {
  const m = text.match(/\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?/);
  return m?.[0];
}

async function probeTool(name: string, wantVersion: boolean, timeoutMs: number, signal?: AbortSignal): Promise<ToolReport> {
  if (!name || /[/\\\s]/.test(name) || name.startsWith("-")) {
    return {
      name,
      present: false,
      versionStatus: "skipped",
      note: "invalid tool name: pass a bare command name (no slashes, spaces or leading '-'); env_info never executes arbitrary paths",
    };
  }
  const { path, executable } = await resolveInPath(name);
  // Builtins are checked first: a shell resolves its builtin BEFORE PATH, so
  // `command -v cd` prints "cd" even though /usr/bin/cd exists on macOS. Report
  // both facts instead of picking one (verified against `command -v` on macOS).
  if (SHELL_BUILTINS.has(name))
    return {
      name,
      present: true,
      ...(path ? { path, executable } : {}),
      kind: path ? "shell-builtin+binary" : "shell-builtin",
      versionStatus: "skipped",
      note: path
        ? `shell builtin AND a binary at ${path} — a shell runs the builtin (\`command -v\` prints the bare name); version not probed`
        : "shell builtin — no binary in PATH (`command -v` prints the bare name, `which` may report nothing)",
    };
  if (!path) return { name, present: false, versionStatus: "skipped", note: "not found in PATH" };
  if (!executable)
    return {
      name,
      present: true,
      path,
      executable: false,
      kind: "binary",
      versionStatus: "not-executable",
      note: "file exists in PATH but has no execute permission for this user — `command -v` would NOT report it as runnable",
    };
  if (!wantVersion) return { name, present: true, path, executable: true, kind: "binary", versionStatus: "skipped" };

  const attempts = VERSION_FLAGS[name] ?? [["--version"], ["-version"]];
  let last: RunResult | undefined;
  for (const args of attempts) {
    if (signal?.aborted) return { name, present: true, path, executable: true, kind: "binary", versionStatus: "aborted" };
    const r = await run(path, args, timeoutMs, signal);
    last = r;
    if (r.aborted) return { name, present: true, path, executable: true, kind: "binary", versionStatus: "aborted" };
    if (r.timedOut)
      return {
        name,
        present: true,
        path,
        executable: true,
        kind: "binary",
        versionStatus: "timeout",
        versionSource: args.join(" "),
        note:
          `killed after ${timeoutMs}ms — installed but no version output; a larger versionTimeoutMs rarely helps ` +
          `(the binary itself blocks), so treat the version as unknown rather than retrying`,
      };
    // Some tools print the version to stderr and/or exit non-zero; accept any
    // output that actually contains a version-looking token.
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const version = extractVersion(text);
    if (text && version) {
      const line = scrubText(text.split("\n").find((l) => l.includes(version))?.trim() ?? text.split("\n")[0]!.trim());
      return {
        name,
        present: true,
        path,
        executable: true,
        kind: "binary",
        version,
        versionLine: line.slice(0, 160),
        versionSource: args.join(" "),
        versionStatus: "ok",
      };
    }
  }
  return {
    name,
    present: true,
    path,
    executable: true,
    kind: "binary",
    versionStatus: last?.failed ? "failed" : "no-version-output",
    versionSource: attempts.map((a) => a.join(" ")).join(" / "),
    note: last?.failed ? `version probe failed: ${(last.error ?? "").split("\n")[0]!.slice(0, 120)}` : undefined,
  };
}

/** One line per tool: name | version-or-status | path | extra. */
function statusCol(t: ToolReport): string {
  if (!t.present) return "ABSENT";
  if (t.kind?.startsWith("shell-builtin")) return "builtin";
  switch (t.versionStatus) {
    case "ok":
      return t.version ?? "?";
    case "skipped":
      return "installed";
    case "not-executable":
      return "NOT-EXEC";
    default:
      return `?${t.versionStatus}`;
  }
}

function toolLine(t: ToolReport, pad: number, vpad: number): string {
  const n = t.name.padEnd(pad);
  const s = statusCol(t).padEnd(vpad);
  if (!t.present || t.kind?.startsWith("shell-builtin")) return `  ${n}  ${s}  ${t.note ?? ""}`.trimEnd();
  const extra =
    t.versionStatus === "ok" && t.versionLine && t.versionLine !== t.version
      ? `  (${t.versionLine.slice(0, 70)})`
      : t.note
        ? `  — ${t.note}`
        : "";
  return `  ${n}  ${s}  ${t.path}${extra}`;
}

/* ------------------------------------------------------------------ *
 * action: runtime
 * ------------------------------------------------------------------ */

/** Markers a profile-sourced login/interactive shell normally leaves in the environment. */
const LOGIN_SHELL_MARKERS: Array<[string, () => boolean]> = [
  ["SHLVL set", () => !!process.env.SHLVL],
  ["TERM set", () => !!process.env.TERM],
  ["TERM_PROGRAM / __CFBundleIdentifier set", () => !!(process.env.TERM_PROGRAM || process.env.__CFBundleIdentifier)],
  ["zsh/bash profile vars (ZDOTDIR, ZSH, BASH_ENV)", () => !!(process.env.ZDOTDIR || process.env.ZSH || process.env.BASH_ENV)],
  ["HOMEBREW_* (brew shellenv ran)", () => !!(process.env.HOMEBREW_PREFIX || process.env.HOMEBREW_CELLAR)],
  ["version-manager vars (NVM_DIR, SDKMAN_DIR, PYENV_ROOT, RBENV_ROOT)", () =>
    !!(process.env.NVM_DIR || process.env.SDKMAN_DIR || process.env.PYENV_ROOT || process.env.RBENV_ROOT)],
  ["PATH contains profile-added dirs", () => {
    const p = process.env.PATH ?? "";
    return /\/opt\/homebrew\/bin|\/usr\/local\/bin|\.local\/bin|\.sdkman|\.nvm|\.cargo\/bin|\.rbenv/.test(p);
  }],
];

/* ------------------------------------------------------------------ *
 * action: pi
 * ------------------------------------------------------------------ */

type PiInfo = {
  version: string;
  /** running-process = read from the package.json of the pi CLI actually executing (authoritative). */
  versionSource: "running-process" | "imported-module" | "unknown";
  packageDir?: string;
  configDir: string;
  configDirSource: "pi-api" | "PI_CODING_AGENT_DIR" | "derived-from-home";
  /** Set when a bundled copy of the pi module reports a different version than the running CLI. */
  moduleVersionMismatch?: string;
};

/**
 * Find the package.json of the pi CLI that is ACTUALLY running, by walking up from
 * argv[1]. This is deliberately preferred over the VERSION exported by an imported
 * `@earendil-works/pi-coding-agent`: an extension with its own node_modules resolves
 * that import to its bundled devDependency copy, which can be a different version
 * than the pi you are running (caught empirically — the module import reported the
 * extension's local copy, not the CLI).
 */
async function runningPiPackage(): Promise<{ version: string; dir: string } | null> {
  const seeds = [process.argv[1], process.env.PI_PACKAGE_DIR, process.execPath].filter(Boolean) as string[];
  for (const seed of seeds) {
    let dir = dirname(seed);
    for (let i = 0; i < 8 && dir && dir !== parsePath(dir).root; i++) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        if (typeof pkg.version === "string" && String(pkg.name ?? "").includes("pi-coding-agent"))
          return { version: pkg.version, dir };
      } catch {
        /* keep walking */
      }
      dir = dirname(dir);
    }
    // `pi` on PATH is usually a symlink into the real package dir; follow it once.
    try {
      const real = await realpath(seed);
      if (real !== seed) {
        let d = dirname(real);
        for (let i = 0; i < 8 && d && d !== parsePath(d).root; i++) {
          try {
            const pkg = JSON.parse(await readFile(join(d, "package.json"), "utf8"));
            if (typeof pkg.version === "string" && String(pkg.name ?? "").includes("pi-coding-agent"))
              return { version: pkg.version, dir: d };
          } catch {
            /* keep walking */
          }
          d = dirname(d);
        }
      }
    } catch {
      /* not a path we can resolve */
    }
  }
  return null;
}

async function piInfo(): Promise<PiInfo> {
  let configDir = "";
  let configDirSource: PiInfo["configDirSource"] = "derived-from-home";
  let configDirName = ".pi";
  let moduleVersion: string | undefined;
  let modulePackageDir: string | undefined;

  try {
    const mod: any = await import("@earendil-works/pi-coding-agent");
    if (typeof mod.VERSION === "string") moduleVersion = mod.VERSION;
    if (typeof mod.CONFIG_DIR_NAME === "string") configDirName = mod.CONFIG_DIR_NAME;
    if (typeof mod.getPackageDir === "function") modulePackageDir = mod.getPackageDir();
    if (typeof mod.getAgentDir === "function") {
      configDir = mod.getAgentDir();
      configDirSource = "pi-api";
    }
  } catch {
    /* fall through to filesystem/env fallbacks below */
  }

  if (!configDir) {
    if (process.env.PI_CODING_AGENT_DIR) {
      configDir = process.env.PI_CODING_AGENT_DIR;
      configDirSource = "PI_CODING_AGENT_DIR";
    } else {
      configDir = join(homedir(), configDirName, "agent");
      configDirSource = "derived-from-home";
    }
  }

  const running = await runningPiPackage();
  if (running)
    return {
      version: running.version,
      versionSource: "running-process",
      packageDir: running.dir,
      configDir,
      configDirSource,
      ...(moduleVersion && moduleVersion !== running.version ? { moduleVersionMismatch: moduleVersion } : {}),
    };
  if (moduleVersion)
    return { version: moduleVersion, versionSource: "imported-module", packageDir: modulePackageDir, configDir, configDirSource };
  return { version: "unknown", versionSource: "unknown", packageDir: modulePackageDir, configDir, configDirSource };
}

type ExtEntry = { name: string; kind: string; target?: string; broken?: boolean; entry?: string };

async function listExtensions(dir: string): Promise<ExtEntry[] | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return null;
  }
  const out: ExtEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const e: ExtEntry = { name, kind: "?" };
    try {
      const l = await lstat(full);
      if (l.isSymbolicLink()) {
        e.kind = "symlink";
        e.target = await readlink(full);
        try {
          e.target = await realpath(full);
          const st = await stat(full);
          e.kind = st.isDirectory() ? "dir via symlink" : "file via symlink";
        } catch {
          e.broken = true;
        }
      } else if (l.isDirectory()) e.kind = "dir";
      else e.kind = "file";
      if (!e.broken && (e.kind === "dir" || e.kind === "dir via symlink")) {
        const inner = await readdir(full).catch(() => [] as string[]);
        e.entry = inner.includes("index.ts") ? "index.ts" : (inner.find((f) => f.endsWith(".ts")) ?? "NO .ts ENTRY POINT");
      }
    } catch (err: any) {
      e.kind = `unreadable (${err?.code ?? "error"})`;
    }
    out.push(e);
  }
  return out;
}

async function listNames(dir: string): Promise<string[] | null> {
  try {
    return (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * action: package
 * ------------------------------------------------------------------ */

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

type DepReport = {
  name: string;
  declared?: string;
  section?: string;
  installed?: string;
  installedPath?: string;
  /** Where the installed version came from — node_modules resolution is exact, registry is network. */
  installedSource?: "node_modules" | "none";
  latest?: string;
  latestSource?: "registry.npmjs.org";
  latestError?: string;
  rangeCheck: "ok" | "mismatch" | "unknown" | "not-installed" | "not-declared";
};

async function findPackageJson(startDir: string): Promise<{ path: string; walkedUp: boolean } | null> {
  let dir = startDir;
  const direct = join(dir, "package.json");
  try {
    await access(direct, FS.R_OK);
    return { path: direct, walkedUp: false };
  } catch {
    /* walk up */
  }
  for (let i = 0; i < 12; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const cand = join(dir, "package.json");
    try {
      await access(cand, FS.R_OK);
      return { path: cand, walkedUp: true };
    } catch {
      /* keep walking */
    }
  }
  return null;
}

async function findInstalled(startDir: string, name: string): Promise<{ version?: string; path?: string }> {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const cand = join(dir, "node_modules", name, "package.json");
    try {
      const pkg = JSON.parse(await readFile(cand, "utf8"));
      if (typeof pkg.version === "string") return { version: pkg.version, path: dirname(cand) };
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

/**
 * Conservative range check. Only ranges whose semantics are unambiguous are judged;
 * everything else reports "unknown" rather than guessing (a wrong "mismatch" would be
 * worse than no answer).
 */
function rangeSatisfied(range: string | undefined, installed: string | undefined): DepReport["rangeCheck"] {
  if (!installed) return range ? "not-installed" : "unknown";
  if (!range) return "not-declared";
  const r = range.trim();
  if (r === "*" || r === "" || r === "latest") return "ok";
  const iv = installed.match(/^(\d+)\.(\d+)\.(\d+)/);
  const rv = r.match(/^([\^~]?)v?(\d+)\.(\d+)\.(\d+)/);
  if (!iv || !rv || !/^[\^~]?v?\d+\.\d+\.\d+/.test(r) || /[\s|<>=]/.test(r)) return "unknown";
  const [, op, Ma, mi, pa] = rv;
  const [ma, mn, pt] = [Number(iv[1]), Number(iv[2]), Number(iv[3])];
  const [rMa, rMi, rPa] = [Number(Ma), Number(mi), Number(pa)];
  const gte = ma > rMa || (ma === rMa && (mn > rMi || (mn === rMi && pt >= rPa)));
  if (op === "^") {
    const sameLine = rMa > 0 ? ma === rMa : rMi > 0 ? ma === 0 && mn === rMi : ma === 0 && mn === 0 && pt === rPa;
    return gte && sameLine ? "ok" : "mismatch";
  }
  if (op === "~") return gte && ma === rMa && mn === rMi ? "ok" : "mismatch";
  return `${ma}.${mn}.${pt}` === `${rMa}.${rMi}.${rPa}` ? "ok" : "mismatch";
}

async function fetchLatest(name: string, signal?: AbortSignal): Promise<{ latest?: string; error?: string }> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6_000);
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.split("/").map(encodeURIComponent).join("/")}/latest`, {
        signal: ac.signal,
        headers: { Accept: "application/vnd.npm.install-v1+json" },
      });
      if (!res.ok) return { error: `registry HTTP ${res.status}` };
      const j: any = await res.json();
      return { latest: typeof j?.version === "string" ? j.version : undefined, error: j?.version ? undefined : "no version in registry response" };
    } finally {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch (e: any) {
    return { error: e?.name === "AbortError" ? "registry request timed out/aborted" : `registry request failed: ${e?.message ?? e}` };
  }
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

const ACTIONS = ["tools", "env", "runtime", "pi", "package"] as const;

const schema = Type.Object({
  action: Type.Union(
    ACTIONS.map((a) => Type.Literal(a)),
    {
      description:
        "tools=CLIs+versions; env=env vars (secrets redacted); runtime=node/platform/cwd/shell/env-source; pi=version+config dirs+extensions; package=declared vs installed deps.",
    },
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: 'tools: bare command names, e.g. ["gh","gradle","adb"]. No paths/slashes. Default: common dev tools.',
    }),
  ),
  envVars: Type.Optional(
    Type.Array(Type.String(), { description: 'env: exact names, e.g. ["JAVA_HOME","JIRA_API_TOKEN"]. Unset names are reported as unset.' }),
  ),
  envPattern: Type.Optional(
    Type.String({ description: 'env: case-insensitive regex over variable NAMES, e.g. "API_KEY|TOKEN" or "^JIRA_".' }),
  ),
  projectDir: Type.Optional(Type.String({ description: "package: dir to inspect (default cwd); node_modules searched upward from there." })),
  packages: Type.Optional(
    Type.Array(Type.String(), { description: 'package: dependency names, e.g. ["typescript"]. Omit for all declared deps.' }),
  ),
  includePackageVersions: Type.Optional(
    Type.Boolean({ description: "package: resolve INSTALLED versions from node_modules (default true when `packages` is given)." }),
  ),
  includeLatest: Type.Optional(
    Type.Boolean({ description: "package: also query npm for the latest published version (NETWORK). Default false.", default: false }),
  ),
  includeToolVersions: Type.Optional(
    Type.Boolean({ description: "tools: run version flags (default true; false = fast presence-only check).", default: true }),
  ),
  versionTimeoutMs: Type.Optional(
    Type.Number({ description: `tools: per-probe timeout ms (default ${DEFAULT_VERSION_TIMEOUT_MS}, max ${MAX_VERSION_TIMEOUT_MS}); a hang reports ?timeout, not absent.` }),
  ),
});

export type EnvInfoInput = Static<typeof schema>;

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

const REDACTION_FOOTER =
  "secret_redaction: always-on (no parameter can disable it). Redacted entries show length + a per-process salted fingerprint (fp), never the value; fp values are comparable within this pi session only.";

async function runTools(p: EnvInfoInput, signal?: AbortSignal) {
  const requested = (p.tools?.length ? p.tools : DEFAULT_TOOLS).slice(0, MAX_TOOLS);
  const dropped = (p.tools?.length ?? DEFAULT_TOOLS.length) - requested.length;
  const timeout = Math.min(Math.max(500, p.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS), MAX_VERSION_TIMEOUT_MS);
  const wantVersion = p.includeToolVersions !== false;
  // Parallel: one slow/hanging tool must not serialize the rest.
  const reports = await Promise.all(requested.map((t) => probeTool(t, wantVersion, timeout, signal)));
  const pad = Math.max(4, ...reports.map((r) => r.name.length));
  const vpad = Math.max(6, ...reports.map((r) => statusCol(r).length));
  const present = reports.filter((r) => r.present).length;
  const odd = reports.filter((r) => r.present && r.versionStatus !== "ok" && r.versionStatus !== "skipped" && !r.kind?.startsWith("shell-builtin"));
  const lines = [
    `env_info tools — ${present}/${reports.length} present${wantVersion ? "" : " (version probing skipped)"}` +
      (dropped > 0 ? `; ${dropped} name(s) dropped (max ${MAX_TOOLS} per call)` : ""),
    "columns: name | version-or-status | resolved path",
    "",
    ...reports.map((r) => toolLine(r, pad, vpad)),
    ...(odd.length
      ? [
          "",
          "note: ABSENT = not installed. NOT-EXEC = file present but not runnable. " +
            "?timeout / ?no-version-output / ?failed = INSTALLED but version could not be determined — do not treat these as missing.",
        ]
      : []),
  ];
  return { text: lines.join("\n"), details: { action: "tools", timeoutMs: timeout, tools: reports } };
}

async function runEnv(p: EnvInfoInput) {
  const all = Object.keys(process.env);
  const secretNames = all.filter((n) => SECRET_NAME_RE.test(n)).sort();
  let names: string[] = [];
  let mode = "";

  if (p.envVars?.length) {
    names.push(...new Set(p.envVars)); // a repeated name must not produce duplicate rows
    mode = `${new Set(p.envVars).size} requested name(s)`;
  }
  if (p.envPattern) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(p.envPattern, "i");
    } catch (e: any) {
      // Invalid input is a real failure: THROW so the agent loop marks the tool
      // call as an error (a returned `isError` field is ignored by pi — verified
      // in pi-agent-core/dist/agent-loop.js, only a thrown error sets isError).
      throw new Error(
        `env_info: invalid envPattern regex ${JSON.stringify(p.envPattern)}: ${e?.message ?? e}. ` +
          `envPattern is a JS regex matched against variable NAMES (case-insensitive), e.g. "API_KEY|TOKEN" or "^JIRA_".`,
      );
    }
    const hits = all.filter((n) => re!.test(n)).sort();
    names.push(...hits.filter((n) => !names.includes(n)));
    mode += `${mode ? " + " : ""}pattern /${p.envPattern}/i (${hits.length} match)`;
  }
  if (!names.length && !p.envVars?.length && !p.envPattern) {
    names = [
      "PATH", "HOME", "SHELL", "USER", "LANG", "TERM", "TMPDIR", "CI", "NODE_ENV",
      "JAVA_HOME", "ANDROID_HOME", "GRADLE_USER_HOME", "VIRTUAL_ENV", "PI_CODING_AGENT_DIR",
    ];
    mode = "default common-variable set (pass envVars or envPattern to target specific ones)";
  }
  const truncated = names.length > MAX_ENV_VARS;
  names = names.slice(0, MAX_ENV_VARS);
  const reports = names.map((n) => describeEnvVar(n, process.env[n]));
  const pad = Math.max(4, ...reports.map((r) => r.name.length));
  const redactedCount = reports.filter((r) => r.redacted).length;

  const lines = [
    `env_info env — ${reports.filter((r) => r.set).length}/${reports.length} set, ${redactedCount} redacted ` +
      `(${all.length} variables in the process environment; ${secretNames.length} have credential-like names)`,
    `selection: ${mode}${truncated ? ` [truncated to ${MAX_ENV_VARS} variables]` : ""}`,
    "",
    ...reports.map((r) => envVarLine(r, pad)),
    "",
    `credential-like variable NAMES present (names are safe to show, values are not): ${
      secretNames.length ? secretNames.join(", ") : "(none)"
    }`,
  ];
  return {
    text: lines.join("\n"),
    details: {
      action: "env",
      redaction: "always-on",
      totalEnvVars: all.length,
      credentialLikeNames: secretNames,
      vars: reports,
    },
  };
}

async function runRuntime(ctx: ExtensionContext) {
  const bun = (globalThis as any).Bun;
  const markers = LOGIN_SHELL_MARKERS.map(([label, test]) => ({ label, present: (() => { try { return test(); } catch { return false; } })() }));
  const hits = markers.filter((m) => m.present).length;
  const envSource = hits >= 3 ? "login-shell-like" : hits >= 1 ? "uncertain" : "minimal-like";
  const creds = ["JIRA_USERNAME", "JIRA_API_TOKEN", "JIRA_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((n) => ({
    name: n,
    set: process.env[n] !== undefined && process.env[n] !== "",
  }));

  const lines = [
    "env_info runtime",
    "",
    `  runtime      ${bun ? `bun ${bun.version}` : `node ${process.version}`}  (execPath ${process.execPath})`,
    `  platform     ${platform()} ${arch()}  kernel ${release()}`,
    `  cwd          ${ctx.cwd}`,
    `  tmpdir       ${tmpdir()}`,
    `  pid/ppid     ${process.pid}/${process.ppid}`,
    `  pi mode      ${ctx.mode}  hasUI=${ctx.hasUI}`,
    `  shell        ${process.env.SHELL ?? "(SHELL unset)"}  TERM=${process.env.TERM ?? "(unset)"}  TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "(unset)"}`,
    `  env_source   ${envSource}  (${hits}/${markers.length} login-shell markers)`,
    ...markers.map((m) => `                 ${m.present ? "+" : "-"} ${m.label}`),
    "",
    "  Credential env vars for env-configured extensions (set/unset only, values never read here):",
    ...creds.map((c) => `    ${c.name.padEnd(18)} ${c.set ? "set" : "unset"}`),
    "",
    envSource === "login-shell-like"
      ? "  Interpretation: the process environment looks profile-sourced, so extensions that read credentials from env (e.g. jira) should report config_source: env."
      : "  Interpretation: the environment looks minimal/not profile-sourced. Extensions that read credentials from env may find them missing and fall back to probing a login shell (jira reports config_source: shell-profile in that case) — or fail. Restarting pi from a normal interactive shell fixes it.",
  ];
  return {
    text: lines.join("\n"),
    details: {
      action: "runtime",
      runtime: bun ? { name: "bun", version: bun.version } : { name: "node", version: process.version },
      platform: platform(),
      arch: arch(),
      kernel: release(),
      cwd: ctx.cwd,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      shell: process.env.SHELL ?? null,
      envSource,
      loginShellMarkers: markers,
      credentialVarsSet: creds,
    },
  };
}

async function runPi(ctx: ExtensionContext) {
  const info = await piInfo();
  const globalExtDir = join(info.configDir, "extensions");
  const projectExtDir = join(ctx.cwd, ".pi", "extensions");
  const [globalExts, projectExts, agents, skills, prompts, sessions] = await Promise.all([
    listExtensions(globalExtDir),
    listExtensions(projectExtDir),
    listNames(join(info.configDir, "agents")),
    listNames(join(info.configDir, "skills")),
    listNames(join(info.configDir, "prompts")),
    listNames(join(info.configDir, "sessions")),
  ]);

  let settingsExt: string[] = [];
  let settingsPkgs: string[] = [];
  let settingsNote = "";
  try {
    const s = JSON.parse(await readFile(join(info.configDir, "settings.json"), "utf8"));
    // Package/extension specs can embed credentials (git URLs with tokens) — scrub them.
    settingsExt = Array.isArray(s.extensions) ? s.extensions.map((x: unknown) => scrubText(String(x))) : [];
    settingsPkgs = Array.isArray(s.packages) ? s.packages.map((x: unknown) => scrubText(String(x))) : [];
  } catch (e: any) {
    settingsNote = `settings.json unreadable (${e?.code ?? "error"})`;
  }

  const fmt = (dir: string, list: ExtEntry[] | null) => {
    if (!list) return [`  ${dir}: (directory does not exist)`];
    if (!list.length) return [`  ${dir}: (empty)`];
    const pad = Math.max(4, ...list.map((e) => e.name.length));
    return [
      `  ${dir}: ${list.length} entr${list.length === 1 ? "y" : "ies"}`,
      ...list.map((e) => {
        const bits = [e.kind];
        if (e.target) bits.push(`-> ${e.target}`);
        if (e.broken) bits.push("[BROKEN: symlink target does not exist]");
        if (e.entry) bits.push(`[${e.entry}]`);
        return `    ${e.name.padEnd(pad)}  ${bits.join(" ")}`;
      }),
    ];
  };

  const lines = [
    "env_info pi",
    "",
    `  pi version     ${info.version}  (source: ${info.versionSource})`,
    ...(info.moduleVersionMismatch
      ? [
          `                 NOTE: an imported @earendil-works/pi-coding-agent copy reports ${info.moduleVersionMismatch} — that is a bundled dependency, not the running CLI.`,
        ]
      : []),
    `  package dir    ${info.packageDir ?? "(unresolved)"}`,
    `  config dir     ${info.configDir}  (source: ${info.configDirSource})`,
    `  sessions       ${sessions ? `${sessions.length} entries in ${join(info.configDir, "sessions")}` : "(no sessions dir)"}`,
    "",
    "Extensions:",
    ...fmt(globalExtDir, globalExts),
    ...fmt(projectExtDir, projectExts),
    `  settings.json extensions: ${settingsExt.length ? settingsExt.join(", ") : "(none)"}`,
    `  settings.json packages:   ${settingsPkgs.length ? settingsPkgs.join(", ") : "(none)"}`,
    ...(settingsNote ? [`  ${settingsNote}`] : []),
    "",
    `  agents  (${agents?.length ?? 0}): ${agents?.join(", ") || "(none)"}`,
    `  skills  (${skills?.length ?? 0}): ${skills?.join(", ") || "(none)"}`,
    `  prompts (${prompts?.length ?? 0}): ${prompts?.join(", ") || "(none)"}`,
  ];
  return {
    text: lines.join("\n"),
    details: {
      action: "pi",
      ...info,
      globalExtensionsDir: globalExtDir,
      globalExtensions: globalExts,
      projectExtensionsDir: projectExtDir,
      projectExtensions: projectExts,
      settingsExtensions: settingsExt,
      settingsPackages: settingsPkgs,
      agents,
      skills,
      prompts,
      sessionEntries: sessions?.length ?? null,
    },
  };
}

async function runPackage(p: EnvInfoInput, ctx: ExtensionContext, signal?: AbortSignal) {
  const dir = p.projectDir ? (isAbsolute(p.projectDir) ? p.projectDir : join(ctx.cwd, p.projectDir)) : ctx.cwd;
  const found = await findPackageJson(dir);
  if (!found) {
    return {
      text:
        `env_info package — no package.json found in ${dir} or any parent directory.\n` +
        `This directory is not part of an npm project, so there is nothing to report ` +
        `(no declared ranges, no node_modules resolution). If you expected one, check the path.`,
      details: { action: "package", projectDir: dir, packageJson: null, found: false },
    };
  }
  let pkg: any;
  try {
    pkg = JSON.parse(await readFile(found.path, "utf8"));
  } catch (e: any) {
    return {
      text: `env_info package — ${found.path} exists but is not valid JSON: ${e?.message ?? e}`,
      details: { action: "package", projectDir: dir, packageJson: found.path, parseError: String(e?.message ?? e) },
    };
  }
  const root = dirname(found.path);
  const declared = new Map<string, { range: string; section: string }>();
  for (const section of DEP_SECTIONS)
    for (const [name, range] of Object.entries(pkg[section] ?? {}))
      if (!declared.has(name)) declared.set(name, { range: String(range), section });

  const explicit = !!p.packages?.length;
  const wantInstalled = p.includePackageVersions ?? explicit;
  let names = explicit ? p.packages!.slice() : [...declared.keys()].sort();
  const truncated = names.length > MAX_DEPS;
  names = names.slice(0, MAX_DEPS);

  const deps: DepReport[] = await Promise.all(
    names.map(async (name): Promise<DepReport> => {
      const d = declared.get(name);
      const inst = wantInstalled ? await findInstalled(root, name) : {};
      const rep: DepReport = {
        name,
        declared: d?.range,
        section: d?.section,
        installed: inst.version,
        installedPath: inst.path,
        installedSource: wantInstalled ? (inst.version ? "node_modules" : "none") : undefined,
        rangeCheck: wantInstalled ? rangeSatisfied(d?.range, inst.version) : d ? "unknown" : "not-declared",
      };
      if (p.includeLatest) {
        const { latest, error } = await fetchLatest(name, signal);
        rep.latest = latest;
        rep.latestSource = latest ? "registry.npmjs.org" : undefined;
        rep.latestError = error;
      }
      return rep;
    }),
  );

  const pad = Math.max(4, ...deps.map((d) => d.name.length));
  const lines = [
    `env_info package — ${pkg.name ?? "(unnamed)"}@${pkg.version ?? "?"}  (${found.path}${found.walkedUp ? ` — NOTE: no package.json in ${dir}, used nearest ancestor` : ""})`,
    `  ${declared.size} declared dependencies; showing ${deps.length}${truncated ? ` (truncated to ${MAX_DEPS})` : ""}; ` +
      `installed versions ${wantInstalled ? `resolved from node_modules under ${root}` : "NOT resolved (set includePackageVersions:true)"}` +
      (p.includeLatest ? "; latest from registry.npmjs.org (network)" : ""),
    "",
    ...deps.map((d) => {
      const bits = [
        `declared ${d.declared ? `${d.declared} (${d.section})` : "NOT DECLARED"}`,
        wantInstalled ? `installed ${d.installed ?? "NOT INSTALLED"}` : null,
        p.includeLatest ? `latest ${d.latest ?? `unavailable (${d.latestError})`}` : null,
        wantInstalled ? `[${d.rangeCheck}]` : null,
      ].filter(Boolean);
      return `  ${d.name.padEnd(pad)}  ${bits.join("  ")}`;
    }),
    "",
    "declared = range in package.json (what is requested); installed = version actually present in node_modules (what runs)." +
      (p.includeLatest ? " latest = newest published on npm." : ""),
  ];
  return { text: lines.join("\n"), details: { action: "package", projectDir: dir, packageJson: found.path, packageName: pkg.name ?? null, packageVersion: pkg.version ?? null, declaredCount: declared.size, deps } };
}

/* ------------------------------------------------------------------ *
 * Extension entry point
 * ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "env_info",
    label: "Env Info",
    description: `Probe the environment in one call instead of shelling out:
  tools   — installed CLIs: path + version. Replaces \`which\` / \`command -v\` / \`X --version\`.
  env     — env vars set/unset + length; credential-like values get a salted fingerprint, never the value. Replaces \`env | grep\`, \`printenv\`, \`echo $VAR\`.
  runtime — node/bun, platform/arch, cwd, shell, and whether the env looks login-shell-sourced.
  pi      — pi version, config/extension/agent/skill dirs, extensions + symlink targets. Replaces \`pi --version\` + \`readlink\`.
  package — declared range vs INSTALLED version from node_modules (+ npm latest via includeLatest). Replaces reading package.json / \`npm view\`.
Ex: {"action":"tools","tools":["gh","gradle","kubectl"]} -> gh 2.97.0 /opt/homebrew/bin/gh | kubectl ABSENT.
Secret values are never returned and no parameter disables that.`,
    promptSnippet: "Probe the environment: installed CLIs+versions, env vars (secrets redacted), runtime, pi install/extensions, package versions",
    promptGuidelines: [
      "Use env_info action='tools' instead of bash `which X`/`command -v X`/`X --version`, and action='runtime'/'pi'/'package' instead of `node -v`/`uname`/`pi --version`/`readlink`/hand-reading package.json. Only ABSENT means missing: `?timeout`/`?no-version-output`/`NOT-EXEC` mean installed but version-unknown or not runnable. env_info cannot run tool subcommands (`gh auth status`) — use bash for those.",
      "NEVER inspect environment variables with bash (`env | grep`, `echo $TOKEN`, `printenv`): bash writes the value verbatim into the transcript and session log. Use env_info action='env' — it redacts credential values and has no reveal option.",
      "`REDACTED (reason) len=... fp=...` means the variable IS set and usable — never read it as missing, and do not try to work around the redaction (`fp=` is salted per process, comparable only within this session). If runtime reports env_source other than login-shell-like, expect env-configured extensions (e.g. jira) to lack credentials.",
    ],
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as EnvInfoInput;
      try {
        let out: { text: string; details: Record<string, unknown> };
        switch (p.action) {
          case "tools":
            out = await runTools(p, signal);
            break;
          case "env":
            out = await runEnv(p);
            break;
          case "runtime":
            out = await runRuntime(ctx);
            break;
          case "pi":
            out = await runPi(ctx);
            break;
          case "package":
            out = await runPackage(p, ctx, signal);
            break;
          default:
            throw new Error(
              `env_info: unknown action '${String((p as any).action)}'. Valid actions: ${ACTIONS.join(", ")}.`,
            );
        }
        let text = out.text;
        if (text.length > MAX_TEXT)
          text = `${text.slice(0, MAX_TEXT)}\n... [env_info output truncated at ${MAX_TEXT} chars — narrow the request]`;
        // Footer only for action=env: that is where the redaction contract matters,
        // and repeating it on every action would cost ~60 tokens per call for nothing.
        if (p.action === "env") text += `\n\n${REDACTION_FOOTER}`;
        return { content: [{ type: "text" as const, text }], details: out.details };
      } catch (e: any) {
        // Throw rather than return: pi's agent loop derives isError from a thrown
        // exception and ignores an isError field on the returned result.
        if (e?.name === "AbortError") throw new Error("env_info: cancelled.");
        throw e instanceof Error ? e : new Error(`env_info ${p.action} failed: ${String(e)}`);
      }
    },
    renderCall(args: EnvInfoInput, theme) {
      const a = args ?? ({} as EnvInfoInput);
      const detail =
        a.action === "tools"
          ? (a.tools?.join(", ") ?? "default set")
          : a.action === "env"
            ? (a.envVars?.join(", ") ?? (a.envPattern ? `/${a.envPattern}/i` : "common vars"))
            : a.action === "package"
              ? [a.projectDir ?? ".", a.packages?.join(", ")].filter(Boolean).join(" ")
              : "";
      return new Text(
        `${theme.fg("accent", "env_info")} ${theme.bold(String(a.action ?? "?"))}${detail ? ` ${theme.fg("dim", detail)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Probing environment..."), 0, 0);
      const first = result.content[0];
      const content = (first && "text" in first ? first.text : undefined) ?? "";
      // Errors arrive here as a thrown-error result whose text starts with "env_info".
      if (/^env_info(:| \w+ failed)/.test(content) && !content.includes("\n"))
        return new Text(theme.fg("error", content), 0, 0);
      const lines = content.split("\n");
      if (!expanded && lines.length > 18)
        return new Text(`${lines.slice(0, 18).join("\n")}\n... and ${lines.length - 18} more lines`, 0, 0);
      return new Text(content, 0, 0);
    },
  });
}
