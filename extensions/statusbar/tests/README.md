# statusbar tests

```bash
bash tests/run.sh            # everything (git fixtures first — later suites reuse them)
bash tests/run.sh --show     # plus every rendered sample line
```

No test framework, no dependencies: plain Node (`>= 22.6`, imports `../index.ts` directly
via native type-stripping) plus the pi packages already in `node_modules` as dev deps.

| Suite | What it proves |
|---|---|
| `git.test.mjs` | `runGitStatus` + `parsePorcelainV2` against **real** repositories: dirty/clean/renamed/conflicted, detached HEAD, no-commit repo, emoji and 200-char branch names, non-repo and missing cwd → `null`, plus hand-written porcelain-v2 parser cases. Builds the fixtures in `/tmp/sbar-git`. |
| `render.test.mjs` | 22 snapshot cases × 17 widths (0…400): visible width never exceeds the given width, ≤ 2 lines, no control-character or unterminated-ANSI leakage, segment presence shrinks monotonically and follows `DROP_ORDER`, every segment can be switched off, absurd widths (NaN/∞/negative/fractional) are safe. Adversarial: emoji + combining marks + CJK, 200-char branch, 200-char dir, 500-char model id, ANSI-injection attempts in branch/dir/status text, 10 000 statuses, unknown context window. |
| `io.test.mjs` | `render()` does **no I/O**. `index.ts` is copied with only its import specifiers rewritten to throwing `fs` / `child_process` stubs (the diff is asserted to be import lines only); 7 200 renders record zero stub calls. Two controls make the test non-vacuous: the untouched module reads real git data while the stubbed copy provably hits the stub, and the fs stub is proven reachable via the extension factory (which must still not crash). |
| `lifecycle.test.mjs` | Mount on `session_start`, exactly one branch subscription, git counters refreshed out of band, a mid-session file write picked up via `tool_execution_end`, `requestRender` coalescing (200 events → 2 renders), immediate branch-change feedback then reconciliation with git, 20 rapid `/statusbar` toggles with no subscription/interval leak, clean release on toggle-off and `session_shutdown`, inert post-shutdown events, detached HEAD end to end, git failure keeping the branch but dropping counters, print-mode no-op, and a runtime theme switch on the mounted component. |
| `theme.test.mjs` | Renders with pi's real `dark` and `light` themes: identical text, different theme-supplied colours, identical width; the context ramp resolves to three distinct theme colours. |
| `perf.test.mjs` | Head-to-head µs/frame against pi's built-in `FooterComponent` (10/500/5000 session entries) and the worst case (10 000 statuses at width 20). |

## TUI smoke (manual, needs `pi` on PATH)

```bash
python3 tests/pty-smoke.py /tmp/sbar-pty/capture.raw
node tests/analyze-pty.mjs /tmp/sbar-pty/capture.raw
```

Starts a real pi TUI on a pty (no prompt is sent, so no model call happens), captures what
the footer paints while resizing 100 → 80 → 60 → 40 → 20 → 10 → 100 columns, toggles
`/statusbar` off/on, does four rapid toggles, and opens/escapes `/statusbar segments`.
`analyze-pty.mjs` prints the footer paints per phase and counts error-looking output.

Verified this way: the bar mounts on startup with real model/branch/context data, the
status line paints on the line **above** the bar, toggling off restores pi's own footer
(`~/StudioProjects/pi-plugins (main)`) and back on re-mounts, and there is no error output.
Exact width assertions come from `render.test.mjs`, not from the capture — pi's
differential rendering makes byte-level width measurement of a capture unreliable.
