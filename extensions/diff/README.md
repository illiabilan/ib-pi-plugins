# Diff Extension for Pi

A single `diff` tool that compares **two files**, **two directory trees**, or **two inline strings**
and returns *bounded*, structured output — so the agent never has to pipe `diff -u` through
`head`/`tail` and hope the interesting part survived.

Everything is implemented in-process (Myers diff, unique-line anchoring, streaming byte compare,
streaming hash). There is no dependency on the system `diff`, so behavior does not change between
GNU and BSD `diff`, and no dependency on `git`.

## Why

Measured over 266 real pi sessions (2160 tool calls, 1539 shell commands inside `bash`), **40 shell
commands were `diff`/`cmp`** — comparing a file against a backup, generated output against expected
output, or two directory trees, usually with `| head` bolted on because `diff -u` output is
unbounded. This tool replaces those calls with one bounded call whose caps and caveats are explicit.

## Bash idioms this replaces

| Bash | diff tool |
|---|---|
| `diff -u a b \| head -50` | `{action:'files', a, b}` (auto-capped, explicit truncation marker) |
| `diff -u a b \| wc -l`, `diffstat` | `{action:'files', a, b, outputMode:'stat'}` |
| `cmp -s a b && echo same` | `{action:'files', a, b, outputMode:'namesOnly'}` (or read the verdict line) |
| `diff -y a b` | `{action:'files', a, b, outputMode:'sideBySide'}` |
| `diff -w a b` / `diff -B a b` / `diff -U5 a b` | `ignoreWhitespace` / `ignoreBlankLines` / `contextLines` |
| `diff -rq dirA dirB \| head` | `{action:'dirs', a, b}` |
| `diff -r --exclude=node_modules --exclude=build A B` | `{action:'dirs', a, b, ignore:[...]}` |
| `diff -r A B` (with patches) | `{action:'dirs', a, b, outputMode:'unified'}` |
| `diff <(cmd1) <(cmd2)`, `diff expected.txt actual.txt` after writing temp files | `{action:'text', a:'…', b:'…'}` |
| `cat -A a b`, `xxd a b`, `file a` to explain "they look the same but differ" | automatic `note:` lines (CRLF vs LF, missing trailing newline) and binary detection |

Not covered on purpose: **git-tracked changes** (working tree vs HEAD, commit vs commit, branch
diffs). That belongs to the `git` tool; this tool is for arbitrary paths.

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `action` | `'files' \| 'dirs' \| 'text'` | required | file paths / directory trees / literal strings |
| `a`, `b` | string | required | the two sides (paths for `files`/`dirs`, content for `text`). A leading `@` is stripped; relative paths resolve against the session cwd |
| `labelA`, `labelB` | string | the path, or `a`/`b` | display labels (useful for `text`: `expected`/`actual`) |
| `outputMode` | `'unified' \| 'stat' \| 'namesOnly' \| 'sideBySide'` | `unified` for files/text, `stat` for dirs | see below |
| `contextLines` | number | 3 (max 20) | like `diff -U n` |
| `ignoreWhitespace` | boolean | false | like `diff -w` (all in-line whitespace ignored when matching lines) |
| `ignoreBlankLines` | boolean | false | like `diff -B` |
| `maxLinesPerFile` | number | 300 (max 20000) | cap on diff body lines per file |
| `maxTotalLines` | number | 1200 (max 20000) | cap on diff body lines for the whole call |
| `ignore` | string[] | `.git, node_modules, build, dist, out, target, .gradle, .idea, __pycache__, .venv` | `action:'dirs'` only; globs matched against basename **and** path relative to the tree root; replaces the default list |

### Output modes

- `unified` — `+n/-n` summary line, then standard unified hunks (`--- / +++ / @@`), capped.
- `stat` — just the summary: `a -> b: +n -m lines (X -> Y lines total) in k hunk(s)`.
- `namesOnly` — `differ: a b (+n -m)` for files; only the file names for dirs.
- `sideBySide` — two columns with `<`, `>`, `|` change markers.
- For `action:'dirs'`, `unified`/`sideBySide` additionally append a per-file patch for each differing
  file (bounded by `maxTotalLines`); `stat`/`namesOnly` never emit patch bodies.

## What it detects instead of dumping bytes

- **Identical files** — equal size + streaming byte compare, no read of the whole file, no diff:
  `identical: … byte-for-byte identical (12 B)` + `source: identical`.
- **Binary files** — NUL sniff on the first 8 KB; reports size + sha256 prefix per side and whether
  they match. Never dumps bytes.
- **Very large files** — over 8 MB per file, the tool streams both files for size/line count/sha256
  (plus the first differing byte offset when sizes are equal) and reports `source: size-only`
  instead of line-diffing.
- **CRLF vs LF** — reported as `NOT identical: content lines match, but the files differ in line
  endings` with `+0 -0` plus a `note:` line, so a whitespace-invisible difference never looks like
  "no difference".
- **Missing trailing newline** — treated exactly like GNU `diff`/`patch`: an unterminated last line
  is a distinct token, so it shows as a ±1 change on the last line carrying a
  `\ No newline at end of file` marker, plus an explicit `note:`. This is what makes the emitted
  patch byte-faithful (an earlier implementation that treated it as "equal content + a note"
  produced patches that silently re-added the newline — caught by fuzzing against `patch`).
- **Symlinks (dirs mode)** — never followed: reported as `only in a/b (symlink -> target)`,
  `symlink targets differ`, or `type mismatch (a: file, b: symlink)`.

## `source:` provenance tag (read this before trusting counts)

| `source` | Meaning | Trust |
|---|---|---|
| `identical` | byte compare proved equality | exact |
| `myers` | exact minimal line diff (the normal case) | exact |
| `anchored` | region too large for exact Myers; unique common lines used as anchors, each gap diffed separately | correct diff, near-minimal counts (measured within 0.2% of GNU `diff` on 25k-line files) |
| `coarse-fallback` | some segment had no unique common lines; shown as one wholesale removal+insertion | `+n/-n` are **upper bounds** |
| `size-only` | over the 8 MB line-diff cap | no line counts at all |
| `binary` | binary content | no line counts at all |

The `source:` line only appears in output when it is *not* the plain exact case, i.e. absence of a
caveat is itself information.

## Caps and truncation

- Per-file body cap (`maxLinesPerFile`, default 300) and whole-call cap (`maxTotalLines`, default
  1200). Truncation always prints how many hunks were shown out of how many, and the true `+n/-n`.
- `dirs` walk: max 20 000 entries per tree (lexicographic order, so both trees cut at the same
  point), max 200 entries listed per section, per-file `+n/-n` computed for the first 200 differing
  files (the rest are listed as `counts not computed (detail cap reached)`).
- If the walk hits the entry cap the result says so explicitly *and* warns that the "only in" lists
  are unreliable near the cut-off.
- `dirs` output also reports what the ignore globs actually suppressed
  (`skipped by ignore globs: build (1 path)…`, or "none matched anything"), so there is no need to
  separately verify whether the defaults hid something.

## Examples

```js
diff({ action: "files", a: "src/Foo.kt", b: "/tmp/Foo.kt.bak" })
diff({ action: "files", a: "a.json", b: "b.json", outputMode: "stat" })
diff({ action: "files", a: "before.py", b: "after.py", ignoreWhitespace: true })   // reformat check
diff({ action: "dirs",  a: "out/before", b: "out/after" })
diff({ action: "dirs",  a: "gen1", b: "gen2", outputMode: "unified", ignore: [".git", "build"] })
diff({ action: "text",  a: expectedJson, b: actualJson, labelA: "expected", labelB: "actual" })
```

## Install

```bash
cp -r extensions/diff ~/.pi/agent/extensions/diff     # global
# or
cp -r extensions/diff <project>/.pi/extensions/diff   # project-local
```

No runtime dependencies (Node built-ins only); `package.json` lists type-only devDependencies.

Quick check without installing:

```bash
pi -e extensions/diff/index.ts --mode json -p "diff Old.kt and New.kt and tell me what changed"
```

## Validation notes (see the tool's own guidance for the short version)

- Output was verified to be a **valid patch**: 60/60 randomized cases (including 10 forced through
  the `anchored` path on 26 000-line files, and cases with either/both sides missing the trailing
  newline) applied cleanly with `patch` and reproduced side `b` byte-for-byte; all 7
  trailing-newline permutations were additionally checked one by one.
- `+n/-n` and hunk counts matched GNU `diff -U3` on 1500/1500 seeded-random cases and 200/200
  unseeded ones. Known intentional deviation: when two changes are separated by exactly
  `2 x contextLines` identical lines, this tool merges them into one hunk where GNU `diff` emits two
  — same content, slightly less output.
- Head-to-head against the bash route on a real 1016-line Kotlin file with 6 scattered edits:
  2 740–8 467 new tokens with this tool vs 24 874–31 105 without (−73%, −85%, −91% on three
  cache-warm pairs); both routes found all 6 changes.
- A 6 000-file-per-tree directory comparison: 2 303 tokens / 2 calls vs 29 705 tokens / 5 calls.
