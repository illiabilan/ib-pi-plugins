#!/bin/bash
# sound-notify test suite.
#   bash tests/run.sh          unit tests only (fast, no model calls)
#   bash tests/run.sh --all    unit tests + both real-pi pty suites (needs credentials)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
fail=0

echo "== unit =="
node --test "$HERE" || fail=1

if [ "${1:-}" = "--all" ]; then
	echo "== pty: ask/done/mute/test (real pi TUI) =="
	python3 "$HERE/pty-ask.py" "${TMPDIR:-/tmp}/sn-pty-ask" || fail=1
	echo "== pty: reload / Esc-abort / mid-stream follow-up =="
	python3 "$HERE/pty-adversarial.py" "${TMPDIR:-/tmp}/sn-pty-adv" || fail=1
fi

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
