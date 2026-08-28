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

## Boxed/no-fence rendering (narrow case only)

Pi's built-in `Markdown` component (`case "code"` in
`@earendil-works/pi-tui`'s `markdown.js`) *always* prints the literal
` ```lang ` / ` ``` ` fence lines and only supports one uniform background
for an entire rendered text block — there's no hook to give one fenced
block inside a normal assistant message its own background box the way the
`edit` tool's diff view does. This was confirmed by reading `markdown.js`
and `docs/extensions.md`, not assumed.

The only building blocks extensions get for "boxed, no visible fence"
rendering are `pi.appendEntry()` + `pi.registerEntryRenderer()` (a `Box`
with `theme.bg("customMessageBg", ...)`). But those custom entries are
siblings of the whole message in pi's flat transcript entry list — they can
never be spliced *inside* one message's content — and, empirically
verified against a live session trace, `pi.appendEntry()` called during a
`message_end` handler is persisted **before** the assistant message itself
(extension handlers run and complete before `sessionManager.appendMessage()`
is called). Deferring the call to fix the ordering was also tried and
crashes with "stale extension ctx" once the turn settles.

Net effect: this technique is only order-safe when a message's entire
content is *nothing but* one fenced code block. That specific case is
handled — the fence is stripped from the message (which then renders as an
empty/invisible bubble) and an equivalent boxed entry with syntax-colored
lines and no backtick fences is appended instead, landing in exactly the
right visual spot since there's no prose left to be displaced. Any message
that mixes prose and code (the common "here's the code: ``` ... ``` let me
know if..." pattern) is deliberately left on the conservative language-tag
path below — boxing it would visually reorder the code above/below prose
it didn't belong next to.

## Known limitations

- Only backtick fences (` ``` `) are handled, not `~~~` fences.
- Detection covers ~15 common languages (JS/TS, Python, bash, JSON, YAML,
  SQL, Go, Rust, Java, C#, C/C++, HTML, CSS, Dockerfile, Ruby-via-shebang).
  Anything else is left untagged (safe, no regression vs. baseline).
- Because the rewrite happens on `message_end`, a language-less block only
  gets colored once the assistant's turn finishes — it still renders plain
  while actively streaming.
- The boxed/no-fence treatment only applies when a message's entire content
  is a single fenced code block (see above). Messages mixing prose and code
  keep the fence visible and just get syntax-colored — this is intentional,
  not a bug: there is no supported way to interleave a boxed block
  correctly inside a message that has other text around it.

## Testing

```bash
npx jiti test/run-corpus.mjs     # precision/recall over a curated corpus
npx jiti test/adversarial.mjs    # false-positive traps, incl. the real screenshot content
```
