#!/bin/bash
# Searches for a target image on the screen capture and prints coordinates.
# Usage: ./find-target.sh [-s scale_factor] [-f fuzziness] screen.png target.png
#
# Two-pass approach: fast downscale search → full-res refinement.

SCALE_FACTOR=4
FUZZINESS=0.01

while getopts "s:f:h" opt; do
  case $opt in
    s) SCALE_FACTOR="${OPTARG}";;
    f) FUZZINESS="${OPTARG}";;
    h) echo "Usage: $0 [-s scale] [-f fuzziness] screen.png target.png"; exit 0;;
    *) exit 1;;
  esac
done

shift $((OPTIND-1))
SCREEN=$1
TARGET=$2

if [[ -z "${SCREEN}" || -z "${TARGET}" ]]; then
  echo "Usage: $0 screen.png target.png" >&2
  exit 1
fi

WORK_DIR=$(mktemp -d)
trap "rm -r ${WORK_DIR}" EXIT

# Scale down for fast initial search
convert "${SCREEN}" -resize $((100 / SCALE_FACTOR))% "${WORK_DIR}/screen_small.png"
convert "${TARGET}" -resize $((100 / SCALE_FACTOR))% "${WORK_DIR}/target_small.png"

# Find approximate location
RESULT=$(compare -metric MSE -subimage-search \
  "${WORK_DIR}/screen_small.png" "${WORK_DIR}/target_small.png" "${WORK_DIR}/out.png" 2>&1)

if [[ $RESULT == *"error"* ]] || [[ $RESULT == *"no such"* ]]; then
  echo "Failed to find target: ${RESULT}" >&2
  exit 1
fi

# Extract and scale coordinates back
CROP_X=$(echo "${RESULT}" | awk -F[,\ ] '{print $4}')
CROP_Y=$(echo "${RESULT}" | awk -F[,\ ] '{print $5}')
CROP_X=$((CROP_X * SCALE_FACTOR - SCALE_FACTOR))
CROP_Y=$((CROP_Y * SCALE_FACTOR - SCALE_FACTOR))
CROP_X=$((CROP_X < 0 ? 0 : CROP_X))
CROP_Y=$((CROP_Y < 0 ? 0 : CROP_Y))

# Get target dimensions and crop region
TARGET_WIDTH=$(identify -format "%[fx:w]" "${TARGET}")
TARGET_HEIGHT=$(identify -format "%[fx:h]" "${TARGET}")
CROP_WIDTH=$((TARGET_WIDTH + 2*SCALE_FACTOR))
CROP_HEIGHT=$((TARGET_HEIGHT + 2*SCALE_FACTOR))

convert "${SCREEN}" -crop ${CROP_WIDTH}x${CROP_HEIGHT}+${CROP_X}+${CROP_Y} \
  +repage "${WORK_DIR}/screen_cropped.png"

# Full resolution search for precise location
RESULT=$(compare -metric MSE -dissimilarity-threshold "${FUZZINESS}" -subimage-search \
  "${WORK_DIR}/screen_cropped.png" "${TARGET}" "${WORK_DIR}/out.png" 2>&1)

if [[ $RESULT == *"error"* ]] || [[ $RESULT == *"no such"* ]]; then
  echo "Target not found with sufficient precision" >&2
  exit 1
fi

POS_X=$(echo "${RESULT}" | awk -F[,\ ] '{print $4}')
POS_Y=$(echo "${RESULT}" | awk -F[,\ ] '{print $5}')
POS_X=$((POS_X + CROP_X))
POS_Y=$((POS_Y + CROP_Y))

echo "${POS_X} ${POS_Y}"
