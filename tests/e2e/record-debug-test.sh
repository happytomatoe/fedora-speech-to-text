#!/bin/bash
# Records a terminal session of the debug mode e2e test.
# Usage: ./record-debug-test.sh
#
# Produces: tests/e2e-output/debug-test-recording.{mp4,cast}

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
OUTPUT_DIR="${SCRIPT_DIR}/../e2e-output"

cd "${PROJECT_ROOT}"

# Check required tools
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg is required for recording"
  echo "Install: sudo dnf install ffmpeg"
  exit 1
fi

if ! command -v asciinema &>/dev/null; then
  echo "ERROR: asciinema is required for terminal recording"
  echo "Install: sudo dnf install asciinema"
  exit 1
fi

# Check DEEPGRAM_API_KEY
if [[ -z "${DEEPGRAM_API_KEY}" ]]; then
  echo "ERROR: DEEPGRAM_API_KEY environment variable is not set"
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

CAST_FILE="${OUTPUT_DIR}/debug-test-recording.cast"
MP4_FILE="${OUTPUT_DIR}/debug-test-recording.mp4"

echo "Starting terminal recording..."
echo "Recording will be saved to: ${CAST_FILE}"
echo ""

# Start asciinema recording
rm -f "${CAST_FILE}"
asciinema rec --command "bash ${SCRIPT_DIR}/test-deepgram.sh" "${CAST_FILE}" || true

# Convert to MP4 if possible
if command -v agg &>/dev/null; then
  echo ""
  echo "Converting to MP4..."
  agg "${CAST_FILE}" "${MP4_FILE}" --font-size 14 || true
  if [[ -f "${MP4_FILE}" ]]; then
    echo "✅ MP4 recording saved: ${MP4_FILE}"
    ls -lh "${MP4_FILE}"
  fi
fi

echo ""
echo "✅ Terminal recording saved: ${CAST_FILE}"
ls -lh "${CAST_FILE}"

echo ""
echo "To play the recording:"
echo "  asciinema play ${CAST_FILE}"
