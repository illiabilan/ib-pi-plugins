#!/usr/bin/env bash
# Paired benchmark: same prompt, two identical fresh copies of a real fixture,
# one run WITH append_file/replace_in_file available and one WITHOUT (so the
# agent must fall back to bash/sed/python heredocs).
#
# Usage: bench.sh <case-name> <fixture-dir> "<prompt>" [extra pi args...]
set -o pipefail

EXT="/Users/illiabilan/StudioProjects/pi-plugins/extensions/file-write-plus/index.ts"
CASE="$1"; FIXTURE="$2"; PROMPT="$3"; shift 3
OUT="/tmp/fwp-bench/$CASE"
rm -rf "$OUT"; mkdir -p "$OUT"

for variant in with without; do
  rm -rf "$OUT/$variant"
  cp -R "$FIXTURE" "$OUT/$variant"
  EXTRA=()
  if [ "$variant" = "without" ]; then EXTRA=(--exclude-tools append_file,replace_in_file); fi
  echo "==> $variant"
  ( cd "$OUT/$variant" && pi -e "$EXT" --mode json "${EXTRA[@]}" "$@" -p "$PROMPT" ) \
    > "$OUT/$variant.jsonl" 2>&1
done

echo "logs: $OUT/with.jsonl $OUT/without.jsonl"
