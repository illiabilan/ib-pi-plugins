# path-stats

Registers the `path_stats` tool: **the pre-flight "how big is this thing?" probe**, so the agent can
decide *how* to read something before reading it — and stop spending a bash round-trip per `wc -l`.

Install: copy or symlink this directory into `~/.pi/agent/extensions/path-stats`
(or load it explicitly with `pi -e /abs/path/to/extensions/path-stats/index.ts`).

## Why it exists

In 266 real pi sessions, 1334 of 2160 tool calls were `bash`. **88 of the 1539 shell commands were
pure size/shape probes**: `wc -l` ×54, `du`/`df`/`stat` ×20+, `wc -c|-w` ×4 — and 36 bash outputs
blew past 10 KB because nothing was measured before it was dumped. `path_stats` collapses all of
those into one typed call that can measure many paths at once.

## Bash idioms it replaces

| Bash | path_stats |
|---|---|
| `wc -l file` | `{paths:["file"]}` (lines is on by default) |
| `wc -c file` / `stat -f %z file` | `{paths:["file"],metrics:["bytes"]}` |
| `wc -w file` | `{paths:["file"],metrics:["words"]}` |
| `stat -f %m file` | `{paths:["file"],metrics:["mtime"]}` |
| `shasum -a 256 file` | `{paths:["file"],metrics:["sha256"]}` |
| `wc -l a b c` / a loop of `wc` calls | `{paths:["a","b","c"]}` — one call |
| `du -sh dir` | `{paths:["dir"],recursive:true}` |
| `find dir -type f \| wc -l` | `recursive:true` → `files N` in the aggregate |
| `find dir -type f -exec du -a {} + \| sort -n \| tail` | `recursive:true` → `largest files:` block |
| `find dir -name '*.ts' \| xargs wc -c \| tail -1` | `recursive:true` → `by extension:` block |
| `ls -la dir` used only to see sizes | `{paths:[...]}` / `recursive:true` |

Not covered on purpose: **listing and globbing** (use `list_files`/`grep`/`ls`). `path_stats`
measures paths you already know.

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `paths` | `string[]` | required | Files and/or dirs. Relative to cwd, absolute, or `~/...`; a stray leading `@` is stripped; trailing slashes tolerated. Max 200 per call (extra paths are reported, not silently dropped). |
| `metrics` | `('lines'\|'bytes'\|'words'\|'mtime'\|'type'\|'sha256')[]` | `['bytes','lines']` | `bytes`/`mtime`/`type` are stat-only (free). `lines`/`words`/`sha256` stream the file once, computing all requested content metrics in a single pass. |
| `recursive` | `boolean` | `false` | For directories: walk the tree and emit a `du`-style aggregate block. Without it a directory only reports its own entry count. |
| `followSymlinks` | `boolean` | `false` | Follow symlinked directories/files while walking (cycle-safe via realpath set). Symlinks named directly in `paths` are always resolved and their target shown. |
| `limit` | `number` | `200000` | Max files walked per directory. Hitting it (or the 12s time budget) marks the aggregate `PARTIAL`. |
| `top` | `number` | `5` | How many largest files to list per directory (`0` disables). |

## Output

```
PATH                TYPE  BYTES                LINES    NOTES
logs/app.log        file  5000001 (4.8 MB)     57096
README.md           file  92                   3
src/noeol.py        file  18                   1*       no-final-newline (* = wc -l count; +1 unterminated line)
vendor/blob.bin     file  100000 (97.7 KB)     -        binary (NUL byte) — lines/words not counted
broken-link         ERROR -                    -        broken symlink -> /nope (ENOENT: no such file or directory)

=== data/ (recursive aggregate) ===
files 6  dirs 0  symlinks 0  total 5413400 (5.2 MB)  [sum of regular-file sizes, apparent; ...]
largest files:
  1568900 (1.5 MB)   fixture5.json
by extension:
  .json           6 files  5.2 MB
scanned in 3ms
```

`details` carries the same data machine-readably (`rows[].bytes/lines/words/sha256/mtimeMs/binary/
noFinalNewline/crlf/symlinkTarget/error`, `rows[].aggregate`), so `tool_result` handlers don't have to
parse the table.

## Exactness guarantees (verified against the real commands, see `verify.mjs`)

- `lines` == `wc -l` **exactly** — it counts `\n` bytes. A file whose last line lacks a newline
  therefore reports N with a `*` and a `no-final-newline` note, meaning N+1 lines of text.
- `bytes` == `wc -c` / `stat -f %z` (apparent size; sparse files report apparent, not blocks).
- `words` == `LC_ALL=C wc -w` (runs of non-ASCII-whitespace bytes). **Known divergence:** a
  UTF-8-locale `wc -w` can differ by a word on files containing Unicode whitespace (e.g. U+00A0);
  byte semantics were chosen because they're deterministic across platforms/locales.
- `sha256` == `shasum -a 256`.
- Directory `total` = sum of regular-file sizes (apparent). This is *below* `du -sh`, which reports
  allocated disk blocks and includes directory inodes — on a 100 MB fixture tree: 102149 KB apparent
  vs `du -sk` 102184 KB. The output says so on every aggregate line.

## Safety / degraded paths (all made visible in the output, not just documented)

- **`PARTIAL`** aggregates state which bound was hit (`limit` = deterministic, `time` = load-dependent
  and can differ between calls), how many directories were never scanned, and what to do next
  (raise `limit` once vs. switch to per-subdirectory aggregates / `du -sh`).
- **Binary files** short-circuit after a 64 KB NUL sniff: `binary` is reported and lines/words are
  omitted rather than streaming 100 MB for a meaningless count (`sha256` still hashes fully).
- **Non-regular files** (FIFO, socket, char/block device) are never opened — `/dev/zero` and an unread
  FIFO would otherwise hang or stream forever.
- **Broken symlinks** are reported as `broken symlink -> target`, not a bare ENOENT.
- **Unreadable directories** are counted and named in the aggregate, and totals say they're excluded.
- Per-path failures are ERROR rows; one bad path never fails the call. Output is capped at 20k chars.
- Filenames containing control characters are escaped in the table (a filename can otherwise forge a
  row or break alignment). No shell is used at all, so no quoting/injection surface.

## Performance

Measured on this machine (Node 26, macOS, APFS):

| Case | Time |
|---|---|
| stat-only metrics on any file (incl. a sparse 1 GB file) | ~1 ms |
| `lines` on a 104 MB / 1.9M-line text file | ~160 ms (`wc -l` ≈ 130 ms) |
| recursive walk, 20k files | ~140 ms |
| recursive walk, 50k files | ~0.9 s |
| recursive walk, 294k files / 7.3 GB (real Android repo) | ~7 s (`du -sh` ≈ 8 s) |

Directories are read in concurrent batches of 24 (`DIR_BATCH`) with up to 64 concurrent `stat`s;
one-directory-at-a-time walking measured ~4× slower on the 294k-file tree. Line counting streams in
1 MB chunks and never buffers the file.

## Testing

```bash
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --skipLibCheck --esModuleInterop --allowImportingTsExtensions --strict index.ts

node verify.mjs        # 86 assertions vs wc -l/-w/-c, stat, shasum, find|stat sums (self-generating fixtures)
node adversarial.mjs   # 39 assertions: broken symlink, EACCES dir, FIFO/devices, sparse 1GB, 100%-no-newline
                       # file, 400-deep tree, symlink loop, control-char/injection filenames, abort, 20k files
node smoke-test.mjs '{"paths":["index.ts","."],"recursive":true,"metrics":["lines","bytes"]}'
```

## Validation summary (what was measured, not assumed)

Head-to-head `pi --mode json` runs (claude-sonnet-4-5, `--thinking high`), tool available vs
`--exclude-tools path_stats`:

- **3-probe task** ("line count of the log, byte size of README, total size of data/"):
  1 `path_stats` call vs **4** bash calls — and the bash route answered **wrong**
  (10,826,800 bytes instead of 5,413,400: its `find … -exec wc -c {} + | awk sum` double-counted
  wc's own `total` line). `path_stats` matched ground truth exactly.
- **Pre-flight before reading a 5 MB log**: with `path_stats` the agent measured first, then read a
  100-line window + targeted greps → **10,491 new tokens**; without it, it blind-`read` the file →
  **22,902 new tokens** (−54%) and produced a weaker, partly wrong summary. Measuring first happened
  in **4/4** independent runs with 3 different phrasings.
- **Fixed cost:** the tool's schema + guidelines add ~820 tokens to the first request of a session
  (turn-1 `cacheWrite` 2904 vs 2084 baseline), cached thereafter. On a *small* 3-probe task that
  slightly exceeds the tokens saved (~13% more total); the win is correctness, round-trips, and any
  task where a measurement avoids a large dump. Descriptions were trimmed once already for this
  (1214 → 820 tokens) — keep them tight when editing.
- **PARTIAL handling:** asked for a "trustworthy" total on a 294k-file repo, the agent never trusted a
  PARTIAL number — it escalated `limit` and got the exact total (7,836,036,548 B, matching
  `find|stat`), or fell back to `du -sh` when the time budget was hit.
