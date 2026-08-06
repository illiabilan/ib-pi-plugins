# code_viewer

Automatically syntax-highlights fenced code blocks in assistant responses
that the model left **without a language tag** (```` ``` ```` instead of
```` ```python ````).

## Why

Pi's built-in Markdown renderer already syntax-highlights fenced code blocks
when the fence names a recognized language — it calls `highlightCode()`
under the hood. But it deliberately does **not** try to guess the language
when the fence is untagged, because generic statistical auto-detection
(`highlight.js`'s `highlightAuto`) is unreliable on short snippets and can
misidentify prose or ASCII diagrams as a random language. LLMs frequently
omit the language tag, so in practice a lot of real code renders as flat,
uncolored text (see the screenshot that motivated this extension).

## How

On every finalized assistant message (`message_end`), this extension scans
for fenced code blocks with **no** language token and runs them through a
small set of hand-written, high-precision deterministic sniffers (JSON via
`JSON.parse`, shebang lines, SQL keyword shape, `package main`, `fn main()`,
etc. — see `detect.ts`). If — and only if — a sniffer confidently recognizes
the language, the fence header is rewritten to include it
(```` ``` ```` → ```` ```python ````). Pi's existing renderer then highlights
it exactly as if the model had tagged it correctly itself.

Design principles, enforced by the test suite in `test/`:

- **Never touch an already-tagged fence.** Only a genuinely empty language
  token is a candidate — an author-provided tag (even one pi doesn't
  recognize, e.g. ` ```text `) is always left alone.
- **Precision over recall.** An ambiguous or short block is left untouched
  (same as today's baseline) rather than guessed at. A wrong highlight is
  worse than no highlight — it actively misleads. This is why a generic
  `highlight.js` auto-detect pass is deliberately *not* used (see the
  comment at the top of `detect.ts` for the numbers that ruled it out).
- **A numbered prose/outline block never gets language-tagged**, even if a
  few of its lines happen to look like shell commands (this was a real bug
  found during validation against the exact ASCII-diagram screenshot that
  motivated this extension).

## Known limitations

- Only backtick fences (` ``` `) are handled, not `~~~` fences.
- Detection covers ~15 common languages (JS/TS, Python, bash, JSON, YAML,
  SQL, Go, Rust, Java, C#, C/C++, HTML, CSS, Dockerfile, Ruby-via-shebang).
  Anything else is left untagged (safe, no regression vs. baseline).
- Because the rewrite happens on `message_end`, a language-less block only
  gets colored once the assistant's turn finishes — it still renders plain
  while actively streaming.

## Testing

```bash
npx jiti test/run-corpus.mjs     # precision/recall over a curated corpus
npx jiti test/adversarial.mjs    # false-positive traps, incl. the real screenshot content
```
