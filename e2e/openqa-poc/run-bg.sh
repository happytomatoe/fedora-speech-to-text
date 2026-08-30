#!/usr/bin/env bash
# openQA POC runner with Xvfb - runs inside toolbox
# Uses background process with log monitoring

set -euo pipefail

POC_DIR="/var/home/l/git/fedora-speech-to-text/feat/openqa/e2e/openqa-poc"
RESULTS_DIR="${POC_DIR}/testresults"
XVFB_DISPLAY=":99"
XVFB_SCREEN="1920x1080x24"
LOG_FILE="${RESULTS_DIR}/poc-run.log"
PID_FILE="${RESULTS_DIR}/poc.pid"

echo "=== openQA POC: Boot to GNOME Desktop (inside toolbox) ==="
echo "POC dir: ${POC_DIR}"
echo "Results dir: ${RESULTS_DIR}"
echo "Log file: ${LOG_FILE}"

# Clean up previous runs
rm -rf "${RESULTS_DIR}"
mkdir -p "${RESULTS_DIR}"

# Check prerequisites
if ! command -v Xvfb &> /dev/null; then
    echo "ERROR: Xvfb not found" | tee -a "${LOG_FILE}"
    exit 1
fi
if ! command -v isotovideo &> /dev/null; then
    echo "ERROR: isotovideo not found" | tee -a "${LOG_FILE}"
    exit 1
fi
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "ERROR: /dev/kvm not accessible" | tee -a "${LOG_FILE}"
    exit 1
fi

GOLDEN_IMAGE="/var/home/l/git/fedora-speech-to-text/main/e2e/qemu-images/golden-gnome-deps.qcow2"
if [ ! -f "${GOLDEN_IMAGE}" ]; then
    echo "ERROR: Golden image not found at ${GOLDEN_IMAGE}" | tee -a "${LOG_FILE}"
    exit 1
fi

# Kill any existing Xvfb on :99
pkill -x Xvfb 2>/dev/null || true
sleep 1
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Start Xvfb in background
echo "Starting Xvfb on ${XVFB_DISPLAY}..." | tee -a "${LOG_FILE}"
Xvfb "${XVFB_DISPLAY}" -screen 0 "${XVFB_SCREEN}" -ac -nolisten tcp >> "${LOG_FILE}" 2>&1 &
XVFB_PID=$!
echo ${XVFB_PID} > "${RESULTS_DIR}/xvfb.pid"

# Wait for Xvfb to be ready
sleep 3
if ! kill -0 ${XVFB_PID} 2>/dev/null; then
    echo "ERROR: Xvfb failed to start" | tee -a "${LOG_FILE}"
    exit 1
fi
echo "Xvfb started (PID: ${XVFB_PID})" | tee -a "${LOG_FILE}"

export DISPLAY="${XVFB_DISPLAY}"

# Run isotovideo in background
echo "Starting isotovideo in background..." | tee -a "${LOG_FILE}"
cd "${POC_DIR}"
export PERL5LIB="/usr/lib/os-autoinst:/tmp/os-autoinst-distri-fedora/lib:${PERL5LIB:-}"

isotovideo \
    CASEDIR="${POC_DIR}" \
    DISTRI="vtdistribution" \
    BACKEND="qemu" \
    VNC="99" \
    ARCH="x86_64" \
    HDD_1="${GOLDEN_IMAGE}" \
    QEMUCPU="host" \
    QEMURAM="4096" \
    NUMDISKS="1" \
    HDDMODEL="virtio-blk" \
    HDDSIZEGB="10" \
    QEMUVGA="virtio" \
    UEFI="0" \
    SERIAL_CONSOLE="1" \
    TEST="boot_desktop" \
    WORKER_CLASS="openqa-poc" \
    OS_AUTOINST_STORAGE_KEEP_FREE_RATIO="0.01" \
    OS_AUTOINST_STORAGE_KEEP_FREE_GB="1" \
    >> "${LOG_FILE}" 2>&1 &

ISO_PID=$!
echo ${ISO_PID} > "${PID_FILE}"
echo "isotovideo started (PID: ${ISO_PID})" | tee -a "${LOG_FILE}"

# Monitor progress
MAX_WAIT=600  # 10 minutes max
CHECK_INTERVAL=10
ELAPSED=0
LAST_LOG_SIZE=0

echo "Monitoring progress (max ${MAX_WAIT}s)..." | tee -a "${LOG_FILE}"

while [ ${ELAPSED} -lt ${MAX_WAIT} ]; do
    sleep ${CHECK_INTERVAL}
    ELAPSED=$((ELAPSED + CHECK_INTERVAL))
    
    # Check if process is still running
    if ! kill -0 ${ISO_PID} 2>/dev/null; then
        echo "isotovideo process ended" | tee -a "${LOG_FILE}"
        break
    fi
    
    # Check log for progress
    if [ -f "${LOG_FILE}" ]; then
        CURRENT_SIZE=$(wc -c < "${LOG_FILE}")
        if [ ${CURRENT_SIZE} -gt ${LAST_LOG_SIZE} ]; then
            # Show recent log entries
            tail -20 "${LOG_FILE}" | grep -E "(starting|VNC|RESUME|GOT GO|starting boot_desktop|assert_script_run|wait_serial|ok|fail|EXIT)" | tail -5 | tee -a "${LOG_FILE}.progress"
            LAST_LOG_SIZE=${CURRENT_SIZE}
            echo "  [${ELAPSED}s] Progress detected..." | tee -a "${LOG_FILE}.progress"
        else
            echo "  [${ELAPSED}s] No new log output (may be stuck)..." | tee -a "${LOG_FILE}.progress"
        fi
    fi
    
    # Check for results
    if [ -f "${RESULTS_DIR}/result-boot_desktop.json" ]; then
        echo "Test results found!" | tee -a "${LOG_FILE}"
        break
    fi
done

# Check final status
if kill -0 ${ISO_PID} 2>/dev/null; then
    echo "Timeout reached, killing isotovideo (PID: ${ISO_PID})" | tee -a "${LOG_FILE}"
    kill ${ISO_PID} 2>/dev/null || true
    sleep 2
    kill -9 ${ISO_PID} 2>/dev/null || true
fi

# Clean up Xvfb
echo "Stopping Xvfb (PID: ${XVFB_PID})..." | tee -a "${LOG_FILE}"
kill ${XVFB_PID} 2>/dev/null || true
wait ${XVFB_PID} 2>/dev/null || true

# Show results
echo "" | tee -a "${LOG_FILE}"
echo "=== Final Results ===" | tee -a "${LOG_FILE}"

if [ -f "${RESULTS_DIR}/result-boot_desktop.json" ]; then
    echo "Test result found:" | tee -a "${LOG_FILE}"
    cat "${RESULTS_DIR}/result-boot_desktop.json" | python3 -m json.tool | tee -a "${LOG_FILE}"
elif [ -f "${RESULTS_DIR}/test_results.json" ]; then
    echo "Test results found:" | tee -a "${LOG_FILE}"
    cat "${RESULTS_DIR}/test_results.json" | python3 -m json.tool | tee -a "${LOG_FILE}"
else
    echo "No test results found. Files in results dir:" | tee -a "${LOG_FILE}"
    ls -la "${RESULTS_DIR}/" | tee -a "${LOG_FILE}"
fi

# Show screenshots if any
echo "" | tee -a "${LOG_FILE}"
echo "=== Screenshots ===" | tee -a "${LOG_FILE}"
find "${RESULTS_DIR}" -name "*.png" -o -name "*.ppm" 2>/dev/null | head -10 | tee -a "${LOG_FILE}"

echo "" | tee -a "${LOG_FILE}"
echo "POC run complete. Full log at: ${LOG_FILE}"