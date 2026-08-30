#!/usr/bin/env bash
# openQA POC runner with Xvfb
# Runs isotovideo against the golden image with Xvfb providing X11 display

set -euo pipefail

POC_DIR="/var/home/l/git/fedora-speech-to-text/feat/openqa/e2e/openqa-poc"
RESULTS_DIR="${POC_DIR}/testresults"
XVFB_DISPLAY=":99"
XVFB_SCREEN="1920x1080x24"

echo "=== openQA POC: Boot to GNOME Desktop ==="
echo "POC dir: ${POC_DIR}"
echo "Results dir: ${RESULTS_DIR}"

# Clean up previous runs
rm -rf "${RESULTS_DIR}"
mkdir -p "${RESULTS_DIR}"

# Check if Xvfb is available
if ! command -v Xvfb &> /dev/null; then
    echo "ERROR: Xvfb not found. Install: sudo dnf install xorg-x11-server-Xvfb"
    exit 1
fi

# Check if isotovideo is available
if ! command -v isotovideo &> /dev/null; then
    echo "ERROR: isotovideo not found. Install: sudo dnf install os-autoinst"
    exit 1
fi

# Check KVM access
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "ERROR: /dev/kvm not accessible"
    exit 1
fi

# Check golden image exists
GOLDEN_IMAGE="/var/home/l/git/fedora-speech-to-text/main/e2e/qemu-images/golden-gnome-deps.qcow2"
if [ ! -f "${GOLDEN_IMAGE}" ]; then
    echo "ERROR: Golden image not found at ${GOLDEN_IMAGE}"
    exit 1
fi

# Start Xvfb
echo "Starting Xvfb on ${XVFB_DISPLAY}..."
# Clean up stale Xvfb socket
rm -f /tmp/.X11-unix/X99

Xvfb "${XVFB_DISPLAY}" -screen 0 "${XVFB_SCREEN}" -ac -nolisten tcp &
XVFB_PID=$!

# Wait for Xvfb to be ready
sleep 2

# Verify Xvfb is running
if ! kill -0 ${XVFB_PID} 2>/dev/null; then
    echo "ERROR: Xvfb failed to start"
    exit 1
fi

echo "Xvfb started (PID: ${XVFB_PID})"

# Export DISPLAY for any subprocesses
export DISPLAY="${XVFB_DISPLAY}"

# Run isotovideo
echo "Running isotovideo..."
cd "${POC_DIR}"

# Set PERL5LIB for os-autoinst modules
export PERL5LIB="/usr/lib/os-autoinst:${PERL5LIB:-}"

# Run isotovideo with our vars.json
# The test will output results to testresults/
if timeout 300 isotovideo \
    --varfile vars.json \
    --test boot_desktop \
    --results "${RESULTS_DIR}" \
    --tap \
    2>&1 | tee "${RESULTS_DIR}/isotovideo.log"; then

    ISO_EXIT=$?
    echo "isotovideo exited with code: ${ISO_EXIT}"
else
    ISO_EXIT=${PIPESTATUS[0]}
    echo "isotovideo failed or timed out (exit: ${ISO_EXIT})"
fi

# Clean up Xvfb
echo "Stopping Xvfb (PID: ${XVFB_PID})..."
kill ${XVFB_PID} 2>/dev/null || true
wait ${XVFB_PID} 2>/dev/null || true

# Check results
if [ -f "${RESULTS_DIR}/test_results.json" ]; then
    echo ""
    echo "=== Test Results ==="
    cat "${RESULTS_DIR}/test_results.json" | python3 -m json.tool
elif [ -f "${RESULTS_DIR}/results.json" ]; then
    echo ""
    echo "=== Test Results ==="
    cat "${RESULTS_DIR}/results.json" | python3 -m json.tool
else
    echo ""
    echo "No test_results.json found. Checking for other result files:"
    ls -la "${RESULTS_DIR}/"
fi

# Show screenshots if any
echo ""
echo "=== Screenshots ==="
find "${RESULTS_DIR}" -name "*.png" -o -name "*.ppm" 2>/dev/null | head -10

echo ""
echo "POC run complete. Exit code: ${ISO_EXIT}"
exit ${ISO_EXIT}