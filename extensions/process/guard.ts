/**
 * process-guard — destructive-command interception for the `process` tool.
 *
 * Rationale: `process {action:"start"}` spawns a DETACHED shell command that is
 * never previewed and runs outside pi's lifetime. That makes it the single most
 * dangerous surface in this extension: `rm -rf ~`, `dd of=/dev/disk0`,
 * `curl … | sh` would all execute happily and keep running after pi exits.
 *
 * Design goals, in order:
 *   1. NEVER ask the user to approve anything. Commands are either allowed
 *      silently, allowed with a one-line note (warn), or refused outright.
 *      There is no confirm dialog and no token dance.
 *   2. Precision over recall for WARN, recall over precision for BLOCK on the
 *      few genuinely irreversible shapes (wiping a disk, deleting $HOME/cwd/
 *      system paths, piping the network into a shell, exfiltrating secrets).
 *   3. No agent-usable bypass. No escape comment, no "run it anyway" flag.
 *      Only the human can relax it (`/procguard off|warn`, PI_PROCESS_GUARD,
 *      or by typing the command verbatim themselves).
 *   4. Fail OPEN on internal errors: a bug in here must not make `process`
 *      unusable — see the try/catch at the call site in index.ts.
 *
 * Detection is a real (small) shell parser, not a regex list: commands are
 * split into pipeline segments with quote/escape/heredoc/subshell handling,
 * wrappers (`sudo`, `env`, `nohup`, `timeout`, `xargs`, `bash -c …`) are peeled
 * off, `$VAR` is resolved from inline assignments and the environment, and
 * paths are normalized against cwd before being risk-classified. A handful of
 * raw-text regexes run in parallel as a safety net for anything the parser
 * fails to model (obfuscation, exotic quoting) — findings from both are merged.
 */

import { basename, isAbsolute, resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GuardMode = "on" | "warn" | "off";

export type GuardEnv = {
  /** Working directory the command would run in. */
  cwd: string;
  /** Home directory (default: $HOME). */
  home?: string;
  /** Variable table for $VAR resolution (default: process.env). */
  vars?: Record<string, string | undefined>;
};

export type Finding = {
  risk: "block" | "warn";
  /** Stable machine-readable id, e.g. "rm-recursive-protected". */
  rule: string;
  /** One sentence: what is wrong. */
  why: string;
  /** The offending fragment of the command. */
  evidence: string;
  /** Concrete alternatives shown to the agent. */
  advice?: string[];
  /**
   * Catastrophic and machine-wide: refused even when the user typed the command
   * verbatim. Only an explicit mode change (`/procguard off|warn`) lets it run,
   * because "the human pasted it" is too cheap a signal for wiping a disk.
   */
  hard?: boolean;
};

/** Rules that are never waived by the verbatim-user-command bypass. */
export const HARD_RULES = new Set([
  "fork-bomb",
  "filesystem-destroyer",
  "dd-to-block-device",
  "write-to-block-device",
  "rm-no-preserve-root",
  "remote-code-execution",
  "obfuscated-execution",
  "secret-exfiltration",
  "keychain-dump",
  "system-power",
  "kill-everything",
  "account-destruction",
  "crontab-wipe",
  "terraform-destroy",
]);

export const isHard = (f: Finding): boolean => f.risk === "block" && (f.hard === true || HARD_RULES.has(f.rule));

// ---------------------------------------------------------------------------
// Shell-ish parsing
// ---------------------------------------------------------------------------

type Word = {
  /** Text with one level of quoting removed. */
  text: string;
  /** Raw source slice, quotes included. */
  raw: string;
  /** Contains an unquoted expansion ($VAR / `cmd` / $(cmd)). */
  expandable: boolean;
};

type Redirect = { op: ">" | ">>"; target: Word };

type Segment = {
  words: Word[];
  redirects: Redirect[];
  /** Segments sharing a pipeline id are joined by `|`. */
  pipeline: number;
  /** Position inside the pipeline. */
  pos: number;
};

/** Remove heredoc BODIES so documentation/scripts written to disk never match. */
export function stripHeredocs(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const starts = [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((m) => m[2]!);
    if (starts.length === 0) continue;
    const pending = new Set(starts);
    let j = i + 1;
    for (; j < lines.length && pending.size > 0; j++) {
      const t = lines[j]!.trim();
      if (pending.has(t)) pending.delete(t);
    }
    i = j - 1; // body + delimiter consumed
  }
  return out.join("\n");
}

function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

/** Command substitutions, so `sh -c "$(curl …)"` is analysed as a real command. */
function extractSubshells(input: string): string[] {
  const subs: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      i = end === -1 ? input.length : end;
      continue;
    }
    if (c === "$" && input[i + 1] === "(" && input[i + 2] !== "(") {
      const end = matchParen(input, i + 1);
      subs.push(input.slice(i + 2, end));
      i = i + 1; // allow nested detection on the next pass through the body
      continue;
    }
    if (c === "`") {
      const end = input.indexOf("`", i + 1);
      if (end === -1) break;
      subs.push(input.slice(i + 1, end));
      i = end;
    }
  }
  return subs;
}

/** Split a command line into pipeline segments. Best-effort, never throws. */
export function parseSegments(input: string, depth = 0): Segment[] {
  const src = depth === 0 ? stripHeredocs(input) : input;
  const out: Segment[] = [];
  let pipeline = 0;
  let pos = 0;
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let pending: ">" | ">>" | null = null;

  let text = "";
  let raw = "";
  let expandable = false;
  let inWord = false;

  const pushWord = () => {
    if (!inWord) return;
    const w: Word = { text, raw, expandable };
    if (pending) {
      redirects.push({ op: pending, target: w });
      pending = null;
    } else words.push(w);
    text = "";
    raw = "";
    expandable = false;
    inWord = false;
  };
  const endSegment = (newPipeline: boolean) => {
    pushWord();
    if (words.length || redirects.length) {
      out.push({ words, redirects, pipeline, pos });
      pos++;
    }
    words = [];
    redirects = [];
    if (newPipeline) {
      pipeline++;
      pos = 0;
    }
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;

    if (c === "\\") {
      const next = src[i + 1] ?? "";
      if (next !== "\n") {
        text += next;
        raw += c + next;
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      text += src.slice(i + 1, stop);
      raw += src.slice(i, Math.min(stop + 1, n));
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let body = "";
      while (j < n) {
        const d = src[j]!;
        if (d === "\\" && j + 1 < n) {
          body += src[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') break;
        if (d === "$" || d === "`") expandable = true;
        body += d;
        j++;
      }
      text += body;
      raw += src.slice(i, Math.min(j + 1, n));
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      const slice = src.slice(i, end + 1);
      text += slice;
      raw += slice;
      expandable = true;
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      const stop = end === -1 ? n : end;
      const slice = src.slice(i, Math.min(stop + 1, n));
      text += slice;
      raw += slice;
      expandable = true;
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment(true);
      i++;
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === ">") {
        if (inWord && /^[0-9]+$/.test(text)) {
          text = "";
          raw = "";
          inWord = false;
        } else pushWord();
        pending = ">";
        i += 2;
        if (src[i] === ">") i++;
        continue;
      }
      endSegment(true);
      i += src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") {
        endSegment(true);
        i += 2;
      } else {
        endSegment(false);
        i++;
      }
      continue;
    }
    if ((c === "(" || c === ")" || c === "{" || c === "}") && !inWord) {
      endSegment(true);
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      if (inWord && /^[0-9]+$/.test(text)) {
        text = "";
        raw = "";
        inWord = false;
        expandable = false;
      } else pushWord();
      if (c === "<") {
        // heredoc bodies are already stripped; <, <<, <<< need no target tracking
        i++;
        while (src[i] === "<") i++;
        continue;
      }
      let op: ">" | ">>" = ">";
      i++;
      if (src[i] === ">") {
        op = ">>";
        i++;
      } else if (src[i] === "&") {
        i++;
        while (i < n && /[0-9-]/.test(src[i]!)) i++;
        continue; // >&2 — fd duplication, not a file
      } else if (src[i] === "|") i++;
      pending = op;
      continue;
    }

    text += c;
    raw += c;
    inWord = true;
    i++;
  }
  endSegment(true);

  if (depth < 3) {
    let offset = pipeline + 1;
    for (const sub of extractSubshells(src)) {
      for (const seg of parseSegments(sub, depth + 1)) {
        out.push({ ...seg, pipeline: seg.pipeline + offset });
      }
      offset += 100;
    }
  }
  return out;
}

const segText = (s: Segment): string =>
  [...s.words.map((w) => w.raw), ...s.redirects.map((r) => `${r.op} ${r.target.raw}`)].join(" ").trim();

// ---------------------------------------------------------------------------
// Wrapper peeling  (sudo / env / nohup / timeout / xargs / bash -c …)
// ---------------------------------------------------------------------------

type Cmd = {
  /** argv[0] basename, lowercased. */
  base: string;
  /** Everything after argv[0]. */
  args: Word[];
  privileged: boolean;
  /** Operands come from a pipe, not the argv (xargs). */
  fromStdin: boolean;
  /** Inline assignments seen before argv[0] (VAR=value). */
  assigns: Record<string, string>;
  /** `bash -c "<inner>"` / `su -c` payloads to analyse recursively. */
  inner: string[];
};

const FLAG_WITH_VALUE: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-h", "--user", "--group", "--prompt"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  watch: new Set(["-n", "--interval"]),
  xargs: new Set(["-n", "-P", "-I", "-L", "-s", "-d", "-E", "--max-args", "--max-procs", "--replace", "--delimiter"]),
};

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "command",
  "builtin",
  "exec",
  "stdbuf",
  "nice",
  "ionice",
  "setsid",
  "caffeinate",
  "timeout",
  "gtimeout",
  "watch",
  "xargs",
  "script",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash", "fish", "csh", "tcsh"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "osascript"]);

/** Peel wrappers off a segment and describe the real command. */
function toCmd(seg: Segment): Cmd | null {
  const assigns: Record<string, string> = {};
  const inner: string[] = [];
  let privileged = false;
  let fromStdin = false;
  let words = seg.words.slice();

  for (let guard = 0; guard < 8; guard++) {
    // leading VAR=value assignments
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) {
      const w = words.shift()!;
      const eq = w.text.indexOf("=");
      assigns[w.text.slice(0, eq)] = w.text.slice(eq + 1);
    }
    if (words.length === 0) return null;
    const head = words[0]!;
    const base = basename(head.text).toLowerCase();

    if (base === "su") {
      const ci = words.findIndex((w) => w.text === "-c");
      if (ci >= 0 && words[ci + 1]) inner.push(words[ci + 1]!.text);
      return { base: "su", args: words.slice(1), privileged: true, fromStdin, assigns, inner };
    }
    if (SHELLS.has(base)) {
      const ci = words.findIndex((w) => w.text === "-c");
      if (ci >= 0 && words[ci + 1]) inner.push(words[ci + 1]!.text);
    }
    if (!WRAPPERS.has(base)) {
      return { base, args: words.slice(1), privileged, fromStdin, assigns, inner };
    }
    if (base === "sudo" || base === "doas") privileged = true;
    if (base === "xargs") fromStdin = true;

    // consume the wrapper's own flags
    let k = 1;
    const valued = FLAG_WITH_VALUE[base];
    while (k < words.length) {
      const t = words[k]!.text;
      if (t === "--") {
        k++;
        break;
      }
      if (!t.startsWith("-") || t === "-") break;
      if (valued?.has(t)) k += 2;
      else if (/^--[a-z-]+=/.test(t)) k++;
      else k++;
    }
    if ((base === "timeout" || base === "gtimeout") && words[k] && /^[0-9]/.test(words[k]!.text)) k++;
    if (base === "env") {
      while (words[k] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!.text)) {
        const w = words[k]!;
        const eq = w.text.indexOf("=");
        assigns[w.text.slice(0, eq)] = w.text.slice(eq + 1);
        k++;
      }
    }
    words = words.slice(k);
    if (words.length === 0) return null;
  }
  return null;
}

type Flags = { has: (...names: string[]) => boolean; letters: Set<string>; operands: Word[] };

/** Split args into short-letter flags, long flags and operands. */
function splitFlags(args: Word[]): Flags {
  const letters = new Set<string>();
  const longs = new Set<string>();
  const operands: Word[] = [];
  let endOfFlags = false;
  for (const a of args) {
    if (endOfFlags) {
      operands.push(a);
      continue;
    }
    if (a.text === "--") {
      endOfFlags = true;
      continue;
    }
    if (a.text.startsWith("--")) {
      longs.add(a.text.split("=")[0]!);
      continue;
    }
    if (a.text.startsWith("-") && a.text.length > 1 && !/^-[0-9]+$/.test(a.text)) {
      for (const ch of a.text.slice(1)) letters.add(ch);
      continue;
    }
    operands.push(a);
  }
  return {
    letters,
    operands,
    has: (...names: string[]) => names.some((nm) => (nm.startsWith("--") ? longs.has(nm) : letters.has(nm.replace(/^-/, "")))),
  };
}

// ---------------------------------------------------------------------------
// Path risk
// ---------------------------------------------------------------------------

type PathRisk = {
  level: "critical" | "warn" | "safe";
  label: string;
  /** System-wide target (/, /etc, $HOME itself, another user's home, …). */
  hard?: boolean;
};

const SAFE: PathRisk = { level: "safe", label: "" };
const crit = (label: string, hard = false): PathRisk => ({ level: "critical", label, hard });

/** Directories whose whole subtree is off-limits regardless of depth. */
const SYSTEM_PREFIXES = [
  "/bin",
  "/sbin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/sys",
  "/srv",
  "/usr",
  "/System",
  "/Library",
  "/Applications",
  "/Volumes",
  "/cores",
  "/Network",
];

/** Home subtrees that hold credentials, config or the user's own data. */
const HOME_SENSITIVE = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".kube",
  ".docker",
  ".pi",
  ".claude",
  ".gradle",
  ".android",
  ".m2",
  "Library",
  "Documents",
  "Desktop",
  "Downloads",
  "Pictures",
  "Movies",
  "Music",
  "Applications",
];

const SENTINEL = "\u0000VAR\u0000";

type Expanded = { path: string; unresolved: string[]; rootUnresolved: boolean };

/** Resolve ~, $VAR, ${VAR}, ${VAR:-x} against the variable table. */
function expand(textIn: string, env: Required<GuardEnv>, extra: Record<string, string>): Expanded {
  const unresolved: string[] = [];
  let text = textIn;
  if (text === "~") text = env.home;
  else if (text.startsWith("~/")) text = env.home + text.slice(1);

  const lookup = (name: string): string | undefined => extra[name] ?? env.vars[name];
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=?+][^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = (a ?? b) as string;
    const v = lookup(name);
    if (v !== undefined && v !== "") return v;
    unresolved.push(name);
    return SENTINEL;
  });
  return { path: text, unresolved, rootUnresolved: text.startsWith(SENTINEL) };
}

/** Absolute, normalized path for a word, or null when it cannot be resolved. */
function resolveAbs(text: string, env: Required<GuardEnv>, extra: Record<string, string>): string | null {
  const ex = expand(text, env, extra);
  if (ex.rootUnresolved) return null;
  let spec = ex.path;
  if (spec.includes(SENTINEL)) spec = spec.slice(0, spec.indexOf(SENTINEL));
  spec = spec.replace(/\/+$/, "");
  if (!spec) return "/";
  return normalize(spec, env.cwd);
}

function normalize(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolvePath(cwd, p);
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

const isUnder = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

function tmpRoots(env: Required<GuardEnv>): string[] {
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];
  const t = env.vars.TMPDIR;
  if (t) roots.push(normalize(t, env.cwd));
  return roots;
}

/**
 * How dangerous is it to destroy this path? Wildcards are evaluated against
 * their literal parent (`~/*` is as bad as `~`).
 */
export function pathRisk(word: string, env: Required<GuardEnv>, extra: Record<string, string> = {}): PathRisk {
  const t = word.trim();
  if (!t || t.startsWith("-")) return SAFE;

  const ex = expand(t, env, extra);
  let spec = ex.path;

  // a glob expands to "everything in the parent" -> judge the parent
  let wildcard = false;
  if (/[*?[]/.test(spec)) {
    wildcard = true;
    const cut = spec.replace(/\/+$/, "").split("/");
    while (cut.length && /[*?[]/.test(cut[cut.length - 1]!)) cut.pop();
    spec = cut.join("/") || (spec.startsWith("/") ? "/" : ".");
  }
  spec = spec.replace(/\/+$/, "") || "/";

  if (ex.rootUnresolved) {
    return crit(
      `the path starts with an unresolved variable ($${ex.unresolved[0]}) — if it is empty or unset the command operates on ${wildcard ? "/*" : "/"}`,
      true,
    );
  }
  if (spec.includes(SENTINEL)) {
    // variable deeper in the path: keep judging the literal prefix
    spec = spec.slice(0, spec.indexOf(SENTINEL)).replace(/\/+$/, "") || "/";
  }

  const p = normalize(spec, env.cwd);
  const home = normalize(env.home, env.cwd);
  const cwd = normalize(env.cwd, env.cwd);
  const parts = p.split("/").filter(Boolean);

  if (p === "/") return crit("the filesystem root /", true);
  if (parts.includes(".git")) return crit(`git metadata (${p}) — this destroys the repository history`);

  const underTmp = tmpRoots(env).some((r) => isUnder(p, r) && p !== r);
  if (underTmp) return SAFE;

  if (p === cwd) return crit(`the session working directory itself (${p})`);
  if (isUnder(cwd, p)) return crit(`${p} — an ancestor of the session working directory (${cwd})`);
  if (p === home) return crit(`the home directory (${p})`, true);

  if (isUnder(p, home)) {
    const rel = p.slice(home.length + 1).split("/");
    if (HOME_SENSITIVE.includes(rel[0]!)) return crit(`${p} — a protected area of your home directory (~/${rel[0]})`);
    if (rel.length === 1) return crit(`${p} — a top-level entry in your home directory`);
    return SAFE;
  }

  if (parts.length === 1) return crit(`${p} — a top-level directory of the filesystem`, true);
  if (parts[0] === "Users" || parts[0] === "home") {
    if (parts.length <= 2) return crit(`${p} — a user's home directory`, true);
    return crit(`${p} — inside another user's home directory`, true);
  }
  for (const pre of SYSTEM_PREFIXES) if (isUnder(p, pre)) return crit(`${p} — a system location (${pre})`, true);
  if (p.startsWith("/dev/")) return crit(`${p} — a device node`, true);

  return SAFE;
}

const DEVICE_RE = /^\/dev\/(?:disk|rdisk|sd[a-z]|nvme|hd[a-z]|vd[a-z]|md|loop|mmcblk)/i;
const DEV_ALLOWED = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/|urandom|random|ptmx|console)/i;

// ---------------------------------------------------------------------------
// Secret / network heuristics
// ---------------------------------------------------------------------------

const SECRET_RE = new RegExp(
  [
    String.raw`(?:^|/)\.(?:ssh|gnupg|aws|kube|docker|gcloud)(?:/|$)`,
    String.raw`(?:^|/)\.(?:netrc|npmrc|pypirc|pgpass)$`,
    String.raw`\bid_(?:rsa|dsa|ecdsa|ed25519)\b`,
    String.raw`(?:^|/)\.env(?:\.[\w.-]+)?$`,
    String.raw`(?:^|/)credentials(?:\.json)?$`,
    String.raw`(?:^|/)secrets?\.(?:ya?ml|json|env|txt)$`,
    String.raw`\.(?:pem|p12|pfx|jks|keystore)$`,
  ].join("|"),
  "i",
);

const NET_TOOLS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "scp", "sftp", "ssh", "rsync", "ftp", "http", "https", "httpie", "mail", "sendmail", "mailx"]);
const FETCHERS = new Set(["curl", "wget", "fetch", "aria2c", "httpie", "http"]);
const READERS = new Set(["cat", "head", "tail", "base64", "gzip", "gpg", "tar", "zip", "openssl", "xxd", "strings", "dd", "cp", "security"]);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RM_ADVICE = [
  'file_ops {action:"remove", paths:[...], recursive:true} — previewed, refuses protected paths',
  "or narrow the target to a concrete project-local path",
];

function pushUnique(list: Finding[], f: Finding) {
  if (!list.some((x) => x.rule === f.rule && x.evidence === f.evidence)) list.push(f);
}

/** Analyse one already-unwrapped command. */
function inspectCmd(cmd: Cmd, seg: Segment, env: Required<GuardEnv>, findings: Finding[]) {
  const ev = segText(seg).slice(0, 220);
  const vars = cmd.assigns;
  const risk = (w: Word) => pathRisk(w.text, env, vars);
  const block = (rule: string, why: string, advice?: string[], hard?: boolean) =>
    pushUnique(findings, { risk: "block", rule, why, evidence: ev, advice, hard });
  const warn = (rule: string, why: string, advice?: string[]) => pushUnique(findings, { risk: "warn", rule, why, evidence: ev, advice });

  const f = splitFlags(cmd.args);
  const priv = cmd.privileged ? "sudo " : "";

  // --- redirections: >/dev/disk0, >/etc/hosts, >~/.ssh/authorized_keys ------
  for (const r of seg.redirects) {
    const target = r.target.text;
    if (DEVICE_RE.test(target)) {
      block("write-to-block-device", `writes directly to the block device ${target} — that destroys the disk contents`, [
        "if you meant a file, redirect into a path under the project or $TMPDIR",
      ]);
      continue;
    }
    if (DEV_ALLOWED.test(target)) continue;
    const pr = risk(r.target);
    if (pr.level === "critical") {
      block("overwrite-protected-path", `redirects output into ${pr.label}`, [
        "write to a project-local path instead",
        'use the built-in write/append_file tools for file content',
      ]);
    }
  }

  switch (true) {
    // ---------------------------------------------------------------- rm ---
    case cmd.base === "rm" || cmd.base === "unlink" || cmd.base === "rmdir": {
      if (f.has("--no-preserve-root")) {
        block("rm-no-preserve-root", "`--no-preserve-root` exists only to delete `/` — there is no legitimate use of it here", RM_ADVICE);
        break;
      }
      const recursive = cmd.base === "rmdir" ? true : f.has("r", "R", "--recursive", "d");
      for (const op of f.operands) {
        const pr = risk(op);
        if (pr.level === "critical") {
          block(
            recursive ? "rm-recursive-protected" : "rm-protected",
            `${priv}${cmd.base}${recursive ? " -r" : ""} would delete ${pr.label}`,
            RM_ADVICE,
            pr.hard === true,
          );
        }
      }
      if (cmd.fromStdin && recursive) {
        warn("rm-from-stdin", "`xargs rm -r` deletes whatever the previous stage prints — the guard cannot see those paths", [
          "print the list first, check it, then delete explicitly",
        ]);
      }
      break;
    }

    // -------------------------------------------------------------- mv/cp ---
    case cmd.base === "mv" || cmd.base === "install": {
      const ops = f.operands;
      for (const op of ops.slice(0, Math.max(1, ops.length - 1))) {
        const pr = risk(op);
        if (pr.level === "critical") block("move-protected-path", `moves ${pr.label} away from its location`, RM_ADVICE);
      }
      if (ops.length >= 2) {
        const dest = ops[ops.length - 1]!;
        if (DEVICE_RE.test(dest.text)) block("write-to-block-device", `writes onto the block device ${dest.text}`);
      }
      break;
    }

    // ------------------------------------------------------ disk / imaging ---
    case cmd.base === "dd": {
      const of = cmd.args.find((a) => a.text.startsWith("of="));
      if (of) {
        const target = of.text.slice(3);
        if (DEVICE_RE.test(target)) {
          block("dd-to-block-device", `dd writes to ${target} — this irreversibly overwrites a disk`);
        } else if (!DEV_ALLOWED.test(target)) {
          const pr = pathRisk(target, env, vars);
          if (pr.level === "critical") block("dd-to-protected-path", `dd overwrites ${pr.label}`);
        }
      }
      break;
    }
    case /^mkfs(\.|$)/.test(cmd.base) || /^newfs(\.|$)/.test(cmd.base) || ["fdisk", "gdisk", "sgdisk", "cfdisk", "parted", "wipefs", "zpool", "vgremove", "lvremove", "pvremove", "mdadm"].includes(cmd.base): {
      block("filesystem-destroyer", `\`${cmd.base}\` formats/partitions storage — it destroys every file on the target device`);
      break;
    }
    case cmd.base === "diskutil": {
      const sub = (f.operands[0]?.text ?? "").toLowerCase();
      if (/^(erase|reformat|zerodisk|randomdisk|secureerase|partitiondisk|apfs)/.test(sub) || f.operands.some((o) => DEVICE_RE.test(o.text)))
        block("filesystem-destroyer", `\`diskutil ${sub}\` erases or repartitions a volume`);
      break;
    }
    case cmd.base === "hdiutil": {
      if ((f.operands[0]?.text ?? "") === "erase") block("filesystem-destroyer", "`hdiutil erase` wipes an image/volume");
      break;
    }
    case cmd.base === "shred" || cmd.base === "srm" || cmd.base === "sdelete": {
      for (const op of f.operands) {
        if (DEVICE_RE.test(op.text)) block("filesystem-destroyer", `\`${cmd.base}\` overwrites the device ${op.text}`);
        else if (risk(op).level === "critical") block("rm-protected", `\`${cmd.base}\` irreversibly destroys ${risk(op).label}`, RM_ADVICE);
      }
      break;
    }

    // ------------------------------------------------------- permissions ----
    case cmd.base === "chmod" || cmd.base === "chown" || cmd.base === "chgrp" || cmd.base === "chflags": {
      const recursive = f.has("r", "R", "--recursive");
      const mode = f.operands[0]?.text ?? "";
      for (const op of f.operands.slice(1)) {
        const pr = risk(op);
        if (pr.level === "critical" && recursive)
          block("chmod-recursive-protected", `${priv}${cmd.base} -R rewrites ownership/permissions across ${pr.label}`, [
            "scope it to a project-local directory",
          ]);
        else if (pr.level === "critical" && /^0?777$/.test(mode))
          block("chmod-world-writable-protected", `makes ${pr.label} world-writable`);
      }
      break;
    }

    // ------------------------------------------------------ system control --
    case ["shutdown", "reboot", "halt", "poweroff"].includes(cmd.base): {
      block("system-power", `\`${cmd.base}\` powers off or restarts the machine`);
      break;
    }
    case cmd.base === "systemctl" || cmd.base === "launchctl": {
      const sub = (f.operands[0]?.text ?? "").toLowerCase();
      if (["poweroff", "reboot", "halt", "kexec"].includes(sub)) block("system-power", `\`${cmd.base} ${sub}\` restarts or powers off the machine`);
      else if (["bootout", "unload", "disable", "remove"].includes(sub) && f.operands.some((o) => /^(system|gui)\b|\/Library\/Launch/i.test(o.text)))
        warn("service-teardown", `\`${cmd.base} ${sub}\` tears down a system service`);
      break;
    }
    case cmd.base === "kill" || cmd.base === "killall" || cmd.base === "pkill": {
      const all = cmd.args.map((a) => a.text);
      if (cmd.base === "kill" && all.includes("-1")) block("kill-everything", "`kill … -1` signals every process the user owns — it logs you out / kills pi itself");
      else if ((cmd.base === "killall" || cmd.base === "pkill") && (f.has("u", "--user") || f.operands.length === 0) && f.has("9", "KILL"))
        block("kill-everything", `\`${cmd.base}\` with -9 and no specific target kills every process of the user`);
      else if (f.operands.some((o) => /^(node|bun|pi|zsh|bash|Terminal|iTerm2?|ssh)$/i.test(o.text)) || all.some((t) => /\b(node|pi)\b/.test(t) && f.has("f", "--full")))
        warn("kill-may-hit-pi", "this pattern can kill pi itself (it runs as a node process)", [
          'use process {action:"kill", id} to stop a job started by this tool',
        ]);
      break;
    }
    case cmd.base === "crontab": {
      if (f.has("r")) block("crontab-wipe", "`crontab -r` deletes ALL cron jobs of the user with no confirmation and no backup");
      break;
    }
    case ["userdel", "deluser", "dscl", "sysadminctl"].includes(cmd.base): {
      if (cmd.base !== "dscl" || cmd.args.some((a) => /^-delete$/i.test(a.text)))
        block("account-destruction", `\`${cmd.base}\` modifies or deletes system user accounts`);
      break;
    }

    // ------------------------------------------------------------ find -----
    case cmd.base === "find": {
      const argTexts = cmd.args.map((a) => a.text);
      const rmExec = (argTexts.includes("-exec") || argTexts.includes("-execdir")) && cmd.args.some((a) => basename(a.text) === "rm");
      const deletes = argTexts.includes("-delete") || rmExec;
      if (!deletes) break;
      // A filtered, project-local find is ordinary cleanup; an unfiltered one
      // (or one rooted outside the project) is `rm -rf` with extra steps.
      const filtered = argTexts.some((t) =>
        ["-name", "-iname", "-path", "-ipath", "-regex", "-type", "-mtime", "-mmin", "-newer", "-size", "-empty", "-user"].includes(t),
      );
      const cwdAbs = normalize(env.cwd, env.cwd);
      for (const r of f.operands.filter((o) => !o.text.startsWith("-"))) {
        const abs = resolveAbs(r.text, env, vars);
        const local = abs !== null && isUnder(abs, cwdAbs);
        if (local) {
          if (!filtered) warn("find-delete-unfiltered", "`find … -delete` with no -name/-type filter empties the whole tree it is rooted at");
          continue;
        }
        const pr = risk(r);
        if (pr.level === "critical")
          block("find-delete-protected", `\`find … ${rmExec ? "-exec rm" : "-delete"}\` is rooted at ${pr.label}`, RM_ADVICE);
      }
      break;
    }
    case cmd.base === "truncate": {
      for (const op of f.operands) if (risk(op).level === "critical") block("truncate-protected", `truncates ${risk(op).label}`);
      break;
    }
    case cmd.base === "tee": {
      for (const op of f.operands) {
        if (DEVICE_RE.test(op.text)) block("write-to-block-device", `tee writes to the device ${op.text}`);
        else if (risk(op).level === "critical") block("overwrite-protected-path", `${priv}tee overwrites ${risk(op).label}`);
      }
      break;
    }

    // ------------------------------------------------------------- git -----
    case cmd.base === "git": {
      const sub = f.operands[0]?.text;
      const argTexts = cmd.args.map((a) => a.text);
      if (sub === "push") {
        const forced = argTexts.some((t) => t === "--force" || t === "-f" || /^-[a-zA-Z]*f$/.test(t));
        const lease = argTexts.some((t) => t.startsWith("--force-with-lease"));
        const protectedRef = argTexts.some((t) => /(^|[:/])(main|master|trunk|develop|release[\w./-]*|prod\w*)$/i.test(t));
        const deletes = argTexts.some((t) => t === "--delete" || t === "-d" || /^:/.test(t));
        if (forced && !lease && protectedRef)
          block("git-force-push-protected", "force-pushes over a shared branch (main/master/release) — it rewrites history for everyone", [
            "use --force-with-lease, or push to a feature branch",
          ]);
        else if (forced && !lease) warn("git-force-push", "force-push without --force-with-lease can silently discard someone else's commits");
        else if (deletes && protectedRef) block("git-delete-protected-branch", "deletes a shared branch on the remote");
      } else if (sub === "clean") {
        if (argTexts.some((t) => /^-[a-zA-Z]*x/.test(t)) && argTexts.some((t) => /^-[a-zA-Z]*f/.test(t)))
          warn("git-clean-x", "`git clean -fx…` also deletes ignored files (.env, local config, build caches) — they are not recoverable from git");
      } else if (sub === "reset" && argTexts.includes("--hard")) {
        warn("git-reset-hard", "`git reset --hard` discards uncommitted work in the tree");
      } else if (sub === "filter-branch" || sub === "filter-repo") {
        warn("git-history-rewrite", `\`git ${sub}\` rewrites every commit in the repository`);
      }
      break;
    }

    // ----------------------------------------------------- infra cleanups ---
    case cmd.base === "docker" || cmd.base === "podman": {
      const txt = cmd.args.map((a) => a.text).join(" ");
      if (/\bsystem\s+prune\b/.test(txt) && /--volumes|-a\b|--all/.test(txt))
        warn("docker-prune-volumes", "`docker system prune` with --volumes/--all deletes images AND named volumes (database data included)");
      else if (/\bvolume\s+(rm|prune)\b/.test(txt)) warn("docker-volume-rm", "removes docker volumes — any data inside them is gone");
      break;
    }
    case cmd.base === "kubectl": {
      const txt = cmd.args.map((a) => a.text).join(" ");
      if (/\bdelete\b/.test(txt) && /--all\b|--all-namespaces|-A\b/.test(txt))
        warn("kubectl-delete-all", "`kubectl delete --all` removes every matching resource in the targeted namespace(s)");
      break;
    }
    case cmd.base === "terraform": {
      if (cmd.args.some((a) => a.text === "destroy") && cmd.args.some((a) => /^-auto-approve$/.test(a.text)))
        block("terraform-destroy", "`terraform destroy -auto-approve` tears down real infrastructure with no confirmation");
      break;
    }
    case cmd.base === "history": {
      if (f.has("c")) warn("history-wipe", "`history -c` erases the shell history");
      break;
    }

    // --------------------------------------------------- secret handling ---
    case cmd.base === "security": {
      if (cmd.args.some((a) => /^(dump-keychain|find-generic-password|find-internet-password|export)$/.test(a.text)))
        block("keychain-dump", "reads secrets out of the macOS keychain");
      break;
    }
    default:
      break;
  }

  // curl/wget uploading a credential file (`-d @~/.ssh/id_rsa`, `-T .env`)
  if (FETCHERS.has(cmd.base) || cmd.base === "scp" || cmd.base === "rsync") {
    for (const a of cmd.args) {
      const val = a.text.replace(/^@/, "").replace(/^--data(?:-binary|-raw)?=/, "").replace(/^-d/, "");
      if (val && SECRET_RE.test(val) && !/^-/.test(val))
        pushUnique(findings, {
          risk: "block",
          rule: "secret-exfiltration",
          why: `uploads a credential file (${val.slice(0, 80)}) to the network`,
          evidence: ev,
        });
    }
  }
  if (cmd.privileged && findings.length === 0) {
    pushUnique(findings, {
      risk: "warn",
      rule: "sudo-in-background",
      why: "sudo in a detached background job has no terminal: it will either hang forever on the password prompt or fail",
      evidence: ev,
      advice: ["run privileged commands yourself in a terminal"],
    });
  }
}

/** Pipeline-level rules: they need to see several segments at once. */
function inspectPipelines(segs: Segment[], cmds: Map<Segment, Cmd>, findings: Finding[]) {
  const byPipe = new Map<number, Segment[]>();
  for (const s of segs) {
    const arr = byPipe.get(s.pipeline) ?? [];
    arr.push(s);
    byPipe.set(s.pipeline, arr);
  }
  for (const [, chain] of byPipe) {
    if (chain.length < 2) continue;
    const ev = chain.map(segText).join(" | ").slice(0, 220);
    const bases = chain.map((s) => cmds.get(s)?.base ?? "");

    const fetchIdx = bases.findIndex((b) => FETCHERS.has(b));
    const shellIdx = bases.findIndex((b) => INTERPRETERS.has(b));
    if (fetchIdx >= 0 && shellIdx > fetchIdx) {
      pushUnique(findings, {
        risk: "block",
        rule: "remote-code-execution",
        why: `pipes downloaded content straight into \`${bases[shellIdx]}\` — whatever the server returns executes with your privileges`,
        evidence: ev,
        advice: ["download to a file, read it, then run it explicitly"],
      });
    }
    const b64Idx = bases.findIndex((b) => b === "base64" || b === "openssl" || b === "xxd");
    if (b64Idx >= 0 && shellIdx > b64Idx) {
      pushUnique(findings, {
        risk: "block",
        rule: "obfuscated-execution",
        why: `decodes data and pipes it into \`${bases[shellIdx]}\` — the executed code is not readable in the command`,
        evidence: ev,
      });
    }
    // secret -> network
    const readerIdx = chain.findIndex((s) => {
      const c = cmds.get(s);
      if (!c) return false;
      const reads = READERS.has(c.base);
      const hasSecret = c.args.some((a) => SECRET_RE.test(a.text)) || s.words.some((w) => SECRET_RE.test(w.text));
      return reads && hasSecret;
    });
    const netIdx = bases.findIndex((b) => NET_TOOLS.has(b));
    if (readerIdx >= 0 && netIdx > readerIdx) {
      pushUnique(findings, {
        risk: "block",
        rule: "secret-exfiltration",
        why: `reads credential material and pipes it into \`${bases[netIdx]}\``,
        evidence: ev,
      });
    }
  }
}

/** Raw-text safety net for shapes the parser may not model. */
function rawRules(commandIn: string, findings: Finding[]) {
  // heredoc bodies are documentation/data, never executed commands
  const flat = stripHeredocs(commandIn).replace(/\s+/g, " ");
  const add = (rule: string, why: string, m: string, advice?: string[]) =>
    pushUnique(findings, { risk: "block", rule, why, evidence: m.slice(0, 220), advice });

  let m: RegExpMatchArray | null;

  if ((m = flat.match(/[:\w]*\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;?\s*[:\w]+/))) {
    if (/\|\s*[:\w]+\s*&/.test(m[0])) add("fork-bomb", "this is a fork bomb — it spawns processes until the machine is unusable", m[0]);
  }
  if ((m = flat.match(/--no-preserve-root/))) add("rm-no-preserve-root", "`--no-preserve-root` only exists to delete `/`", flat.slice(0, 220));
  if ((m = flat.match(/\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rRf][a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*\/(?:\s|$|\*)/)))
    add("rm-recursive-protected", "deletes the filesystem root", m[0], RM_ADVICE);
  if ((m = flat.match(/\b(?:sh|bash|zsh|python3?|perl|ruby|node)\b[^|;]*?<\(\s*(?:curl|wget)\b[^)]*\)/)))
    add("remote-code-execution", "executes a downloaded script via process substitution", m[0]);
  if ((m = flat.match(/\b(?:sh|bash|zsh|python3?|perl|ruby|node)\b\s+(?:-\w+\s+)*["']?\$\(\s*(?:curl|wget)\b/)))
    add("remote-code-execution", "executes the output of a network download", m[0]);
  if ((m = flat.match(/\b(?:mkfs(?:\.\w+)?|wipefs|zerodisk)\b/))) add("filesystem-destroyer", `\`${m[0]}\` destroys every file on the target device`, flat.slice(0, 220));
  if ((m = flat.match(/>\s*\/dev\/(?:disk|rdisk|sd[a-z]|nvme|hd[a-z])\w*/i))) add("write-to-block-device", "redirects output onto a raw disk device", m[0]);
  if ((m = flat.match(/\bchmod\s+(?:-[a-zA-Z]+\s+)*0?777\s+\/(?:\s|$)/))) add("chmod-world-writable-protected", "makes the whole filesystem world-writable", m[0]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function inspectCommand(command: string, envIn: GuardEnv): Finding[] {
  const env: Required<GuardEnv> = {
    cwd: envIn.cwd || process.cwd(),
    home: envIn.home ?? process.env.HOME ?? "/root",
    vars: envIn.vars ?? (process.env as Record<string, string | undefined>),
  };
  const findings: Finding[] = [];
  const segs = parseSegments(command);
  const cmds = new Map<Segment, Cmd>();
  for (const seg of segs) {
    const cmd = toCmd(seg);
    if (!cmd) continue;
    cmds.set(seg, cmd);
    inspectCmd(cmd, seg, env, findings);
    // `bash -c "<inner>"` / `su -c "<inner>"`: analyse the payload too
    for (const inner of cmd.inner.slice(0, 3)) {
      for (const f of inspectCommand(inner, envIn)) pushUnique(findings, f);
    }
  }
  inspectPipelines(segs, cmds, findings);
  rawRules(command, findings);
  return findings;
}

export const worstRisk = (fs: Finding[]): "block" | "warn" | null =>
  fs.some((f) => f.risk === "block") ? "block" : fs.length ? "warn" : null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ellipsis = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

export function renderBlock(command: string, findings: Finding[]): string {
  const blocks = findings.filter((f) => f.risk === "block");
  const lines = [
    "[process-guard] BLOCKED — nothing was started, no process exists.",
    "",
    `  ${ellipsis(command.replace(/\s+/g, " ").trim(), 400)}`,
    "",
  ];
  for (const f of blocks) {
    lines.push(`✗ ${f.rule}${isHard(f) ? "  [non-waivable]" : ""}`, `  why:   ${f.why}`, `  match: ${ellipsis(f.evidence, 220)}`);
    for (const a of f.advice ?? []) lines.push(`  use:   ${a}`);
    lines.push("");
  }
  const warns = findings.filter((f) => f.risk === "warn");
  if (warns.length) lines.push(`also flagged: ${warns.map((w) => w.rule).join(", ")}`, "");
  const hard = blocks.filter(isHard);
  lines.push(
    "This check is not agent-bypassable: re-sending the same command — reworded, quoted,",
    "base64-encoded or wrapped in `bash -c` — is refused again. Do not look for a way around it.",
  );
  lines.push(
    hard.length
      ? `${hard.length > 1 ? "Those rules are" : "That rule is"} machine-wide and irreversible, so it is refused even when the user\n` +
        "dictates the command verbatim. Only a deliberate mode change lifts it: `/procguard off`\n" +
        "(or PI_PROCESS_GUARD=off) — or the user runs it in their own terminal."
      : "If this command is genuinely required, say so and let the user decide: they can run\n" +
        "`/procguard off` (or `/procguard warn`), set PI_PROCESS_GUARD=off, or type the command themselves.",
  );
  return lines.join("\n");
}

export function renderWarn(findings: Finding[]): string {
  const warns = findings.filter((f) => f.risk === "warn");
  const lines = warns.map((f) => `⚠ [process-guard] ${f.rule}: ${f.why}`);
  for (const f of warns) for (const a of f.advice ?? []) lines.push(`  → ${a}`);
  return lines.join("\n");
}

export function readMode(): GuardMode {
  const v = (process.env.PI_PROCESS_GUARD ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "warn" || v === "nudge" || v === "audit") return "warn";
  return "on";
}
