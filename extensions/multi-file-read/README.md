# multi-file-read

Registers the `multi_file_read` tool: read many text files in a single tool call.

Install: symlink or copy this directory into `~/.pi/agent/extensions/multi-file-read`.

## Output shape

```
multi_file_read: 2 file(s) read, 1 error(s), 330 lines, 12.9KB

===== extensions/grep/index.ts (lines 1-285 of 285) =====
  1|import ...
...
!!!!! extensions/nope/index.ts - ERROR: file not found !!!!!
```

## Behavior

- `files: [{path, offset?, limit?}]` (plain strings and a legacy `paths` key are also accepted).
- Reads run in parallel; per-file failures become `!!!!! path - ERROR: ... !!!!!` entries instead of failing the call.
- Rejected per-file: missing, directory, permission-denied, empty, binary (NUL sniff), and **image** files (use the built-in `read` for images — this tool is text-only).
- Shared byte budget (`maxTotalBytes`, default 50KB, hard max 200KB) allocated **max-min fair**, so small files complete and only oversized files get cut. Per-file line cap 2000 (same as built-in `read`). Max 50 files per call.
- Truncation is always reported with an explicit continuation offset; a single line too large to fit reports a `bash sed` fallback instead of a looping offset.
- Duplicate requests are collapsed by **real** path + range (symlink and its target count as one file).
- Non-UTF-8 text is reported, not mojibake: UTF-16/UTF-32 BOMs and >2% U+FFFD decodes become error entries.
- Non-regular files (FIFO, socket, device) are refused instead of blocking; files over 16MB are refused with a `head -c`/`grep` suggestion instead of being loaded into memory.
- Cancellation: an aborted `signal` (before or during the reads) throws instead of returning a partial result.
- The emitted text is hard-clipped to `maxTotalBytes` as a final safety net (`details.clipped` says so).

## Testing

```bash
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --skipLibCheck --esModuleInterop --allowImportingTsExtensions index.ts
node smoke-test.mjs '{"files":[{"path":"README.md","limit":5}]}' [cwd]
node verify-risks.mjs   # 38 assertions: symlinks, encodings, budget bounds, abort, TUI render, arg shapes, FIFO/huge files
```
