# list-files

Registers the `list_files` tool: find/list files and directories by **name, type, depth, size or mtime**
in a single structured call, instead of a `find`/`ls` shell pipeline.

Install: symlink or copy this directory into `~/.pi/agent/extensions/list-files`
(no runtime dependencies — pure `node:fs`, no shell, no npm packages).

## Why

Parsing all 266 real sessions in `~/.pi/agent/sessions` (2160 tool calls, 1334 of them `bash`):
**356 of 1539 shell commands were file listings**, and 92 were pure single-command listings this
tool replaces outright.

| bash idiom | count | `list_files` equivalent |
|---|---|---|
| `find -name/-iname` | 129 | `globs: ["*Foo*"]` |
| `ls -la` | 66 | `maxDepth: 1, withMeta: true` |
| `ls \| grep` | 52 | `maxDepth: 1, globs: [...]` |
| `find ... -o -iname ...` | 39 | `globs: ["*A*", "*B*"]` (one call) |
| `find \| grep -v` | 36 | `excludeGlobs: [...]` |
| `find -not -path "*/build/*"` | 29 | free — pruned by default |
| `find -type f` | 22 | `type: "file"` |
| `find -maxdepth N` | 21 | `maxDepth: N` |
| `find -type d` | 8 | `type: "dir"` |
| `find -newermt/-mtime` | 4 | `modifiedAfter: "2d"` |
| `readlink` | 15 | `resolveSymlinks: true` |
| `find ... \| wc -l`, `\| sort \| uniq -c` | — | `countOnly: true` |

Not covered on purpose (still use `bash`): `find -exec`, `du`, `stat` format strings, git-aware
listings (`git ls-files`). Use **`grep`** for file *contents* and **`code_search`** for symbol
*declarations* — `list_files` never looks inside files.

## Parameters

| param | type | meaning |
|---|---|---|
| `paths` | `string[]` | Roots to walk (default `["."]` = cwd). A file root behaves like `ls <file>`. `~` and a stray leading `@` are handled. Missing roots become `!!!!! path - ERROR: ...` lines; the other roots still run. |
| `globs` | `string[]` | Match if ANY pattern matches. Case-insensitive (like `-iname`) against the **basename**, or against the **path relative to the root** when the pattern contains `/`. Supports `*`, `**`, `?`, `[abc]`, `{a,b}`. Omit to list everything. |
| `excludeGlobs` | `string[]` | Same matching; a matching **directory is pruned** (whole subtree skipped), a matching file is dropped. |
| `type` | `"file" \| "dir" \| "any"` | Default `"any"`. Symlinks are classified by their **target** (a broken/looping link is neither file nor dir, exactly like `find -type f`). |
| `maxDepth` | `number` | Depth below each root. `1` = direct children only (a plain `ls`). Default unlimited. |
| `modifiedAfter` | `string` | `"30m"`, `"6h"`, `"2d"`, `"1w"` or an ISO date. Unparseable values throw with a hint. |
| `sortBy` | `"path" \| "mtime" \| "size"` | `path` (default, lexicographic), `mtime` (newest first), `size` (largest first). Sorting happens over **all** matches before `limit` is applied, so "5 largest/newest" is exact. |
| `countOnly` | `boolean` | Total + per-directory breakdown instead of paths (a few hundred bytes). Replaces `\| wc -l` and `sort \| uniq -c`. |
| `withMeta` | `boolean` | Aligned `size  YYYY-MM-DD HH:MM  path` columns (`ls -la`). |
| `resolveSymlinks` | `boolean` | Append ` -> <realpath>`; broken links show `(broken link)`, cycles `(symlink loop)`. Replaces `readlink -f`. |
| `includeIgnored` | `boolean` | Descend into the default-pruned noise dirs: `.git, build, node_modules, .gradle, dist, .idea, .venv`. |
| `caseSensitive` | `boolean` | Default `false` (like `-iname`). |
| `limit` | `number` | Max paths emitted (default 100, max 5000). Passing an explicit `limit` also raises the output byte budget from 8KB to 50KB. |

Singular aliases (`path`, `dir`, `directory`, `glob`, `pattern`, `patterns`, `exclude`, `excludes`)
and bare strings where an array is expected are accepted via `prepareArguments`.

## Output shape

```
list_files: 15 match(es), 461 entries scanned in 10ms under features/subscriptions (globs=[*Analytics*.kt] exclude=[**/test/**] type=file)
  note: pruned 1 default-ignored dir(s) (build×1); pass includeIgnored:true to include them.

features/subscriptions/src/main/java/.../SubscriptionAccountAnalytics.kt
...
```

- One path per line, relative to the root as given (absolute if the root was) → directly citable by `read`.
- Directories get a trailing `/`; symlinks show ` -> target` when `resolveSymlinks` is set.
- **Total match count is always in the header**, so `limit` truncation is never silent; the footer says
  exactly how to narrow (tighter glob, subdirectory, `maxDepth`, `countOnly`, or a bigger `limit`).
- Machine-visible provenance/incompleteness markers, each also mirrored in `details`:
  `[substring fallback]` (a wildcard-free pattern matched nothing exactly and was loosened — lower
  confidence), `pruned N default-ignored dir(s)`, `N dir(s) not readable: ... (permission denied)`,
  `unfiltered recursive listing`, `SCAN CAP` (400k entries), `TIME CAP` (20s), `MATCH CAP` (50k matches,
  header switches to `>=N match(es)`), and `output clipped`.

## Safety / correctness properties

- **No shell.** Filenames with spaces, quotes, `$(...)`, `;`, newlines or unicode need no escaping
  and cannot be re-interpreted (verified against all of those).
- **Symlinked directories are never traversed** (like `find` without `-L`), so self-loops, mutual
  loops and a `link -> ancestor` cycle terminate immediately instead of hanging.
- **Permission errors are reported**, not swallowed like `2>/dev/null`, and the walk continues.
- **Noise pruning happens before descending**, which is why a 194k-entry, 14GB multi-repo tree walks
  in ~4s vs 57s for the equivalent `find ... -not -path '*/build/*'` (identical 23,715 results).

## Known limitations

- Case folding is Unicode-simple, exactly like `find -iname`: `needle` does not match `Nëëdle`
  (no diacritic folding, no NFC/NFD normalization). Stated in the no-match hints.
- No `.gitignore` awareness (only the fixed noise-dir list). Use `git ls-files` via bash for that.
- Not tested on Windows; path handling assumes POSIX separators in emitted output.

## Testing

```bash
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --skipLibCheck --esModuleInterop --allowImportingTsExtensions index.ts

node smoke-test.mjs '{"paths":["features/subscriptions"],"globs":["*Analytics*.kt"],"type":"file"}' ~/some/repo

node verify-risks.mjs   # 74 assertions: 12k-entry dir, symlink loops, permission-denied,
                        # unicode/space/newline names, maxDepth×limit, empty globs, caps,
                        # abort, renderers, + 4 differential comparisons against real `find`
```
