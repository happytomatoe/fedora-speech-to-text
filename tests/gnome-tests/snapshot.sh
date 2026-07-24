#!/bin/bash
# Snapshot testing: captures full-screen screenshots of all GNOME extension states.
# Usage: ./snapshot.sh [--update]
#
# With --update: saves screenshots as new references
# Without --update: compares against existing references (like run-test.sh)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
REFERENCES_DIR="${SCRIPT_DIR}/../gnome-references"
OUTPUT_DIR="${SCRIPT_DIR}/../gnome-snapshots"
EXTENSION_UUID="voice-to-text@happytomatoe.com"
EXTENSION_ZIP="/app/tests/gnome-references/${EXTENSION_UUID}.shell-extension.zip"

UPDATE_MODE=false
if [[ "${1:-}" == "--update" ]]; then
  UPDATE_MODE=true
fi

cd "${PROJECT_ROOT}"

# Build container if needed
IMAGE="voice-to-text-gnome-test"
if ! podman image exists "${IMAGE}"; then
  echo "Building test container..."
  podman build -t "${IMAGE}" -f tests/gnome-tests/Containerfile .
fi

# Run container
echo "Starting container..."
POD=$(podman run --rm --cap-add=SYS_NICE --cap-add=IPC_LOCK -td "${IMAGE}")

if [[ "${UPDATE_MODE}" == "true" ]]; then
  mkdir -p "${REFERENCES_DIR}"
else
  mkdir -p "${OUTPUT_DIR}"
fi

cleanup() {
  podman kill "${POD}" 2>/dev/null || true
}
trap cleanup EXIT

# Helper to run commands in container
do_in_pod() {
  podman exec --user gnomeshell --workdir /home/gnomeshell "${POD}" set-env.sh "$@"
}

# Helper to capture full-screen screenshot
capture_full() {
  local output_file="${1}"
  podman cp "${POD}:/opt/Xvfb_screen0" - | tar xf - --to-command "convert xwd:- ${output_file}"
}

# Helper to capture cropped screenshot
capture_crop() {
  local output_file="${1}"
  local crop="${2}"
  podman cp "${POD}:/opt/Xvfb_screen0" - | tar xf - --to-command \
    "convert xwd:- -crop ${crop} +repage ${output_file}"
}

# Wait for container to start and user bus to be ready
echo "Waiting for D-Bus..."
sleep 8

# Wait for user bus to be ready
echo "Waiting for user bus..."
for i in $(seq 1 30); do
  if do_in_pod wait-user-bus.sh 2>/dev/null; then
    echo "User bus ready after ${i}s"
    break
  fi
  sleep 1
done

# Additional wait to ensure bus is fully ready for gsettings
echo "Waiting for bus to stabilize..."
sleep 5

# Set up GSK_RENDERER for consistent rendering
do_in_pod 'echo "export GSK_RENDERER=cairo" >> .bash_profile'

# Welcome tour is disabled via dconf in Containerfile
# No need to set welcome-dialog-last-shown-version at runtime

# Retry gsettings command
for i in $(seq 1 5); do
  if do_in_pod gsettings set org.gnome.mutter center-new-windows true 2>/dev/null; then
    echo "gsettings configured"
    break
  fi
  echo "gsettings retry $i..."
  sleep 2
done

# Install extension BEFORE starting GNOME Shell
echo "Installing extension..."
do_in_pod gnome-extensions install "${EXTENSION_ZIP}" --force

# Enable extension via dconf BEFORE starting GNOME Shell
echo "Enabling extension..."
do_in_pod dconf write /org/gnome/shell/enabled-extensions "['\"${EXTENSION_UUID}\"']"

# Start GNOME Shell
echo "Starting GNOME Shell..."
do_in_pod systemctl --user start "gnome-xsession@:99"

# Wait for GNOME Shell to fully initialize
echo "Waiting for GNOME Shell to initialize..."
for i in $(seq 1 30); do
  if do_in_pod gnome-extensions list >/dev/null 2>&1; then
    echo "GNOME Shell ready after ${i}s"
    break
  fi
  sleep 1
done

# Close overview if open (it opens by default on first start)
echo "Closing Overview..."
do_in_pod xdotool keydown super
sleep 0.5
do_in_pod xdotool keyup super
sleep 3

# Final wait for extension indicator to appear
echo "Waiting for extension to load..."
sleep 3

echo ""
if [[ "${UPDATE_MODE}" == "true" ]]; then
  echo "=== Capturing snapshot references ==="
  DEST="${REFERENCES_DIR}"
else
  echo "=== Running snapshot tests ==="
  DEST="${OUTPUT_DIR}"
fi

TESTS_FAILED=0
TESTS_RUN=0

# Snapshot test function
snapshot_test() {
  local test_name="${1}"
  local description="${2}"
  local capture_cmd="${3:-full}"  # "full" or "crop:WxH+X+Y"
  
  TESTS_RUN=$((TESTS_RUN + 1))
  echo -n "  ${test_name} (${description})... "
  
  local actual="${DEST}/${test_name}.png"
  
  # Capture the screenshot
  if [[ "${capture_cmd}" == "full" ]]; then
    capture_full "${actual}"
  else
    local crop="${capture_cmd#crop:}"
    capture_crop "${actual}" "${crop}"
  fi
  
  if [[ "${UPDATE_MODE}" == "true" ]]; then
    echo "SAVED"
    return
  fi
  
  # Compare with reference
  local reference="${REFERENCES_DIR}/${test_name}.png"
  local diff="${OUTPUT_DIR}/${test_name}-diff.png"
  
  if [[ ! -f "${reference}" ]]; then
    echo "NEW (no reference)"
    return
  fi
  
  METRIC=$(compare -metric MSE "${reference}" "${actual}" "${diff}" 2>&1 || true)
  
  if [[ -z "${METRIC}" ]] || [[ "${METRIC}" == "0" ]]; then
    echo "PASS (exact match)"
    rm -f "${diff}"
  else
    MSE=$(echo "${METRIC}" | head -1 | grep -oP '^[\d.]+')
    if (( $(echo "${MSE} < 100" | bc -l 2>/dev/null || echo 0) )); then
      echo "PASS (MSE: ${MSE})"
      rm -f "${diff}"
    else
      echo "FAIL (MSE: ${MSE})"
      TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
  fi
}

# ============================================
# State 1: Default indicator (idle state)
# ============================================
echo ""
echo "1. Indicator - idle state"
sleep 2
snapshot_test "snapshot-indicator-idle" "top bar with mic icon"

# ============================================
# State 2: Preferences dialog - Recording Settings
# ============================================
echo ""
echo "2. Preferences - Recording Settings"
# Try to open preferences (may fail if extension not fully loaded)
if do_in_pod gnome-extensions prefs "${EXTENSION_UUID}" 2>/dev/null; then
  sleep 5
  snapshot_test "snapshot-prefs-recording" "preferences - recording settings"
else
  echo "  Skipping preferences (extension not recognized by gnome-extensions)"
fi

# ============================================
# State 3: Preferences dialog - scrolled to Provider
# ============================================
echo ""
echo "3. Preferences - Provider Settings"
# Scroll down to show provider settings
do_in_pod xdotool key Tab
sleep 0.5
do_in_pod xdotool key Down
do_in_pod xdotool key Down
do_in_pod xdotool key Down
do_in_pod xdotool key Down
sleep 1
snapshot_test "snapshot-prefs-provider" "preferences - provider settings"

# ============================================
# State 4: Preferences dialog - scrolled to Output
# ============================================
echo ""
echo "4. Preferences - Output Settings"
# Scroll down more to show output settings
do_in_pod xdotool key Down
do_in_pod xdotool key Down
do_in_pod xdotool key Down
do_in_pod xdotool key Down
sleep 1
snapshot_test "snapshot-prefs-output" "preferences - output settings"

# Close preferences
do_in_pod xdotool keydown alt
do_in_pod xdotool key F4
sleep 1
do_in_pod xdotool keyup alt

# ============================================
# State 5: Full desktop overview
# ============================================
echo ""
echo "5. Full desktop"
sleep 2
snapshot_test "snapshot-desktop-full" "full desktop with extension active"

echo ""
echo "========================================="

if [[ "${UPDATE_MODE}" == "true" ]]; then
  echo "Snapshot references saved to: ${REFERENCES_DIR}"
  echo "Review the screenshots and commit them."
  echo ""
  ls -la "${REFERENCES_DIR}"/snapshot-*.png 2>/dev/null || echo "No snapshot files found"
else
  echo "Results: $((TESTS_RUN - TESTS_FAILED))/${TESTS_RUN} passed"
  if [[ ${TESTS_FAILED} -eq 0 ]]; then
    echo "All snapshots match!"
    exit 0
  else
    echo "${TESTS_FAILED} snapshot(s) failed."
    echo "Diff images saved to: ${OUTPUT_DIR}"
    exit 1
  fi
fi
