/**
 * A deliberately conservative shell "reader" for bash-guardrail.
 *
 * It does NOT try to be a shell. Its only job is to answer one question with
 * high confidence: *is this command boringly simple enough that a purpose-built
 * tool is an exact substitute?* Anything it does not fully understand sets a
 * bail flag, and the caller then leaves the command alone.
 *
 * Everything here is pure and synchronous so it can be unit-tested against a
 * corpus of real commands without a pi session.
 */

export type Word = {
  /** Value with quotes removed and backslash escapes applied. */
  v: string;
  /** True if any part of the word was quoted (so `*` in it is NOT a glob). */
  q: boolean;
  /**
   * True if the word's FIRST character was quoted. Flag detection must use this,
   * not `q`: `--include="*.kt"` is a flag whose value happens to be quoted,
   * while `"-weird-file"` is a positional.
   */
  qs: boolean;
};

export type Segment = {
  words: Word[];
  /** Operator that separated this segment from the previous one ("" for the first). */
  sep: "" | "&&" | "||" | ";" | "\n" | "|" | "&";
  /** Raw source text of the segment, trimmed. */
  raw: string;
};

export type ParseFlags = {
  /** `<<` / `<<<` seen: never intervene beyond a nudge, and never inspect the body. */
  heredoc: boolean;
  /** `$(...)` or backticks. */
  substitution: boolean;
  /** `$VAR` / `${VAR}` outside single quotes. */
  varRef: boolean;
  /** `<(...)`, `>(...)`. */
  procSubst: boolean;
  /** Output redirected to a real file (>, >>). /dev/null and &1/&2 don't count. */
  redirectOut: boolean;
  /** Input redirected from a file. */
  redirectIn: boolean;
  /** Trailing/embedded `&` (background). */
  background: boolean;
  /** Subshell / brace group / control keyword / assignment prefix / etc. */
  shellwork: boolean;
  /** Quotes never closed - we cannot trust the tokenization at all. */
  unbalanced: boolean;
  /** Unquoted brace expansion `{a,b}`. */
  braceExpansion: boolean;
};

export type Parsed = {
  segments: Segment[];
  flags: ParseFlags;
  /** True if any separator was a pipe. */
  piped: boolean;
};

const CONTROL_WORDS = new Set([
  "for",
  "while",
  "until",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "in",
  "time",
  "trap",
  "exec",
  "eval",
  "source",
  ".",
  "export",
  "set",
  "unset",
  "shift",
  "return",
  "local",
  "declare",
  "readonly",
  "sudo",
  "doas",
  "xargs",
  "watch",
  "timeout",
  "nohup",
  "nice",
  "script",
  "expect",
  "ssh",
  "docker",
  "adb",
]);

const SEPARATORS = new Set(["&&", "||", ";", "\n", "|", "&"]);

export function parseCommand(command: string): Parsed {
  const flags: ParseFlags = {
    heredoc: false,
    substitution: false,
    varRef: false,
    procSubst: false,
    redirectOut: false,
    redirectIn: false,
    background: false,
    shellwork: false,
    unbalanced: false,
    braceExpansion: false,
  };

  const segments: Segment[] = [];
  let words: Word[] = [];
  let cur = "";
  let curStarted = false;
  let curQuoted = false;
  let curLeadQuoted = false;
  let segStart = 0;
  let pendingSep: Segment["sep"] = "";
  let piped = false;

  const flushWord = () => {
    if (curStarted) {
      words.push({ v: cur, q: curQuoted, qs: curLeadQuoted });
      cur = "";
      curStarted = false;
      curQuoted = false;
      curLeadQuoted = false;
    }
  };

  const flushSegment = (endIdx: number, nextSep: Segment["sep"]) => {
    flushWord();
    if (words.length) {
      segments.push({ words, sep: pendingSep, raw: command.slice(segStart, endIdx).trim() });
    }
    words = [];
    pendingSep = nextSep;
    segStart = endIdx + 1;
  };

  const add = (ch: string, quoted: boolean) => {
    if (!curStarted) curLeadQuoted = quoted;
    cur += ch;
    curStarted = true;
    if (quoted) curQuoted = true;
  };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];

    // ---- quoting -------------------------------------------------------
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) {
        flags.unbalanced = true;
        break;
      }
      // Empty single-quoted string still starts a word.
      if (!curStarted) curLeadQuoted = true;
      curStarted = true;
      curQuoted = true;
      cur += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (command[j] === "\\" && j + 1 < n) {
          // In double quotes bash only removes the backslash before $ ` " \ and
          // newline. Everywhere else BOTH characters survive - stripping them
          // silently rewrites regexes like "\bFoo\b" into "bFoob".
          const nxt = command[j + 1];
          if (nxt === "$" || nxt === "`" || nxt === '"' || nxt === "\\") {
            add(nxt, true);
            j += 2;
            continue;
          }
          if (nxt === "\n") {
            j += 2;
            continue;
          }
          add("\\", true);
          add(nxt, true);
          j += 2;
          continue;
        }
        if (command[j] === '"') {
          closed = true;
          j++;
          break;
        }
        if (command[j] === "$" && /[A-Za-z_{(]/.test(command[j + 1] ?? "")) {
          if (command[j + 1] === "(") flags.substitution = true;
          else flags.varRef = true;
        }
        if (command[j] === "`") flags.substitution = true;
        add(command[j], true);
        j++;
      }
      if (!closed) {
        flags.unbalanced = true;
        break;
      }
      if (!curStarted) curLeadQuoted = true;
      curStarted = true;
      curQuoted = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n) {
        // Line continuation: treat as whitespace.
        if (command[i + 1] === "\n") {
          flushWord();
          i += 2;
          continue;
        }
        add(command[i + 1], true);
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ---- comments ------------------------------------------------------
    if (c === "#" && !curStarted) {
      const nl = command.indexOf("\n", i);
      if (nl < 0) {
        i = n;
        break;
      }
      i = nl; // let the \n be handled as a separator
      continue;
    }

    // ---- substitution / variables --------------------------------------
    if (c === "`") {
      flags.substitution = true;
      i++;
      continue;
    }
    if (c === "$") {
      const nx = command[i + 1] ?? "";
      if (nx === "(") flags.substitution = true;
      else if (/[A-Za-z_{]/.test(nx)) flags.varRef = true;
      add(c, false);
      i++;
      continue;
    }

    // ---- redirections ---------------------------------------------------
    if (c === "<") {
      if (command[i + 1] === "<") {
        flags.heredoc = true;
        break; // never look at the heredoc body
      }
      if (command[i + 1] === "(") {
        flags.procSubst = true;
        break;
      }
      flags.redirectIn = true;
      i++;
      continue;
    }
    if (c === ">") {
      // fd prefix: `2>`, `1>`
      if (curStarted && !curQuoted && /^[0-9]$/.test(cur)) {
        cur = "";
        curStarted = false;
      }
      if (command[i + 1] === "(") {
        flags.procSubst = true;
        break;
      }
      let j = i + 1;
      if (command[j] === ">") j++;
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;
      // target
      let target = "";
      if (command[j] === "&") {
        target = "&";
        j++;
        while (j < n && /[0-9-]/.test(command[j])) {
          target += command[j];
          j++;
        }
      } else {
        while (j < n && !/[\s;|&]/.test(command[j])) {
          target += command[j];
          j++;
        }
      }
      const benign = target === "&1" || target === "&2" || target === "&-" || target === "/dev/null";
      if (!benign) flags.redirectOut = true;
      flushWord();
      i = j;
      continue;
    }

    // ---- separators ------------------------------------------------------
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      let sep: Segment["sep"];
      let width = 1;
      if (c === "&" && command[i + 1] === "&") {
        sep = "&&";
        width = 2;
      } else if (c === "|" && command[i + 1] === "|") {
        sep = "||";
        width = 2;
      } else if (c === "|") {
        sep = "|";
        piped = true;
      } else if (c === "&") {
        sep = "&";
        flags.background = true;
      } else if (c === ";") {
        sep = ";";
      } else {
        sep = "\n";
      }
      flushSegment(i, sep);
      i += width;
      segStart = i;
      continue;
    }

    // ---- grouping / control ---------------------------------------------
    if (c === "(" || c === ")" || (c === "{" && !curStarted) || (c === "}" && !curStarted)) {
      flags.shellwork = true;
      i++;
      continue;
    }
    if (c === "{" && curStarted) {
      // brace expansion inside a word, e.g. cp a.{ts,js}
      const close = command.indexOf("}", i);
      if (close > 0 && command.slice(i, close).includes(",")) flags.braceExpansion = true;
      add(c, false);
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flushWord();
      i++;
      continue;
    }

    add(c, false);
    i++;
  }

  flushSegment(command.length, "");

  for (const seg of segments) {
    const first = seg.words[0]?.v ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) flags.shellwork = true;
    if (CONTROL_WORDS.has(first)) flags.shellwork = true;
    if (first === "[" || first === "[[" || first === "!") flags.shellwork = true;
  }

  return { segments, flags, piped };
}

/** True when nothing in the parse forbids us from reasoning about the command. */
export function isSimpleEnough(p: Parsed): boolean {
  const f = p.flags;
  return !(
    f.heredoc ||
    f.substitution ||
    f.varRef ||
    f.procSubst ||
    f.redirectOut ||
    f.redirectIn ||
    f.background ||
    f.shellwork ||
    f.unbalanced ||
    f.braceExpansion
  );
}
