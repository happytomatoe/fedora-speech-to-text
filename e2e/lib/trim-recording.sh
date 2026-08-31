#!/usr/bin/env bash
# Trim the pre-activity idle head from an e2e recording.
# Usage: trim-recording.sh <video-path>
# Uses freezedetect to find the first freeze_end (= activity start), keeps
# 1s of context before it, re-encodes with the codec recorded by startRecording.
set -euo pipefail

VIDEO="${1:?usage: trim-recording.sh <video-path>}"
KEEP_BEFORE=1.0
FREEZE_NOISE="n=0.001:d=0.5"

if [[ ! -f "$VIDEO" ]]; then
  echo "  [trim] file not found: $VIDEO" >&2
  exit 1
fi

CODEC="${TRIM_CODEC:-libx264}"
T0=$(date +%s%3N)

LOG=$(ffmpeg -i "$VIDEO" -vf "freezedetect=$FREEZE_NOISE" -an -f null - 2>&1 | grep freeze || true)
END=$(echo "$LOG" | grep -m1 freeze_end | grep -oP 'freeze_end: \K[0-9.]+')

if [[ -z "$END" ]]; then
  echo "  [trim] no freeze head detected, skipping"
  exit 0
fi

SS=$(python3 -c "print(max(0, $END - $KEEP_BEFORE))")
ffmpeg -v error -ss "$SS" -i "$VIDEO" -c:v "$CODEC" -preset veryfast -pix_fmt yuv420p -an -y "$VIDEO.trimmed.mp4" || exit 1
mv "$VIDEO.trimmed.mp4" "$VIDEO"
echo "  [trim] cut idle head at ${SS}s, done in $(( $(date +%s%3N) - T0 ))ms (ran parallel with VM shutdown)"
