#!/usr/bin/env node
/**
 * PreToolUse hook for read-only Claude Code agents (researcher, reviewer, feature-architect,
 * tester, babysitter). Those agents need Bash for git history, test runs and the service CLIs,
 * so `disallowedTools: Edit, Write` alone does not stop them writing through the shell. This
 * hook blocks the common write paths before the command runs:
 *
 *   - file mutation: rm, mv, cp, touch, sed -i, tee, dd, patch, ... and `>`/`>>` redirection
 *     (redirecting into /dev/null or a temp dir is allowed: logs are scratch, not repo state)
 *   - git: commit, push, reset, checkout, add, stash, fetch, ... (read subcommands pass)
 *   - gh: pr/issue create/merge/comment/edit..., run rerun/cancel, gh api with a write method
 *   - service CLIs from ~/.claude/skills: slack/jira/datadog/trello write commands, unless
 *     --dry-run is present
 *   - dependency changes (npm install <pkg>, yarn add, pip install <pkg>) and autofix flags
 *
 * It is a guard against mistakes, not a sandbox: an agent determined to write can still find
 * a path (an interpreter one-liner, a build script). Exit 2 blocks and stderr goes to the model.
 */
import { readFileSync } from "node:fs";

const TEMP_PREFIXES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/tmp/", "/private/tmp/", "/var/folders/", "$TMPDIR", "${TMPDIR"];

const FILE_WRITERS = new Set([
  "rm", "rmdir", "mv", "cp", "touch", "truncate", "dd", "patch", "ln", "chmod", "chown", "mkdir",
  "install", "rsync", "shred", "unlink",
]);

const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "branch", "rev-parse", "merge-base", "ls-files",
  "ls-tree", "cat-file", "describe", "shortlog", "grep", "reflog", "remote", "config", "tag",
  "name-rev", "rev-list", "for-each-ref", "show-ref", "whatchanged", "range-diff", "version",
  "help", "check-ignore", "worktree",
]);

const GH_WRITE = {
  pr: new Set(["create", "merge", "close", "comment", "edit", "review", "ready", "reopen", "lock", "unlock", "update-branch", "checkout"]),
  issue: new Set(["create", "close", "comment", "edit", "delete", "reopen", "transfer", "pin", "unpin", "lock", "unlock", "develop"]),
  run: new Set(["rerun", "cancel", "delete"]),
  workflow: new Set(["run", "enable", "disable"]),
  repo: new Set(["create", "delete", "edit", "fork", "rename", "archive", "unarchive", "sync", "clone"]),
  release: new Set(["create", "delete", "edit", "upload", "delete-asset"]),
  label: new Set(["create", "delete", "edit", "clone"]),
  secret: new Set(["set", "delete"]),
  variable: new Set(["set", "delete"]),
  gist: new Set(["create", "delete", "edit"]),
  cache: new Set(["delete"]),
};

/** Service CLI write commands: first one or two words after the script path. */
const CLI_WRITES = {
  slack: ["post", "reply", "react", "upload"],
  jira: ["create", "update", "transition", "comment", "link", "delete", "attachment add", "api"],
  datadog: ["monitor mute", "monitor unmute", "event post", "mute_monitor", "unmute_monitor", "post_event"],
  trello: ["card create", "card update", "card move", "card comment", "card archive", "card unarchive", "card delete",
    "card label", "card member", "list create", "list archive", "checklist", "attachment add", "api"],
};

// ---------------------------------------------------------------- tokenizer

/** Split a shell command into simple commands (arrays of words) plus redirection targets. */
export function parse(input) {
  let cmd = input;
  const commands = [];
  const subshells = [];
  let words = [];
  let redirects = [];
  let cur = "";
  let has = false;
  let pendingRedirect = false;
  const pushWord = () => {
    if (!has) return;
    if (pendingRedirect) redirects.push(cur);
    else words.push(cur);
    pendingRedirect = false;
    cur = "";
    has = false;
  };
  const endCommand = () => {
    pushWord();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      cur += cmd.slice(i + 1, end); has = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) { s += cmd[j + 1]; j += 2; continue; }
        s += cmd[j++];
      }
      collectSubshells(s, subshells);
      cur += s; has = true; i = j; continue;
    }
    if (c === "$" && cmd[i + 1] === "(") {
      const end = matchParen(cmd, i + 1);
      subshells.push(cmd.slice(i + 2, end));
      cur += cmd.slice(i, end + 1); has = true; i = end; continue;
    }
    if (c === "`") {
      const j = cmd.indexOf("`", i + 1);
      const end = j < 0 ? cmd.length : j;
      subshells.push(cmd.slice(i + 1, end));
      i = end; has = true; continue;
    }
    if (c === "#" && !has) { const j = cmd.indexOf("\n", i); i = j < 0 ? cmd.length : j - 1; continue; }
    if (c === " " || c === "\t") { pushWord(); continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      // `2>&1`, `>&2`, `&>` are redirections, not separators
      if (c === "&" && cmd[i + 1] === ">") { pushWord(); pendingRedirect = true; i++; if (cmd[i + 1] === ">") i++; continue; }
      endCommand();
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      continue;
    }
    if (c === ">" || (c === "<" && cmd[i + 1] !== "(")) {
      // drop an fd number glued to the operator (2>file)
      if (has && /^\d+$/.test(cur)) { cur = ""; has = false; } else pushWord();
      if (c === "<") {
        if (cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
          // heredoc: skip the body up to the delimiter line so it is not parsed as commands
          const m = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(cmd.slice(i));
          if (m) {
            const delim = m[2];
            const nl = cmd.indexOf("\n", i);
            let j = nl < 0 ? cmd.length : nl + 1;
            const rest = cmd.slice(i + m[0].length, nl < 0 ? cmd.length : nl);
            while (j < cmd.length) {
              const e = cmd.indexOf("\n", j);
              const line = cmd.slice(j, e < 0 ? cmd.length : e);
              j = e < 0 ? cmd.length : e + 1;
              if (line.trim() === delim) break;
            }
            // keep parsing what follows the delimiter on the first line (`cat <<EOF > out`)
            cmd = cmd.slice(0, i) + rest + "\n" + cmd.slice(j);
            i--;
            continue;
          }
        }
        // input redirection reads a file: the target word is harmless as an argument
        while (cmd[i + 1] === "<") i++;
        continue;
      }
      if (cmd[i + 1] === ">") i++;
      if (cmd[i + 1] === "&") { i++; while (/\d/.test(cmd[i + 1] ?? "")) i++; continue; }
      if (cmd[i + 1] === "|") i++;
      pendingRedirect = true;
      continue;
    }
    cur += c; has = true;
  }
  endCommand();
  return { commands, subshells };
}

function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length;
}

function collectSubshells(s, out) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "(") { const e = matchParen(s, i + 1); out.push(s.slice(i + 2, e)); i = e; }
    else if (s[i] === "`") { const j = s.indexOf("`", i + 1); const e = j < 0 ? s.length : j; out.push(s.slice(i + 1, e)); i = e; }
  }
}

// ---------------------------------------------------------------- rules

const base = (w) => w.split("/").pop();
const isTemp = (t) => TEMP_PREFIXES.some((p) => t === p || t.startsWith(p)) || t.startsWith("&");

/** Strip env assignments and wrappers (sudo, env, time, nice, command, xargs flags). */
function effective(words) {
  let w = words.slice();
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    const b = w.length ? base(w[0]) : "";
    if (["sudo", "env", "time", "nice", "nohup", "command", "exec", "timeout", "caffeinate"].includes(b)) {
      w.shift();
      while (w.length && (w[0].startsWith("-") || (b === "timeout" && /^\d/.test(w[0])))) w.shift();
      continue;
    }
    if (b === "xargs") {
      w.shift();
      while (w.length && w[0].startsWith("-")) { const f = w.shift(); if (/^-[IdEsLnP]$/.test(f)) w.shift(); }
      continue;
    }
    return w;
  }
}

function checkSimple(words, reasons) {
  const w = effective(words);
  if (!w.length) return;
  const cmd = base(w[0]);
  const args = w.slice(1);

  if (["bash", "sh", "zsh", "dash"].includes(cmd)) {
    const i = args.indexOf("-c");
    if (i >= 0 && args[i + 1] !== undefined) checkCommand(args[i + 1], reasons);
    else if (args.some((a) => !a.startsWith("-"))) reasons.push(`running a shell script (${args.find((a) => !a.startsWith("-"))}) is not allowed in a read-only agent`);
    return;
  }
  if (cmd === "eval") { checkCommand(args.join(" "), reasons); return; }

  if (FILE_WRITERS.has(cmd)) { reasons.push(`\`${cmd}\` modifies files`); return; }
  if (cmd === "tee") {
    const targets = args.filter((a) => !a.startsWith("-"));
    if (targets.some((t) => !isTemp(t))) reasons.push("`tee` into a file outside the temp dir");
    return;
  }
  if ((cmd === "sed" || cmd === "gsed") && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
    reasons.push("`sed -i` edits files in place"); return;
  }
  if ((cmd === "perl" || cmd === "ruby") && args.some((a) => /^-[a-zA-Z]*i/.test(a))) { reasons.push(`\`${cmd} -i\` edits files in place`); return; }
  if (cmd === "find") {
    if (args.includes("-delete")) reasons.push("`find -delete` removes files");
    for (const flag of ["-exec", "-execdir", "-ok", "-okdir"]) {
      const i = args.indexOf(flag);
      if (i >= 0) {
        const end = args.findIndex((a, j) => j > i && (a === ";" || a === "+" || a === "\\;"));
        checkSimple(args.slice(i + 1, end < 0 ? undefined : end).filter((a) => a !== "{}"), reasons);
      }
    }
    return;
  }

  if (cmd === "git") {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree"].includes(args[i]) ? 2 : 1;
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (!sub) return;
    if (sub === "stash" && ["list", "show"].includes(rest[0])) return;
    if (sub === "branch" && rest.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(a))) {
      reasons.push("`git branch` with a modifying flag"); return;
    }
    if (sub === "tag" && rest.some((a) => !a.startsWith("-") || /^-(d|a|s|f|m)$|^--(delete|annotate|sign|force)/.test(a)) && !rest.some((a) => /^-l$|^--list$|^--contains|^--points-at|^-n/.test(a))) {
      reasons.push("`git tag` that creates or deletes a tag"); return;
    }
    if (sub === "remote" && rest.length && !["-v", "show", "get-url"].includes(rest[0])) { reasons.push("`git remote` that changes remotes"); return; }
    if (sub === "config" && !rest.some((a) => /^--(get|get-all|get-regexp|list|show-origin)$|^-l$/.test(a))) { reasons.push("`git config` that writes"); return; }
    if (sub === "worktree" && rest[0] !== "list") { reasons.push("`git worktree` that changes worktrees"); return; }
    if (!GIT_READ.has(sub)) reasons.push(`\`git ${sub}\` changes the repository or its refs`);
    return;
  }

  if (cmd === "gh") {
    const [group, action] = args;
    if (group === "api") {
      const m = args.findIndex((a) => a === "-X" || a === "--method");
      const method = (m >= 0 ? args[m + 1] : args.find((a) => /^(-X|--method=)/.test(a))?.replace(/^(-X|--method=)/, "")) || "";
      if (/^(POST|PUT|PATCH|DELETE)$/i.test(method)) reasons.push(`\`gh api\` with ${method.toUpperCase()}`);
      else if (!method && args.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^(-f|-F)./.test(a))) reasons.push("`gh api` with fields (defaults to POST)");
      return;
    }
    if (GH_WRITE[group]?.has(action)) reasons.push(`\`gh ${group} ${action}\` changes GitHub state`);
    return;
  }

  const cliMatch = w[0].match(/(?:^|\/)(slack|jira|datadog|trello)(?:\.mjs)?$/) ||
    (["node"].includes(cmd) && args[0]?.match(/\/(slack|jira|datadog|trello)\.mjs$/));
  if (cliMatch) {
    const name = cliMatch[1];
    const rest = (cmd === "node" ? args.slice(1) : args).filter((a) => !a.startsWith("-"));
    const phrase = rest.slice(0, 2).join(" ");
    const isWrite = CLI_WRITES[name].some((p) => phrase === p || phrase.startsWith(`${p} `) || rest[0] === p);
    if (name === "jira" && rest[0] === "api" && /^get$/i.test(rest[1] ?? "")) return;
    if (name === "trello" && rest[0] === "api" && /^get$/i.test(rest[1] ?? "")) return;
    if (isWrite && !w.includes("--dry-run")) reasons.push(`\`${name} ${phrase}\` writes to ${name}; only --dry-run is allowed in a read-only agent`);
    return;
  }

  if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
    const sub = args[0];
    if (["add", "remove", "rm", "uninstall", "un", "upgrade", "update", "up", "link", "unlink", "publish", "version", "dedupe", "audit"].includes(sub) && !(sub === "audit" && !args.includes("fix"))) {
      reasons.push(`\`${cmd} ${sub}\` changes dependencies or the package`);
    } else if (["install", "i", "in"].includes(sub) && args.slice(1).some((a) => !a.startsWith("-"))) {
      reasons.push(`\`${cmd} ${sub} <package>\` adds a dependency (plain \`${cmd} install\` / \`npm ci\` is allowed)`);
    }
  }
  if ((cmd === "pip" || cmd === "pip3" || cmd === "uv" || cmd === "poetry") && ["install", "add", "uninstall", "remove"].includes(cmd === "uv" && args[0] === "pip" ? args[1] : args[0])) {
    const a = cmd === "uv" && args[0] === "pip" ? args.slice(2) : args.slice(1);
    if (!(a.includes("-r") || a.some((x) => x.startsWith("--requirement")) || a.includes("-e") && a.includes("."))) reasons.push(`\`${cmd} install <package>\` adds a dependency (only -r <requirements file> is allowed)`);
  }

  if (args.some((a) => a === "--fix" || a === "--write" || a.startsWith("--fix=") || a === "--fix-dry-run=false")) reasons.push(`\`${cmd}\` with an autofix/write flag`);
  if (cmd === "gofmt" && args.includes("-w")) reasons.push("`gofmt -w` rewrites files");
  if (cmd === "rubocop" && args.some((a) => /^-(a|A)$|^--autocorrect/.test(a))) reasons.push("`rubocop` autocorrect rewrites files");
  if (cmd === "terraform" && args[0] === "fmt" && !args.includes("-check")) reasons.push("`terraform fmt` without -check rewrites files");
}

export function checkCommand(command, reasons = []) {
  const { commands, subshells } = parse(command);
  for (const { words, redirects } of commands) {
    for (const target of redirects) {
      if (!isTemp(target)) reasons.push(`output redirection into \`${target}\` (only /dev/null or a temp dir is allowed)`);
    }
    checkSimple(words, reasons);
  }
  for (const s of subshells) checkCommand(s, reasons);
  return reasons;
}

// ---------------------------------------------------------------- main

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("readonly-bash.mjs")) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  if (input.tool_name !== "Bash") process.exit(0);
  const command = String(input.tool_input?.command ?? "");
  const reasons = [...new Set(checkCommand(command))];
  if (reasons.length) {
    const who = input.agent_type ? `the ${input.agent_type} agent` : "this agent";
    process.stderr.write(
      `Blocked by the read-only guard: ${reasons.join("; ")}.\n` +
        `${who[0].toUpperCase()}${who.slice(1)} is read-only. Use Bash only for reading (git log/diff/show, searches, running the repo's own tests and builds, read commands of the service CLIs or their --dry-run). ` +
        "If the task needs this change, report it instead of making it.\n",
    );
    process.exit(2);
  }
  process.exit(0);
}
