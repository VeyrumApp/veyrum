#!/usr/bin/env bash
# Runs a replay to completion, resuming after the process is killed (for example by an
# out-of-memory killer on a shared machine). The rig skips commits already in results.jsonl and
# discards evidence recorded at a commit that was interrupted, so resuming is safe.
#   bench/replay.sh <corpus.json> [rig args...]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
for attempt in 1 2 3 4 5 6 7 8; do
  # A small heap keeps the orchestrator well below the test runs it drives.
  node --max-old-space-size=1024 "$here/rig/dist/main.js" replay "$@"
  code=$?
  (( code == 0 )) && exit 0
  # 137/143: killed by a signal (SIGKILL/SIGTERM); anything else is a real failure.
  (( code == 137 || code == 143 )) || exit "$code"
  echo "[replay.sh] killed (exit $code), resuming (attempt $((attempt + 1)))" >&2
  sleep 30
done
exit 1
