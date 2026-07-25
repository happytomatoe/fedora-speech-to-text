#!/bin/bash
# Build the GNOME extension ZIP from the source tree.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
SRC_DIR="${PROJECT_ROOT}/gnome-ext"
EXT_DIR=$(mktemp -d)
OUT_ZIP="${PROJECT_ROOT}/tests/e2e/expected/voice-to-text@happytomatoe.com.shell-extension.zip"

trap "rm -rf ${EXT_DIR}" EXIT

# Ensure output directory exists
mkdir -p "$(dirname "${OUT_ZIP}")"
mkdir -p "${EXT_DIR}/schemas"

# Copy extension files (JS, JSON, CSS)
for f in "${SRC_DIR}"/*.js "${SRC_DIR}"/*.json "${SRC_DIR}"/*.css; do
  [ -f "$f" ] && cp "$f" "${EXT_DIR}/"
done

# Copy schema files
if ls "${SRC_DIR}"/schemas/* &>/dev/null; then
  cp "${SRC_DIR}"/schemas/* "${EXT_DIR}/schemas/"
fi

# Compile schemas
glib-compile-schemas "${EXT_DIR}/schemas"

# Create ZIP
cd "${EXT_DIR}"
zip -r "${OUT_ZIP}" . -x '*.git*'

echo "Extension ZIP created: ${OUT_ZIP}"
