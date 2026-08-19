# file-write-plus

Two file-mutation tools for pi that close measured gaps in the built-in `write`/`edit` tools:

| Tool | Replaces | Why the built-in isn't enough |
|---|---|---|
| `append_file` | `cat >> file << 'EOF' … EOF`, `echo … >> file`, `tee -a`, and read+`edit` round-trips | built-in `write` can only create/**overwrite**, so appending meant shelling out (invisible to the harness, one typo — `>` instead of `>>` — away from destroying the file, and subject to shell expansion of `$VAR`/backticks) |
| `replace_in_file` | `sed -i '' 's/a/b/g' file`, `perl -pi -e`, `python3 - <<'PY' … s.replace(…) … PY` | built-in `edit` requires a **unique exact match**, so repeated/pattern-based replacements needed either giant context blocks per site or an inline shell/python rewrite |

Measured motivation (all 266 real sessions in `~/.pi/agent/sessions`: 2160 tool calls, bash = 1334 / 62 %):
85 heredoc writes incl. 12 explicit heredoc **appends** to progress/execution logs; 40 inline `python3`
rewrites (4 of which crashed) and 8 `sed -i` calls for repeated replacements.

## Install

```bash
# global
cp -R extensions/file-write-plus ~/.pi/agent/extensions/file-write-plus
# or load explicitly
pi -e /path/to/extensions/file-write-plus/index.ts
```

No runtime dependencies (Node built-ins only); `package.json` only declares dev/type deps.

---

## `append_file`

Appends to the end of a file **without reading or rewriting it** — cost is independent of file size.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | File to append to. A leading `@` is stripped. |
| `content` | string | — | Exact text to append. Written verbatim: no shell expansion, no escape processing. |
| `ensureTrailingNewline` | boolean | `true` | Make sure the file ends with a newline afterwards. |
| `startOnNewLine` | boolean | `true` | If the file does **not** end with a newline, insert one first so the new entry starts on its own line (this is the bug `cat >> file` silently causes). `false` continues the last line. |
| `createIfMissing` | boolean | `true` | Create the file **and parent directories** when missing. |
| `expectedTailPattern` | string | — | Guard: a JS regex that must match the **end** of the current file (last 8 KB) or the append is refused and the actual tail is shown. Refused (not ignored) if the file is missing/empty. |

Behaviour details:

- Uses `O_APPEND` + a single `write()`, so concurrent appends never interleave or clobber
  (validated with 12 parallel calls to the same file).
- The inserted newline follows the file's **existing** EOL style (CRLF file → CRLF).
- Reports `lines appended / bytes appended`, resulting `lines`/`bytes`, previous size, EOL style,
  final-newline state, and any newline it inserted.
- Participates in pi's per-file mutation queue (`withFileMutationQueue`), so it cannot race with
  built-in `edit`/`write` in the same assistant turn.

```jsonc
// replaces: cat >> 03_execution_log.txt << 'EOF' \n ## Step 3 … \n EOF
{ "path": "03_execution_log.txt", "content": "## Step 3 - verify\nRan the unit tests: 14 passed, 0 failed." }

// assert what you are appending to
{ "path": "log.md", "content": "done", "expectedTailPattern": "## Step 3\\s*" }
```

---

## `replace_in_file`

Multi-occurrence / regex find-and-replace across one or more files, with a line-numbered
before/after preview and explicit refusals instead of silent surprises.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | Single file (leading `@` stripped, resolved against cwd). |
| `paths` | string[] | — | Several files getting the same replacement in ONE call (replaces a `for f in …; do sed -i …` loop). Duplicates/aliases are de-duplicated. |
| `find` | string | — | Verbatim text (`literal`) or JS regex source (`regex`). |
| `replace` | string | — | Inserted verbatim, except that in `regex` mode `$1 $2 … $& $\` $' $<name> $$` expand exactly like `String.prototype.replace`. Backslash escapes are **never** interpreted (put a real newline for a newline). In `literal` mode `$1`/`\n` are inserted literally. |
| `mode` | `literal` \| `regex` | `literal` | `literal` needs no escaping and is linear-time (safe on huge files). |
| `flags` | string | — | Extra regex flags (`m`, `s`, `u`…). `g` is always applied; passing `g`/`y` is rejected. `i` comes from `caseSensitive`. |
| `replaceAll` | boolean | `true` | With `false`, the call is **refused** if more than one occurrence exists (never silently changes only the first). |
| `maxReplacements` | number | `200` | Per-file cap. Exceeding it writes **nothing** and reports the count. |
| `dryRun` | boolean | `true` | Default is preview-only — no file is opened for writing (proven by checksum+mtime tests). Pass `false` to apply. |
| `caseSensitive` | boolean | `true` | |

### Refusals (nothing is written)

- 0 matches in any file → `NO CHANGES`, with hints (case-insensitive match exists; file is CRLF but
  `find` used a bare `\n`).
- more matches than `maxReplacements` (per file).
- `replaceAll:false` with >1 match.
- `find === replace`, or a regex whose expansion equals the matched text (no-op).
- regex that can match the empty string; invalid regex.
- binary (NUL bytes) or non-UTF-8 file — refused rather than corrupted, verified by re-encoding the
  decoded text and requiring byte equality with the original.
- regex scan exceeding a 5 s wall-clock budget (catastrophic backtracking) — the scan runs in a
  worker thread that is hard-terminated.
- write failures (e.g. read-only file) are reported **per file**, so a multi-file call still tells
  you exactly which files were written.

### Preservation guarantees

Only the replacement sites change. CRLF vs LF, a missing final newline, a BOM, and arbitrary unicode
are preserved byte-exactly (each has a regression test).

### Output shape

```
APPLIED — 12 replacement(s) in 3 file(s)  [mode=literal, written]

=== /abs/path/SharedSubscriptionUtils.kt — 5 replacement(s) (LF, final newline: yes) ===
  L75 (2 matches on this line)
    -             restaurant?.subscriptionInformation?.orderMinimum ?: benefit.orderMinimum()
    +             restaurant?.subscriptionInformation?.minimumOrderCents ?: benefit.minimumOrderCents()
  size: 3.4 KB -> 3.4 KB
```

`details.files[].scanner` is `literal`, `worker-guarded`, or **`inline-fallback`**. `inline-fallback`
means a worker thread could not be created, so the regex ran *without* the backtracking timeout —
the result is still correct but was not time-bounded, and the text output says so explicitly. The
tool's `promptGuidelines` tell the agent to treat that tag as lower confidence.

```jsonc
// replaces: sed -i '' 's/orderMinimum/minimumOrderCents/g' a.kt b.kt c.kt
{ "paths": ["main/A.kt", "main/B.kt", "test/CTest.kt"],
  "find": "orderMinimum", "replace": "minimumOrderCents", "dryRun": false }

// replaces: python3 - <<'PY' … re.sub(r'foo\((\d+)\)', r'bar(\1, DEFAULT)', s) … PY
{ "path": "Money.kt", "mode": "regex",
  "find": "foo\\((\\d+)\\)", "replace": "bar($1, DEFAULT)", "dryRun": false }
```

---

## When NOT to use these

- One precise, unique change → built-in **`edit`** (cheaper, already refuses ambiguity). Validated:
  with both tools available the agent still chose `edit` for a single-occurrence rename.
- Creating a file from scratch or replacing its whole contents → built-in **`write`**.

## Tests

```bash
node test/suite.mjs            # 65 deterministic correctness/adversarial tests (no LLM)
node test/harness.mjs replace_in_file '{"path":"x.txt","find":"a","replace":"b"}' /tmp/scratch
./test/bench.sh <case> <fixture-dir> "<prompt>" --model … # paired with/without benchmark
```

`FWP_FORCE_INLINE_SCAN=1` is a test-only seam that forces the degraded (unguarded) regex path.

## Measured results (Claude Sonnet 4.6, real repo files, `pi --mode json`)

Output tokens are the cache-independent metric (never cached, most expensive); "new tokens" totals
are distorted by one-time prompt-cache fills.

| case | calls with/without | output tokens with/without | correctness |
|---|---|---|---|
| rename identifier, 12 sites / 3 real Kotlin files (3 phrasings) | 3/12, 2/9, 2/4 | 493/3516, 455/2405, 483/756 | with: 4/4 byte-exact; without: 1 of 4 runs left a site unrenamed after `sed -i ''` |
| append entry to a 52 KB execution log | 1/3 | 133/273 | both correct (without used `tail` + `printf >>`) |
| append shell-hostile text (`$VAR`, backticks, `\1`) | 1/3 | — | both correct |
| replacement containing `$`/backslashes in 2 files | 4/7 | 617/841 | both correct; without's first `edit` failed on a non-unique match |
| control: single unique rename | 2/2 | 219/235 | agent chose built-in `edit` in both (no over-triggering) |

Fixed cost: the two tool schemas + guidelines add ≈1.15 k tokens to the (cached) prompt prefix per
session.
