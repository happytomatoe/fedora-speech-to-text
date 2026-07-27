#!/bin/bash
# Test Deepgram API key injection and transcription directly
# This bypasses the full GNOME Shell UI and tests the core functionality

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
IMAGE="voice-to-text-e2e"

cd "${PROJECT_ROOT}"

# Check DEEPGRAM_API_KEY is set
if [[ -z "${DEEPGRAM_API_KEY}" ]]; then
  echo "ERROR: DEEPGRAM_API_KEY environment variable is not set"
  exit 1
fi

echo "=== Testing Deepgram API Key Injection ==="
echo "API Key: [REDACTED]"

# Build container if needed
if ! podman image exists "${IMAGE}"; then
  echo "Building test container..."
  podman build -t "${IMAGE}" -f tests/e2e/Containerfile .
fi

# Run container
echo "Starting container..."
POD=$(podman run --rm -d "${IMAGE}")

cleanup() {
  podman kill "${POD}" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for container to be ready
sleep 3

echo ""
echo "=== Step 1: Injecting API Key ==="

# Write API key to env file (pass as env var, expand inside container)
podman exec --user gnomeshell --workdir /home/gnomeshell \
  -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY}" \
  ${POD} bash -c 'echo "export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}" > /home/gnomeshell/.config/voice-to-text/env'

# Verify env file was written (redact API key)
echo "Verifying env file:"
podman exec --user gnomeshell ${POD} cat /home/gnomeshell/.config/voice-to-text/env | sed 's/DEEPGRAM_API_KEY=.*/DEEPGRAM_API_KEY=[REDACTED]/'

echo ""
echo "=== Step 2: Testing D-Bus Service Startup ==="

# Start the D-Bus service directly (not via systemd)
echo "Starting voice-to-text D-Bus service..."
podman exec --user gnomeshell --workdir /home/gnomeshell \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY}" \
  -e PATH=/app-venv/bin:/usr/local/bin:/usr/bin:/bin \
  -e PYTHONPATH=/app/src \
  ${POD} bash -c '
    # Source the env file
    test -f /home/gnomeshell/.config/voice-to-text/env && . /home/gnomeshell/.config/voice-to-text/env
    
    # Start the service in background
    /app-venv/bin/python -m voice_to_text > /tmp/dbus-service.log 2>&1 &
    SERVICE_PID=$!
    echo "Service PID: $SERVICE_PID"
    
    # Wait for service to start
    sleep 3
    
    # Check if service is running
    if kill -0 $SERVICE_PID 2>/dev/null; then
      echo "Service is running"
    else
      echo "Service failed to start"
      cat /tmp/dbus-service.log
      exit 1
    fi
    
    # Show service logs
    echo ""
    echo "=== Service Logs ==="
    cat /tmp/dbus-service.log
    echo "=== End Logs ==="
  ' 2>&1

echo ""
echo "=== Step 3: Testing Transcription ==="

# Copy test audio file into container
echo "Copying test audio file..."
podman cp tests/e2e/fixtures/test-audio.wav ${POD}:/home/gnomeshell/test-audio.wav

# Run transcription test
echo "Running transcription test..."
podman exec --user gnomeshell --workdir /home/gnomeshell \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY}" \
  -e PATH=/app-venv/bin:/usr/local/bin:/usr/bin:/bin \
  -e PYTHONPATH=/app/src \
  ${POD} bash -c '
    # Source the env file
    test -f /home/gnomeshell/.config/voice-to-text/env && . /home/gnomeshell/.config/voice-to-text/env
    
    # Create a Python test script
    cat > /tmp/test_transcription.py << '\''PYTHON_SCRIPT'\''
import os
import sys
import asyncio

# Add the project source to path
sys.path.insert(0, "/app/src")

from voice_to_text.providers.deepgram import DeepgramProvider

async def test_transcription():
    api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not api_key:
        print("ERROR: DEEPGRAM_API_KEY not set")
        return False
    
    print(f"API Key: [REDACTED]")
    
    provider = DeepgramProvider({"model": "nova-3", "batch_options": {}})
    
    # Read the test audio file
    audio_file = "/home/gnomeshell/test-audio.wav"
    if not os.path.exists(audio_file):
        print(f"ERROR: Audio file not found: {audio_file}")
        return False
    
    print(f"Audio file: {audio_file}")
    print(f"File size: {os.path.getsize(audio_file)} bytes")
    
    try:
        # Transcribe the audio
        result = await provider.transcribe_file(audio_file)
        print(f"Transcription result: {result}")
        return True
    except Exception as e:
        print(f"ERROR: Transcription failed: {e}")
        return False

if __name__ == "__main__":
    success = asyncio.run(test_transcription())
    sys.exit(0 if success else 1)
PYTHON_SCRIPT
    
    # Run the test
    python3 /tmp/test_transcription.py
  ' 2>&1

echo ""
echo "=== Test Complete ==="
