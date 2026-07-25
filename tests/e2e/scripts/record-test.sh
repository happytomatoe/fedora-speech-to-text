#!/bin/bash
# Records a video of the e2e test with debug mode.
# Usage: ./record-test.sh
#
# Produces: tests/e2e-output/e2e-test-recording.mp4

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
OUTPUT_DIR="${SCRIPT_DIR}/../e2e-output"
EXTENSION_UUID="voice-to-text@happytomatoe.com"
EXTENSION_ZIP="/app/tests/gnome-references/${EXTENSION_UUID}.shell-extension.zip"

cd "${PROJECT_ROOT}"

# Check required tools
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg is required for recording"
  echo "Install: sudo dnf install ffmpeg"
  exit 1
fi

# Check DEEPGRAM_API_KEY
if [[ -z "${DEEPGRAM_API_KEY}" ]]; then
  echo "ERROR: DEEPGRAM_API_KEY environment variable is not set"
  exit 1
fi

# Build container if needed
IMAGE="voice-to-text-e2e"
if ! podman image exists "${IMAGE}"; then
  echo "Building test container..."
  podman build -t "${IMAGE}" -f tests/e2e/Containerfile .
fi

mkdir -p "${OUTPUT_DIR}"

# Run container with debug mode
echo "Starting container with debug mode..."
POD=$(podman run --rm --cap-add=SYS_NICE --cap-add=IPC_LOCK \
  --net=host --ipc=host \
  -v "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pipewire-0:/tmp/pipewire-0:ro" \
  -e PIPEWIRE_RUNTIME_DIR=/tmp \
  -e XDG_RUNTIME_DIR=/tmp \
  -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY}" \
  -e VOICE_TO_TEXT_DEBUG_FILE="/home/gnomeshell/test-audio.wav" \
  -td "${IMAGE}")

cleanup() {
  # Stop recording if still running
  if [[ -n "${FFMPEG_PID:-}" ]] && kill -0 "${FFMPEG_PID}" 2>/dev/null; then
    kill "${FFMPEG_PID}" 2>/dev/null || true
    wait "${FFMPEG_PID}" 2>/dev/null || true
  fi
  podman kill "${POD}" 2>/dev/null || true
}
trap cleanup EXIT

# Helper to run commands in container
do_in_pod() {
  podman exec --user gnomeshell --workdir /home/gnomeshell \
    -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    -e DISPLAY=:99 \
    -e GSK_RENDERER=cairo \
    -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY}" \
    -e VOICE_TO_TEXT_DEBUG_FILE="/home/gnomeshell/test-audio.wav" \
    -e PATH=/app-venv/bin:/usr/local/bin:/usr/bin:/bin \
    "${POD}" "$@"
}

# Helper to capture full-screen screenshot
capture_full() {
  local output_file="${1}"
  podman cp "${POD}:/opt/Xvfb_screen0" - | tar xf - --to-command "convert xwd:- ${output_file}"
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

# Wait for user bus
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

# Configure gsettings
echo "Configuring gsettings..."
poll_until "gsettings" 10 2 do_in_pod gsettings set org.gnome.mutter center-new-windows true

# Install extension BEFORE starting GNOME Shell
echo "Installing extension..."
do_in_pod gnome-extensions install "${EXTENSION_ZIP}" --force

# Enable extension via dconf BEFORE starting GNOME Shell
echo "Enabling extension..."
do_in_pod dconf write /org/gnome/shell/enabled-extensions "['${EXTENSION_UUID}']"

# Write API key and debug file to env
echo "Writing API key and debug config to container..."
do_in_pod bash -c "echo 'export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}' > /home/gnomeshell/.config/voice-to-text/env && \
                   echo 'export VOICE_TO_TEXT_DEBUG_FILE=/home/gnomeshell/test-audio.wav' >> /home/gnomeshell/.config/voice-to-text/env"

# Copy test audio file
echo "Copying test audio file..."
podman cp tests/e2e/test-audio.wav "${POD}:/tmp/test-audio.wav"
# Move to final location as gnomeshell user
do_in_pod bash -c "cp /tmp/test-audio.wav /home/gnomeshell/test-audio.wav && chmod 644 /home/gnomeshell/test-audio.wav"
do_in_pod chmod 644 /home/gnomeshell/test-audio.wav

# Start GNOME Shell
echo "Starting GNOME Shell..."
do_in_pod systemctl --user start "gnome-xsession@:99"

# Wait for GNOME Shell to fully initialize
poll_until "GNOME Shell" 30 1 do_in_pod gnome-extensions list

# Close overview if open
echo "Closing Overview..."
do_in_pod xdotool keydown super
sleep 0.5
do_in_pod xdotool keyup super
sleep 2

# Start recording the screen
echo "Starting screen recording..."
RECORDING_FILE="${OUTPUT_DIR}/e2e-test-recording.mp4"

# Start ffmpeg to capture the Xvfb display
# We'll capture from the container's Xvfb screen
podman exec -d "${POD}" bash -c "
  # Wait for ffmpeg to be available
  while ! command -v ffmpeg &>/dev/null; do sleep 1; done
  
  # Record the screen for 30 seconds
  ffmpeg -y -f x11grab -video_size 800x600 -framerate 15 -i :99 \
    -c:v libx264 -preset ultrafast -crf 23 \
    -t 30 \
    /tmp/recording.mp4 2>/dev/null
" &
FFMPEG_LAUNCHER_PID=$!

# Wait a moment for ffmpeg to start
sleep 2

# Take initial screenshot
echo "Capturing initial state..."
capture_full "${OUTPUT_DIR}/01-initial-desktop.png"

# Show what we're about to do
echo ""
echo "=== Starting Debug Mode Test ==="
echo "The indicator will show recording state for 3 seconds"
echo "Then it will transcribe the test file"
echo ""

# Start recording via D-Bus
echo "Starting debug recording..."
do_in_pod gdbus call --session \
  --dest com.happytomatoe.VoiceToText \
  --object-path /com/happytomatoe/VoiceToText \
  --method com.happytomatoe.VoiceToText.StartRecording \
  '{"provider": "deepgram", "language": "en", "output_method": "type"}' 2>/dev/null || true

# Capture screenshots during the recording process
echo "Capturing recording state..."
sleep 1
capture_full "${OUTPUT_DIR}/02-recording-started.png"

sleep 2
capture_full "${OUTPUT_DIR}/03-recording-3-seconds.png"

# Wait for transcription to complete
echo "Waiting for transcription..."
sleep 8
capture_full "${OUTPUT_DIR}/04-transcription-complete.png"

# Get the service logs
echo "Getting service logs..."
do_in_pod bash -c "cat /tmp/dbus-service.log 2>/dev/null || journalctl --user --no-pager 2>/dev/null | grep -i voice" > "${OUTPUT_DIR}/recording-service.log" 2>/dev/null || true

# Wait for ffmpeg to finish (or kill it after 30 seconds)
echo "Waiting for recording to complete..."
sleep 5

# Copy the recording from container
echo "Copying recording from container..."
podman cp "${POD}:/tmp/recording.mp4" "${RECORDING_FILE}" 2>/dev/null || true

# Check if recording was saved
if [[ -f "${RECORDING_FILE}" ]]; then
  echo ""
  echo "✅ Recording saved: ${RECORDING_FILE}"
  ls -lh "${RECORDING_FILE}"
else
  echo ""
  echo "⚠️  Recording not found in container, checking alternative locations..."
  # Try to find any mp4 files
  do_in_pod find /tmp -name "*.mp4" -type f 2>/dev/null | head -5 || true
fi

echo ""
echo "=== Test Complete ==="
echo ""
echo "Artifacts saved to: ${OUTPUT_DIR}/"
ls -la "${OUTPUT_DIR}/"
