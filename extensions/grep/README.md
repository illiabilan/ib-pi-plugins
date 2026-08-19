# Grep Extension for Pi

A Pi extension that wraps **ripgrep** (with a POSIX **grep** fallback) and exposes the whole
grep/rg flag surface as tool parameters, so the agent never has to shell out to bash to search.

Evidence for why this matters: across 266 real pi sessions, `bash` accounted for 62% of all tool
calls, and **606 of 1539 shell commands contained `grep`/`rg`** — while the `grep` *tool* was used
only 55 times. The most common shapes were `grep | head` (148), `<cmd> | grep` (158),
`grep | grep` (86), `grep | grep -v` (60), `grep -v` (150), `grep -o` (57), `grep -c` (23),
`grep -l` (~79), `grep -q` (19), `grep | wc -l` (17). Every one of those now has a parameter.

## Bash idioms this tool replaces

| Bash | Tool |
|---|---|
| `grep -r pat dir` | `{pattern, directory}` |
| `grep -v pat file` | `{pattern, file, invertMatch: true}` |
| `grep -v pat file \| wc -l` | `{pattern, file, invertMatch: true, outputMode: "count"}` |
| `grep pat dir \| grep pat2` | `{pattern, andPattern: "pat2"}` |
| `grep pat dir \| grep -v build/` | `{pattern, notPattern: "build/"}` |
| `grep -rl pat dir` | `{pattern, outputMode: "filesOnly"}` |
| `grep -rL pat dir` (files WITHOUT a match) | `{pattern, withoutMatch: true, outputMode: "filesOnly"}` |
| `grep -rl pat dir \| wc -l` / `comm` set-diff of file lists | `{pattern, withoutMatch: true, outputMode: "count"}` |
| `grep -c pat file` | `{pattern, file, outputMode: "count"}` |
| `grep pat dir \| wc -l` | `{pattern, outputMode: "count"}` (exact total, per-file breakdown) |
| `grep -q pat file && echo yes` | `{pattern, file, outputMode: "exists"}` |
| `grep -o 'pat' file` | `{pattern, file, onlyMatching: true}` |
| `grep -oE 'x=(\d+)' \| cut -d= -f2` | `{pattern: "x=(\\d+)", captureGroup: 1}` |
| `grep -o pat -r dir \| sort \| uniq -c \| sort -rn` | `{pattern, aggregateMatches: true}` |
| `grep -w id dir` | `{pattern: "id", wordBoundary: true}` |
| `grep pat dir \| cut -c1-200` (tame minified lines) | `{pattern, maxLineLength: 200}` (on by default at 1000) |
| `find dir -iname "*a*" -o -iname "*b*"` | `{filenamePattern: ["*a*", "*b*"]}` |
| `find dir -iname "*X*" \| xargs grep -l pat` | `{filenamePattern: "*X*", pattern, outputMode: "filesOnly"}` |
| `find dir -iname "*.kt" \| wc -l` | `{filenamePattern: "*.kt", outputMode: "count"}` |
| `grep pat dir \| head -n 40` | `{pattern, limit: 40}` (default 500) |
| several searches joined with `echo "---"` | `{queries: [ ... ]}` |

## Parameters

Every field below can be used at the top level **or per entry inside `queries[]`** (per-query
overrides: one entry can be a count, another a files-only list, another an extraction).

### Where to search
| Param | Type | Meaning |
|---|---|---|
| `pattern` | string | Text/regex searched inside file contents. Optional if `filenamePattern` is given. |
| `file` | string | Search a single file. |
| `directory` | string | Directory to search (default: cwd). |
| `filenamePattern` | string \| string[] | Glob(s) matched case-insensitively against the file name/path (`find -iname`). Without `pattern` it just lists paths. |
| `include` | string \| string[] | Restrict content search to these globs (`rg -g`, `grep --include`). |
| `exclude` | string \| string[] | Drop whole files by glob (`rg -g '!x'`). |

### What to match
| Param | Type | Meaning |
|---|---|---|
| `regex` | boolean (true) | `false` = literal/fixed-string matching (`-F`). |
| `caseSensitive` | boolean (true) | `false` = `-i` (also applies to `andPattern`/`notPattern`). |
| `wordBoundary` | boolean (false) | `-w`: whole words only, so `id` doesn't match `uuid`. |
| `invertMatch` | boolean (false) | `-v`: lines that do NOT match `pattern` (line-level). |
| `withoutMatch` | boolean (false) | `grep -L` / `rg --files-without-match`: files where `pattern` never appears (file-level). Requires `outputMode` `filesOnly` or `count`. |
| `andPattern` | string | Result line (or path, in files-only mode) must ALSO match this — replaces `\| grep pat2`. |
| `notPattern` | string | Result line (or path) must NOT match this — replaces `\| grep -v pat2`. Applied after `andPattern`. |

### What to return
| Param | Type | Meaning |
|---|---|---|
| `outputMode` | `content` \| `filesOnly` \| `count` \| `exists` | `content` (default) = matching lines; `filesOnly` = paths only; `count` = per-file counts + an **exact** total; `exists` = yes/no + first hit. Overrides the legacy `filesOnly` boolean. |
| `filesOnly` | boolean (false) | Legacy alias for `outputMode: "filesOnly"` (kept for backward compatibility). |
| `onlyMatching` | boolean (false) | `-o`: return only the matched substring. |
| `captureGroup` | number | With `onlyMatching`: return only this group (1-based, `0` = whole match). Implies `onlyMatching`. Ripgrep only. |
| `aggregateMatches` | boolean (false) | Implies `onlyMatching`: unique matched values + occurrence counts, most frequent first (`\| sort \| uniq -c \| sort -rn`). |
| `lineNumbers` | boolean (true) | Include line numbers in content output. |
| `context` | number (0) | Context lines around matches (`-C`), content mode only. |
| `limit` | number (500) | Max output lines/rows for this query. |
| `maxLineLength` | number (1000) | Clip each returned line at N chars with a `[line truncated: showed N of M chars]` marker; `0` disables. |
| `queries` | array | Run several labeled searches in one call; each element takes all of the above plus `label`. |

## Output guarantees / markers

- **Totals are always exact in `count` and `aggregateMatches` modes**, even when the listing is
  truncated: totals are computed in-pipeline (awk) over the full stream *before* any row cap, and
  emitted ahead of the rows. Verified on 120,000 matches across 60,000 files and on 60,000
  distinct values — the listing gets capped, the totals do not.
- `... [output truncated at N lines / M chars ...]` — more matches exist; narrow or raise `limit`.
- `... [K more file(s)/value(s) not listed ...]` — listing shortened, totals still exact.
- `… [line truncated: showed N of M chars]` — that single line was long (minified/bundled), the
  match itself is intact.
- `[engine: grep-fallback]` — ripgrep was not on PATH, POSIX grep ran instead: `.gitignore`
  handling differs, `captureGroup` is not applied, and per-file count labels split on `:`.
- `[note: ...]` — an option was reinterpreted or ignored (e.g. `captureGroup` in the fallback).
- `[warning: the search also reported errors, results may be partial: ...]` — stderr was
  non-empty (e.g. a permission-denied subtree) but real results came back.
- `Error: search command failed ...` — a bad path/flag. A zero result plus non-empty stderr is
  reported as an error, never as a confident `count: 0` / `exists: false`.
- Known limits: ripgrep skips `.gitignore`d and binary files while recursing (pass `file` or
  `include` to inspect those); `withoutMatch` + `invertMatch`, `onlyMatching` + `invertMatch`,
  and `onlyMatching` + `filesOnly` are rejected with an explicit message instead of silently
  returning misleading output (`rg -o -v` prints whole lines, which looks like an extraction).

## Example Usage

```js
// Which dependency coordinates are used, and how often? (one call, 133k matches -> ~30 lines)
grep({ pattern: 'implementation "([^"]+)"', include: "*.gradle*", captureGroup: 1, aggregateMatches: true })

// Count + sample in ONE call instead of `grep -v ... | wc -l` plus `grep -v ... | head -5`
grep({ queries: [
  { label: "count",  pattern: "^\\s*(//|$)", file: "Foo.kt", invertMatch: true, outputMode: "count" },
  { label: "sample", pattern: "^\\s*(//|$)", file: "Foo.kt", invertMatch: true, limit: 5 },
]})

// Files that never mention Composable (replaces `grep -rL`, or `comm` on two file lists)
grep({ pattern: "Composable", include: "*.kt", withoutMatch: true, outputMode: "count" })

// Cheap existence check (replaces `grep -q`)
grep({ pattern: "okhttp", include: "*.gradle*", outputMode: "exists" })

// Non-import lines, only outside build/ and test/, first 20
grep({ pattern: "^(import|package)", include: "*.kt", invertMatch: true, notPattern: "(build|test)/", limit: 20 })

// Which files match, excluding generated paths (replaces `grep -rl ... | grep -v build/`)
grep({ pattern: "TODO", outputMode: "filesOnly", notPattern: "/build/" })
```

## Installation

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/grep     # or: cp -r . ~/.pi/agent/extensions/grep
```

No npm dependencies (ripgrep is used if present on PATH, otherwise POSIX grep).
