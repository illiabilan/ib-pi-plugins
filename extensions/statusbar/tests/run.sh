#!/bin/bash
# Run the whole statusbar test suite. Order matters: git.test.mjs builds the /tmp/sbar-git
# fixtures that io.test.mjs and lifecycle.test.mjs use as real repositories.
#   bash tests/run.sh
set -u
cd "$(dirname "$0")/.." || exit 1
export FORCE_COLOR=3
fail=0
for t in git render regressions io lifecycle theme perf; do
  echo "=== $t ==="
  if ! node "tests/$t.test.mjs" "$@"; then
    fail=1
  fi
done
echo
if [ "$fail" -eq 0 ]; then
  echo "ALL SUITES PASSED"
else
  echo "SOME SUITES FAILED"
fi
echo "(TUI smoke, needs a real terminal-less pty: python3 tests/pty-smoke.py && node tests/analyze-pty.mjs /tmp/sbar-pty/capture.raw)"
exit "$fail"
