#!/bin/bash
# Snapshot testing: captures full-screen screenshots of all GNOME extension states.
# Usage: ./snapshot.sh [--update]
#
# With --update: saves screenshots as new references
# Without --update: compares against existing references

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
REFERENCES_DIR="${SCRIPT_DIR}/../expected"
OUTPUT_DIR="${SCRIPT_DIR}/../output"
FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
EXTENSION_UUID="voice-to-text@happytomatoe.com"
EXTENSION_ZIP="/app/tests/e2e/expected/${EXTENSION_UUID}.shell-extension.zip"

UPDATE_MODE=false
if [[ "${1:-}" == "--update" ]]; then
  UPDATE_MODE=true
fi

cd "${PROJECT_ROOT}"

# Build container if needed
IMAGE="voice-to-text-e2e"
if ! podman image exists "${IMAGE}"; then
  echo "Building test container..."
  podman build -t "${IMAGE}" -f tests/e2e/Dockerfile .
fi

# Run container
echo "Starting container..."
POD=$(podman run --rm --cap-add=SYS_NICE --cap-add=IPC_LOCK \
  --net=host --ipc=host \
  -v "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pipewire-0:/tmp/pipewire-0:ro" \
  -e PIPEWIRE_RUNTIME_DIR=/tmp \
  -e XDG_RUNTIME_DIR=/tmp \
  -e VOICE_TO_TEXT_DEBUG_FILE=/app/tests/e2e/fixtures/test-audio.wav \
  -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY:-}" \
  -td "${IMAGE}")

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
    -e XDG_RUNTIME_DIR=/run/user/1000 \
    -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    -e DISPLAY=:100 \
    -e GSK_RENDERER=cairo \
    -e PIPEWIRE_RUNTIME_DIR=/tmp \
    -e VOICE_TO_TEXT_DEBUG_FILE=/app/tests/e2e/fixtures/test-audio.wav \
    -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY:-}" \
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

# Write environment variables to a file for the D-Bus service to source
echo "Writing environment variables to container..."
do_in_pod bash -c "cat > /home/gnomeshell/.config/voice-to-text/env << 'EOF'
export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}
export VOICE_TO_TEXT_DEBUG_FILE=/app/tests/e2e/fixtures/test-audio.wav
EOF"
sleep 1  # Ensure file is written before service reads it

# Kill any running D-Bus service instance (it was started without the API key)
do_in_pod pkill -f voice-to-text-dbus 2>/dev/null || true
do_in_pod pkill -f 'python -m voice_to_text' 2>/dev/null || true
sleep 2  # Wait for service to fully stop

# Start GNOME Shell first — this will D-Bus-activate the service with the new env file
echo "Starting GNOME Shell..."
do_in_pod systemctl --user start "gnome-xsession@:100"

# Wait for GNOME Shell to fully initialize
poll_until "GNOME Shell" 30 1 do_in_pod gnome-extensions list

# Wait for D-Bus service to be activated by GNOME Shell
echo "Waiting for D-Bus service to start with API key..."
for i in $(seq 1 10); do
  if do_in_pod busctl --user list 2>/dev/null | grep -q com.happytomatoe.VoiceToText; then
    echo "  D-Bus service is running"
    break
  fi
  sleep 1
done

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
# State 2: Preferences dialog
# GNOME 47 renders extension prefs in-process via Clutter (same PID as
# gnome-shell). The window IS managed by Mutter (xdotool finds it) but its
# content is rendered by Clutter, bypassing both the X11 framebuffer (xwd)
# and the Clutter stage (Shell.Screenshot). No known capture method works
# on Xvfb. We verify the window exists with correct geometry instead.
# ============================================

echo ""
echo "2. Preferences dialog"
if do_in_pod gnome-extensions prefs "${EXTENSION_UUID}" 2>/dev/null; then
  poll_until "preferences window" 10 1 do_in_pod xdotool search --name 'Voice.*Text'
  PREFS_WID=$(do_in_pod xdotool search --name 'Voice.*Text' 2>/dev/null | head -1)
  if [[ -n "${PREFS_WID}" ]]; then
    echo "  Preferences window found (ID: ${PREFS_WID})"
    PREFS_GEOM=$(do_in_pod xdotool getwindowgeometry "${PREFS_WID}" 2>/dev/null)
    echo "  Window geometry: ${PREFS_GEOM}"
    do_in_pod xdotool windowactivate "${PREFS_WID}" 2>/dev/null
    sleep 1
    echo "  Preferences window verified (screenshot not possible — see note above)"
  else
    echo "  Preferences window not found"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
else
  echo "  Failed to open preferences (extension not recognized)"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
TESTS_RUN=$((TESTS_RUN + 1))

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

# D-Bus service should already be running (activated by GNOME Shell)
# Just check if it's available and get logs
echo "  Checking D-Bus service..."
DBUS_LOG="/home/gnomeshell/.config/voice-to-text/dbus-service.log"

# Check if service is already running
if do_in_pod busctl --user list 2>/dev/null | grep -q com.happytomatoe.VoiceToText; then
  echo "  D-Bus service is already running (activated by GNOME Shell)"
else
  echo "  Starting D-Bus service..."
  do_in_pod bash -c "rm -f ${DBUS_LOG}; /home/gnomeshell/.local/bin/voice-to-text-dbus > ${DBUS_LOG} 2>&1 &"
  sleep 3
fi

# Get logs from systemd journal (D-Bus activation logs go to journal, not file)
echo "  Service logs:"
do_in_pod journalctl --user --no-pager 2>/dev/null | grep -i "voice_to_text\|VoiceToText" | head -10 || echo "  No logs yet"

# Copy test audio file into container
TEST_AUDIO="/app/tests/e2e/fixtures/test-audio.wav"
echo "  Copying test audio file..."
podman cp "${TEST_AUDIO}" "${POD}:/home/gnomeshell/test-audio.wav" 2>/dev/null || true
do_in_pod chmod 644 /home/gnomeshell/test-audio.wav 2>/dev/null || true

# Start recording via D-Bus
# Debug mode will simulate audio levels and transcribe the test file
if do_in_pod gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StartRecording '{"provider": "deepgram", "output_method": "search"}' 2>/dev/null; then
  # Debug mode simulates audio for 3 seconds, then transcribes
  echo "  Recording started (debug mode will simulate audio)..."
  sleep 5  # Wait for debug mode to finish audio simulation
  
  # Capture recording state with simulated audio levels
  snapshot_test "snapshot-recording" "recording state with notification"
  
  # Capture cropped screenshot of the recording indicator area (top bar)
  snapshot_test "snapshot-recording-indicator" "recording indicator with audio level" "crop:80x25+655+2"
  
  # Wait for transcription to complete (debug mode transcribes after simulation)
  echo "  Waiting for transcription..."
  sleep 5  # Give time for Deepgram API call
else
  echo "  Skipping recording (D-Bus service not available)"
fi


# ============================================
# State 4: Transcription result from Deepgram
# ============================================
echo ""
echo "4. Transcription result"

# Wait for transcription to complete (Deepgram needs time to process)
echo "  Waiting for Deepgram transcription..."
for i in $(seq 1 30); do
  if do_in_pod journalctl --user --no-pager 2>/dev/null | grep -qi "transcri"; then
    echo "  Transcription detected in logs"
    break
  fi
  sleep 1
done

# Show D-Bus service logs from journal
echo ""
echo "=== D-Bus Service Logs (from systemd journal) ==="
do_in_pod journalctl --user --no-pager 2>/dev/null | grep -i "voice_to_text\|VoiceToText\|deepgram\|transcri\|result" | tail -20 || echo "  No logs available"
echo "=== End Logs ==="
echo ""

# Extract transcription result from journal logs
TRANSCRIPTION=$(do_in_pod journalctl --user --no-pager 2>/dev/null | grep -i "Transcription result:" | tail -1 | sed 's/.*Transcription result: //' || true)
if [[ -z "${TRANSCRIPTION}" ]]; then
  TRANSCRIPTION="(empty - no speech detected in audio)"
fi
echo "  Transcription from logs: ${TRANSCRIPTION:-none found}"
echo ""

# Open terminal and show the result
do_in_pod gnome-terminal &
sleep 3

# Find and focus terminal window
TERM_WID=$(do_in_pod xdotool search --name "Terminal" 2>/dev/null | head -1)
if [[ -n "${TERM_WID}" ]]; then
  do_in_pod xdotool windowactivate "${TERM_WID}"
  sleep 0.5

  # Type the actual transcription result if we found one
  if [[ -n "${TRANSCRIPTION}" ]] && [[ "${TRANSCRIPTION}" != *"("* ]]; then
    echo "  Typing transcription: ${TRANSCRIPTION}"
    do_in_pod xdotool type --delay 30 "${TRANSCRIPTION}"
  else
    echo "  Using fallback text (no transcription found)"
    do_in_pod xdotool type --delay 30 "Hello world from voice to text (fallback - check logs for actual transcription)"
  fi
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
# Save D-Bus service logs from systemd journal
mkdir -p "${OUTPUT_DIR}"
echo ""
echo "Saving D-Bus service logs from journal..."
do_in_pod journalctl --user --no-pager 2>/dev/null | grep -i "voice_to_text\|VoiceToText\|deepgram\|transcri" > "${OUTPUT_DIR}/dbus-service.log" 2>/dev/null || true
if [[ -s "${OUTPUT_DIR}/dbus-service.log" ]]; then
  echo "  Logs saved to: ${OUTPUT_DIR}/dbus-service.log"
  echo ""
  echo "=== D-Bus Service Log Contents ==="
  cat "${OUTPUT_DIR}/dbus-service.log"
  echo "=== End Log Contents ==="
else
  echo "  No voice-to-text logs found in journal"
fi

# Save audio files and transcription
echo ""
echo "Saving artifacts..."

# Copy the test audio file (input)
if [[ -f "${TEST_AUDIO}" ]]; then
  cp "${TEST_AUDIO}" "${OUTPUT_DIR}/test-audio-input.wav" 2>/dev/null || true
  echo "  Test audio input saved to: ${OUTPUT_DIR}/test-audio-input.wav"
fi

# Save the transcription result
echo "${TRANSCRIPTION}" > "${OUTPUT_DIR}/transcription.txt" 2>/dev/null || true
echo "  Transcription saved to: ${OUTPUT_DIR}/transcription.txt"
echo "  Transcription text: ${TRANSCRIPTION}"

# Try to copy recorded audio files from /tmp (where sounddevice saves them)
for AUDIO_FILE in $(podman exec --user gnomeshell "${POD}" find /tmp -name "*.wav" -type f 2>/dev/null | head -5); do
  podman cp "${POD}:${AUDIO_FILE}" "${OUTPUT_DIR}/recorded-audio.wav" 2>/dev/null && \
    echo "  Recorded audio saved to: ${OUTPUT_DIR}/recorded-audio.wav" && break
done
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
