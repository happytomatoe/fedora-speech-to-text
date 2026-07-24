#!/bin/bash
# Snapshot testing: captures full-screen screenshots of all GNOME extension states.
# Usage: ./snapshot.sh [--update]
#
# With --update: saves screenshots as new references
# Without --update: compares against existing references

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
REFERENCES_DIR="${SCRIPT_DIR}/../gnome-references"
OUTPUT_DIR="${SCRIPT_DIR}/../gnome-output"
EXTENSION_UUID="voice-to-text@happytomatoe.com"
EXTENSION_ZIP="/app/tests/gnome-references/${EXTENSION_UUID}.shell-extension.zip"

UPDATE_MODE=false
if [[ "${1:-}" == "--update" ]]; then
  UPDATE_MODE=true
fi

cd "${PROJECT_ROOT}"

# Build container if needed
IMAGE="voice-to-text-e2e"
if ! podman image exists "${IMAGE}"; then
  echo "Building test container..."
  podman build -t "${IMAGE}" -f tests/e2e/Containerfile .
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
# Bypass set-env.sh to avoid eval quoting issues with special chars like @
do_in_pod() {
  podman exec --user gnomeshell --workdir /home/gnomeshell \
    -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    -e DISPLAY=:99 \
    -e GSK_RENDERER=cairo \
    -e PATH=/app-venv/bin:/usr/local/bin:/usr/bin:/bin \
    "${POD}" "$@"
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

# Helper to poll until condition is true
poll_until() {
  local desc="${1}"
  local timeout="${2:-30}"
  local interval="${3:-1}"
  shift 3
  
  echo -n "Waiting for ${desc}..."
  for i in $(seq 1 "$timeout"); do
    if "$@" >/dev/null 2>&1; then
      echo " ready (${i}s)"
      return 0
    fi
    sleep "$interval"
  done
  echo " TIMEOUT after ${timeout}s"
  return 1
}

# Wait for user bus (skip wait-user-bus.sh which fails on degraded systemd)
# Use direct podman exec (not do_in_pod) to avoid quoting issues with set-env.sh
echo "Waiting for user bus..."
for i in $(seq 1 60); do
  if podman exec --user gnomeshell "${POD}" bash -c 'test -S /run/user/1000/bus' 2>/dev/null; then
    echo " ready (${i}s)"
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo " TIMEOUT after 60s"
    exit 1
  fi
  sleep 1
done

# GSK_RENDERER=cairo is set via -e in do_in_pod

# Welcome tour is disabled via dconf in Containerfile

# Configure gsettings
echo "Configuring gsettings..."
poll_until "gsettings" 10 2 do_in_pod gsettings set org.gnome.mutter center-new-windows true

# Install extension BEFORE starting GNOME Shell
echo "Installing extension..."
do_in_pod gnome-extensions install "${EXTENSION_ZIP}" --force

# Enable extension via dconf BEFORE starting GNOME Shell
echo "Enabling extension..."
do_in_pod dconf write /org/gnome/shell/enabled-extensions "['${EXTENSION_UUID}']"

# Start GNOME Shell
echo "Starting GNOME Shell..."
do_in_pod systemctl --user start "gnome-xsession@:99"

# Wait for GNOME Shell to fully initialize
poll_until "GNOME Shell" 30 1 do_in_pod gnome-extensions list

# Close overview if open (it opens by default on first start)
echo "Closing Overview..."
do_in_pod xdotool keydown super
sleep 0.5
do_in_pod xdotool keyup super
poll_until "extension indicator" 10 1 do_in_pod xdotool mousemove 695 12

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
# State 1: Desktop with extension indicator
# ============================================
echo ""
echo "1. Desktop with extension indicator"
snapshot_test "snapshot-desktop-indicator" "desktop with mic icon in top bar"

# Dismiss any notifications to ensure consistent snapshots
echo "  Dismissing notifications..."
for i in 1 2 3; do
  do_in_pod xdotool key Escape
  sleep 0.3
done
sleep 1

# ============================================
# State 2: Preferences dialog - full scroll
# ============================================
echo ""
echo "2. Preferences dialog"
if do_in_pod gnome-extensions prefs "${EXTENSION_UUID}" 2>/dev/null; then
  poll_until "preferences window" 10 1 do_in_pod xdotool search --name 'Voice.*Text'
  # Focus the preferences window and wait for full render
  PREFS_WID=$(do_in_pod xdotool search --name 'Voice.*Text' 2>/dev/null | head -1)
  if [[ -n "${PREFS_WID}" ]]; then
    do_in_pod xdotool windowactivate "${PREFS_WID}"
  fi
  sleep 3
  snapshot_test "snapshot-prefs-top" "preferences - top of settings"
  
  # Scroll through ALL settings to capture full dialog
  for i in $(seq 1 20); do
    do_in_pod xdotool key Down
    sleep 0.1
  done
  snapshot_test "snapshot-prefs-bottom" "preferences - bottom of settings"
  
  # Scroll to the very end for the last preferences screenshot
  for i in $(seq 1 10); do
    do_in_pod xdotool key Down
    sleep 0.1
  done
  snapshot_test "snapshot-prefs-end" "preferences - very end of settings"
else
  echo "  Skipping preferences (extension not recognized)"
fi

# Close preferences
do_in_pod xdotool keydown alt
do_in_pod xdotool key F4
sleep 0.5
do_in_pod xdotool keyup alt

# ============================================
# State 3: Recording state (audio level visible)
# ============================================
echo ""
echo "3. Recording state"

# Start D-Bus service in background if not already running
echo "  Starting D-Bus service..."
do_in_pod bash -c '/home/gnomeshell/.local/bin/voice-to-text-dbus &'
sleep 2

# Start recording via D-Bus
if do_in_pod gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StartRecording '{"provider": "deepgram", "output_method": "search"}' 2>/dev/null; then
  # Wait for notification to appear and recording to start
  sleep 2
  snapshot_test "snapshot-recording" "recording state with notification"
  
  # Capture cropped screenshot of the recording indicator area (top bar)
  # The microphone icon with audio level is in the top-left area
  snapshot_test "snapshot-recording-indicator" "recording indicator with audio level" "crop:100x30+0+0"
  # Stop recording (ignore errors - may have already failed)
  do_in_pod gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StopRecording 2>/dev/null || true
  sleep 1
else
  echo "  Skipping recording (D-Bus service not available)"
fi

# ============================================
# State 4: Transcription result typed into terminal
# ============================================
echo ""
echo "4. Transcription result"

# Open terminal (xdotool type needs a focused window)
do_in_pod gnome-terminal &
sleep 3

# Find and focus terminal window
TERM_WID=$(do_in_pod xdotool search --name "Terminal" 2>/dev/null | head -1)
if [[ -n "${TERM_WID}" ]]; then
  do_in_pod xdotool windowactivate "${TERM_WID}"
  sleep 0.5

  # Type transcription text
  do_in_pod xdotool type --delay 30 "Hello world from voice to text"
  sleep 2

  snapshot_test "snapshot-transcription" "transcription typed into terminal"

  # Close terminal
  do_in_pod xdotool windowclose "${TERM_WID}"
  sleep 0.5
else
  echo "  Skipping transcription (terminal window not found)"
fi

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
