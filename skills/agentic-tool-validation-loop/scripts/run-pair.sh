#!/usr/bin/env bash
# run-pair.sh — run the same prompt twice against `pi`: once with all tools
# available, once with a specific tool excluded. This is the "controlled
# comparison" step of the validation loop, automated.
#
# Usage:
#   run-pair.sh <tool-name-to-exclude> <output-dir> <prompt> [extra pi args...]
#
# Example:
#   run-pair.sh code_search /tmp/bench1 "Find where handleEvent is defined" --provider anthropic
#
# Writes:
#   <output-dir>/with.jsonl     — run with the tool available
#   <output-dir>/without.jsonl  — run with --exclude-tools <tool-name>
#
# Then inspect with analyze-trace.js or compare.js.

set -euo pipefail

if [ $# -lt 3 ]; then
  echo "Usage: $0 <tool-name-to-exclude> <output-dir> <prompt> [extra pi args...]" >&2
  exit 1
fi

TOOL_NAME="$1"
OUT_DIR="$2"
PROMPT="$3"
shift 3

mkdir -p "$OUT_DIR"

echo "==> Running WITH $TOOL_NAME available..."
pi --mode json "$@" -p "$PROMPT" > "$OUT_DIR/with.jsonl" 2>&1 || true

echo "==> Running WITHOUT $TOOL_NAME (--exclude-tools)..."
pi --mode json --exclude-tools "$TOOL_NAME" "$@" -p "$PROMPT" > "$OUT_DIR/without.jsonl" 2>&1 || true

echo ""
echo "Logs written:"
echo "  $OUT_DIR/with.jsonl"
echo "  $OUT_DIR/without.jsonl"
echo ""
echo "Next steps:"
echo "  node $(dirname "$0")/analyze-trace.js $OUT_DIR/with.jsonl"
echo "  node $(dirname "$0")/analyze-trace.js $OUT_DIR/without.jsonl"
echo "  node $(dirname "$0")/compare.js $OUT_DIR/with.jsonl $OUT_DIR/without.jsonl"
