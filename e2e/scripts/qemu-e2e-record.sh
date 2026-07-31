#!/bin/bash
# QEMU E2E test with VNC recording.
# Records the entire E2E test flow as a video file.
#
# Usage: ./qemu-e2e-record.sh [--update] [--no-record]
#
# Requirements:
#   - ffmpeg on host (for VNC recording)
#   - podman with fedora-toolbox-44 container running
#   - QEMU VM with VNC enabled

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
VM_DIR="${PROJECT_ROOT}/e2e/qemu-images"
OUTPUT_DIR="/tmp/e2e-recordings"
RECORDINGS_DIR="${OUTPUT_DIR}"
RECORDINGS_DIR="${OUTPUT_DIR}/recordings"

# Parse arguments
UPDATE_MODE=false
NO_RECORD=false
for arg in "$@"; do
    case "${arg}" in
        --update) UPDATE_MODE=true ;;
        --no-record) NO_RECORD=true ;;
    esac
done

# Create output directories
mkdir -p "${OUTPUT_DIR}" "${RECORDINGS_DIR}"

# Generate timestamp for this run
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
VIDEO_FILE="${RECORDINGS_DIR}/e2e-run-${TIMESTAMP}.mp4"
SCREENCAST_FILE="${RECORDINGS_DIR}/e2e-run-${TIMESTAMP}.ppm"

echo "=== QEMU E2E Test with Recording ==="
echo "Timestamp: ${TIMESTAMP}"
echo "Video output: ${VIDEO_FILE}"
echo ""

# ─── Step 1: Kill any existing QEMU ─────────────────────────────────
echo "1. Cleaning up existing QEMU..."
podman exec fedora-toolbox-44 bash -c "pkill -9 -f 'qemu-system-x86' 2>/dev/null || true"
sleep 2

# ─── Step 2: Start QEMU VM with VNC ──────────────────────────────────
echo "2. Starting QEMU VM with VNC..."
podman exec -d fedora-toolbox-44 bash -c "
    cd /tmp/gnome-ext-vm
    rm -f qemu-monitor.sock serial.log
    
    # Create fresh overlay
    qemu-img create -f qcow2 -b base.qcow2 -F qcow2 overlay.qcow2 5G
    
    # Start QEMU with VNC on display :1 (port 5901)
    qemu-system-x86_64 \
        -enable-kvm \
        -cpu host \
        -m 4096 \
        -smp 2 \
        -drive file=overlay.qcow2,format=qcow2,if=virtio \
        -drive file=seed.iso,format=raw,if=virtio,readonly=on \
        -device virtio-vga \
        -display vnc=:1 \
        -monitor unix:qemu-monitor.sock,server,nowait \
        -serial file:serial.log \
        -netdev user,id=net0,hostfwd=tcp::2222-:22 \
        -device virtio-net-pci,netdev=net0 \
        -no-reboot
" &
QEMU_START_PID=$!
echo "   QEMU starting (background PID: ${QEMU_START_PID})"

# ─── Step 3: Wait for QEMU to be ready ───────────────────────────────
echo "3. Waiting for QEMU VNC to be ready..."
VNC_READY=false
for i in $(seq 1 30); do
    # Check if VNC port is listening inside container
    if podman exec fedora-toolbox-44 bash -c "ss -tlnp | grep -q ':5901'" 2>/dev/null; then
        echo "   VNC ready (${i}s)"
        VNC_READY=true
        break
    fi
    echo -n "."
    sleep 1
done

if [[ "${VNC_READY}" != "true" ]]; then
    echo " TIMEOUT"
    exit 1
fi

# ─── Step 4: Set up VNC port forwarding ──────────────────────────────
echo "4. Setting up VNC port forwarding..."
# Use SSH tunnel to forward VNC from container to host
# Container SSH is on port 2222, forward VNC (5901) to host port 5901
ssh -f -N -L 5901:localhost:5901 -p 2222 -i "${VM_DIR}/id_ed25519" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    testuser@localhost 2>/dev/null || true
sleep 1

# Verify VNC is accessible on host
if ! nc -z localhost 5901 2>/dev/null; then
    echo "   WARNING: VNC port 5901 not accessible on host"
    echo "   Trying alternative: socat forwarding..."
    # Kill any existing socat
    pkill -f "socat.*5901" 2>/dev/null || true
    # Start socat in background to forward VNC
    socat TCP-LISTEN:5901,fork,reuseaddr TCP:localhost:5901 &
    sleep 1
fi

# ─── Step 5: Wait for SSH and GNOME Shell ────────────────────────────
echo "5. Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh -p 2222 -i "${VM_DIR}/id_ed25519" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        testuser@localhost echo ok >/dev/null 2>&1; then
        echo "   SSH ready (${i}s)"
        break
    fi
    echo -n "."
    sleep 2
done

echo "6. Starting GNOME Shell..."
podman exec fedora-toolbox-44 bash -c "
    ssh -p 2222 -i /tmp/gnome-ext-vm/id_ed25519 \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        testuser@localhost 'export DISPLAY=:1; dbus-launch gnome-session &'"
sleep 5

# ─── Step 6: Start QEMU screendump recording ──────────────────────────
RECORDING_DIR="${OUTPUT_DIR}/frames"
mkdir -p "${RECORDING_DIR}"
FRAME_COUNT=0
RECORDING_ACTIVE=false

if [[ "${NO_RECORD}" != "true" ]]; then
    echo "7. Starting QEMU screendump recording..."
    RECORDING_ACTIVE=true
    # Start background process to capture frames via QEMU monitor
    (
        while [[ "${RECORDING_ACTIVE}" == "true" ]]; do
            FRAME_FILE="${RECORDING_DIR}/frame-$(printf '%04d' ${FRAME_COUNT}).ppm"
            echo "screendump ${FRAME_FILE}" | socat -t 2 - UNIX-CONNECT:/tmp/gnome-ext-vm/qemu-monitor.sock 2>/dev/null || true
            FRAME_COUNT=$((FRAME_COUNT + 1))
            sleep 0.5  # ~2fps
        done
    ) &
    RECORDING_PID=$!
    echo "   Recording started (PID: ${RECORDING_PID}, ~2fps via QEMU screendump)"
    sleep 2
else
    echo "7. Skipping recording (--no-record)"
fi

# ─── Step 7: Run E2E tests ──────────────────────────────────────────
echo "8. Running E2E tests..."
echo ""
TEST_ARGS=""
if [[ "${UPDATE_MODE}" == "true" ]]; then
    TEST_ARGS="--update"
fi

podman exec -e DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY:-}" fedora-toolbox-44 \
    bash -c "REPO_ROOT=/var/home/l/git/voice-to-text-test-pod \
    /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-snapshot.sh ${TEST_ARGS}" 2>&1

TEST_EXIT=$?

# ─── Step 8: Stop recording and assemble video ──────────────────────
echo ""
echo "9. Stopping recording..."
RECORDING_ACTIVE=false
if [[ -n "${RECORDING_PID}" ]]; then
    kill "${RECORDING_PID}" 2>/dev/null || true
    wait "${RECORDING_PID}" 2>/dev/null || true
fi

# Assemble frames into video if we have any
FRAME_COUNT=$(ls "${RECORDING_DIR}"/frame-*.ppm 2>/dev/null | wc -l)
if [[ ${FRAME_COUNT} -gt 0 ]]; then
    echo "   Assembling ${FRAME_COUNT} frames into video..."
    ffmpeg -y -framerate 2 -i "${RECORDING_DIR}/frame-%04d.ppm" \
        -c:v mpeg4 -q:v 5 \
        "${VIDEO_FILE}" 2>/dev/null || true
    echo "   Recording saved to: ${VIDEO_FILE}"
    ls -lh "${VIDEO_FILE}" 2>/dev/null || echo "   (no video file)"
else
    echo "   No frames captured"
fi

# ─── Step 9: Cleanup ─────────────────────────────────────────────────
echo "10. Cleaning up..."
# Kill SSH tunnel
pkill -f "ssh.*-L.*5901" 2>/dev/null || true
# Kill socat
pkill -f "socat.*5901" 2>/dev/null || true
# Shutdown QEMU
podman exec fedora-toolbox-44 bash -c "
    echo 'system_powerdown' | socat - UNIX-CONNECT:/tmp/gnome-ext-vm/qemu-monitor.sock 2>/dev/null || true
" 2>/dev/null || true
sleep 2

echo ""
echo "=== Done ==="
echo "Test exit code: ${TEST_EXIT}"
if [[ -f "${VIDEO_FILE}" ]]; then
    echo "Video: ${VIDEO_FILE}"
    echo "Duration: $(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${VIDEO_FILE}" 2>/dev/null || echo 'unknown')s"
fi
echo "Screenshots: ${OUTPUT_DIR}/"
