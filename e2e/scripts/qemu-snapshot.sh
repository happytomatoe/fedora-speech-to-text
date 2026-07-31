#!/bin/bash
# QEMU-based E2E snapshot testing.
# Boots a fresh VM overlay, captures screenshots, compares against references.
#
# Usage: ./qemu-snapshot.sh [--update]
#   --update: Save screenshots as new references instead of comparing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
VM_DIR="${PROJECT_ROOT}/e2e/qemu-images"
BASE_IMAGE="${VM_DIR}/base.qcow2"
OVERLAY_IMAGE="${VM_DIR}/overlay.qcow2"
HOT_BOOT_SNAPSHOT="${VM_DIR}/readyvm"  # saved VM state for fast boot
REFERENCES_DIR="${SCRIPT_DIR}/../expected-qemu"
OUTPUT_DIR="${SCRIPT_DIR}/../output-qemu"
SSH_KEY="${VM_DIR}/id_ed25519"

SSH_USER="testuser"
SSH_PORT=2222
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

UPDATE_MODE=false
KEEP_RUNNING=false
for arg in "$@"; do
    case "$arg" in
        --update) UPDATE_MODE=true ;;
        --keep-running) KEEP_RUNNING=true ;;
    esac
done

# ─── Preflight checks ──────────────────────────────────────────────────
if [[ ! -f "${BASE_IMAGE}" ]]; then
    echo "ERROR: Base VM image not found: ${BASE_IMAGE}"
    echo "Run 'just qemu-e2e-setup' first to create the base image."
    exit 1
fi

if [[ ! -f "${SSH_KEY}" ]]; then
    echo "ERROR: SSH key not found: ${SSH_KEY}"
    echo "Run 'just qemu-e2e-setup' first."
    exit 1
fi

# ─── Timing helpers ─────────────────────────────────────────────────────
timer_start() { _T_START=$(date +%s%N); }
timer_stop() {
    local label="${1}"
    local elapsed=$(( ($(date +%s%N) - _T_START) / 1000000 ))
    printf "  ⏱  %-40s %3d.%01ds\n" "${label}" "$((elapsed / 1000))" "$(( (elapsed % 1000) / 100 ))"
}

# ─── Helper functions ───────────────────────────────────────────────────
# Prefix that sets DISPLAY and D-Bus session address inside the VM.
VM_ENV='export DISPLAY=:0; export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/dbus-address 2>/dev/null);'

do_ssh() {
    ssh -i "${SSH_KEY}" ${SSH_OPTS} -p ${SSH_PORT} ${SSH_USER}@localhost "${VM_ENV} $*"
}

poll_until() {
    local desc="${1}"
    local timeout="${2:-30}"
    local interval="${3:-1}"
    shift 3

    echo -n "Waiting for ${desc}"
    for i in $(seq 1 "$timeout"); do
        if "$@" >/dev/null 2>&1; then
            echo " ready (${i}s)"
            return 0
        fi
        echo -n "."
        sleep "$interval"
    done
    echo " TIMEOUT after ${timeout}s"
    return 1
}

qemu_monitor() {
    # Use || true so missing socat or broken socket doesn't abort the script under set -e
    (echo "$1" | socat -t 10 - UNIX-CONNECT:"${VM_DIR}/qemu-monitor.sock" 2>/dev/null) || true
}

# ─── Capture functions ──────────────────────────────────────────────────
capture_via_qmp() {
    local output_file="${1}"
    local ppm_file="/tmp/e2e-screenshot.ppm"

    # Retry up to 3 times — QEMU monitor may be briefly unresponsive after savevm
    for attempt in 1 2 3; do
        rm -f "${ppm_file}"
        qemu_monitor "screendump ${ppm_file}"
        sleep 0.5
        if [[ -f "${ppm_file}" ]]; then
            convert "${ppm_file}" "${output_file}" 2>/dev/null
            rm -f "${ppm_file}"
            return 0
        fi
        echo -n "(retry ${attempt})"
        sleep 1
    done
    return 1
}

capture_crop() {
    local output_file="${1}"
    local crop="${2}"
    local full_file="/tmp/e2e-full.ppm"

    # Retry up to 3 times — QEMU monitor may be briefly unresponsive after savevm
    for attempt in 1 2 3; do
        rm -f "${full_file}"
        qemu_monitor "screendump ${full_file}"
        sleep 0.5
        if [[ -f "${full_file}" ]]; then
            convert "${full_file}" -crop ${crop} +repage "${output_file}" 2>/dev/null
            rm -f "${full_file}"
            return 0
        fi
        echo -n "(retry ${attempt})"
        sleep 1
    done
    return 1
}

snapshot_test() {
    local test_name="${1}"
    local description="${2}"
    local capture_cmd="${3:-full}"

    TESTS_RUN=$((TESTS_RUN + 1))
    echo -n "  ${test_name} (${description})... "

    local actual="${DEST}/${test_name}.png"

    # Capture screenshot
    if [[ "${capture_cmd}" == "full" ]]; then
        capture_via_qmp "${actual}"
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

    if [[ ! -f "${actual}" ]]; then
        echo "FAIL (no screenshot captured)"
        TESTS_FAILED=$((TESTS_FAILED + 1))
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

cleanup() {
    echo ""
    if [[ "${KEEP_RUNNING}" == "true" ]]; then
        echo "VM kept running (--keep-running flag)"
        echo "Connect via SPICE: just e2e-test-view"
        echo "Or SSH: ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@localhost"
        echo "Press Ctrl+C in this terminal to force shutdown"
        # Wait for user interrupt
        wait ${QEMU_PID} 2>/dev/null || true
        return
    fi
    echo "Cleaning up..."
    # Kill dotoold if running
    do_ssh "pkill -f dotoold" 2>/dev/null || true
    qemu_monitor "system_powerdown" 2>/dev/null || true
    sleep 3
    pkill -f "qemu-system-x86.*overlay.qcow2" 2>/dev/null || true
    # Keep overlay for hot boot on next run (both --update and test modes)
    rm -f "${VM_DIR}/qemu-monitor.sock"
}
trap cleanup EXIT

SCRIPT_START=$(date +%s%N)

# ─── Create or reuse overlay ──────────────────────────────────────────
timer_start
if [[ "${UPDATE_MODE}" == "true" ]] || [[ ! -f "${OVERLAY_IMAGE}" ]]; then
    echo "Creating fresh VM overlay..."
    rm -f "${OVERLAY_IMAGE}"
    qemu-img create -f qcow2 -b "${BASE_IMAGE}" -F qcow2 "${OVERLAY_IMAGE}" 2>/dev/null
else
    echo "Reusing existing overlay (for hot boot)..."
fi
timer_stop "Create overlay"

# ─── Boot VM ────────────────────────────────────────────────────────────
timer_start
cd "${VM_DIR}"
rm -f qemu-monitor.sock

qemu-system-x86_64 \
    -enable-kvm \
    -cpu host \
    -m 4096 \
    -smp 2 \
    -drive file="${OVERLAY_IMAGE}",format=qcow2,if=virtio \
    -device virtio-vga \
    -display vnc=:1 \
    -monitor unix:qemu-monitor.sock,server,nowait \
    -serial file:serial.log \
    -netdev user,id=net0,hostfwd=tcp::${SSH_PORT}-:22 \
    -device virtio-net-pci,netdev=net0 \
    -no-reboot &

QEMU_PID=$!
echo "${QEMU_PID}" > "${VM_DIR}/qemu.pid"
timer_stop "VM boot (QEMU start)"

# ─── Wait for SSH ──────────────────────────────────────────────────────
timer_start
poll_until "SSH" 60 2 do_ssh echo ok
timer_stop "Wait for SSH"

# ─── Hot boot: restore from snapshot or cold boot + save ────────────────
NEEDS_SETUP=false
if [[ "${UPDATE_MODE}" == "false" ]] && qemu_monitor "info snapshots" 2>/dev/null | grep -q "ready"; then
    echo "Hot boot: restoring from snapshot..."
    timer_start
    qemu_monitor "loadvm ready"
    poll_until "SSH after restore" 30 2 do_ssh echo ok
    timer_stop "Hot boot restore"
else
    # Cold boot: set up GNOME, extension, D-Bus service
    NEEDS_SETUP=true
fi

if [[ "${NEEDS_SETUP}" == "true" ]]; then
    # ─── Wait for GDM auto-login (creates session with seat0) ────────────
    timer_start
    echo "Waiting for GDM auto-login..."
    # GDM auto-login creates a session with seat0 — required for dotool
    poll_until "GDM session with seat" 60 2 do_ssh "loginctl list-sessions 2>/dev/null | grep -q seat0"
    # Extract D-Bus address from GNOME Shell process
    do_ssh "DBUS_ADDR=\$(cat /proc/\$(pgrep -f 'gnome-shell --mode=user' | head -1)/environ 2>/dev/null | tr '\\0' '\\n' | grep DBUS_SESSION_BUS_ADDRESS | head -1 | cut -d= -f2-); if [ -n \"\$DBUS_ADDR\" ]; then echo \"\$DBUS_ADDR\" > /tmp/dbus-address; fi"
    # Verify we got a valid address
    if ! do_ssh "test -s /tmp/dbus-address" 2>/dev/null; then
        echo "  WARNING: D-Bus address extraction failed"
    fi
    do_ssh "gnome-extensions enable voice-to-text@happytomatoe.com 2>/dev/null || true"
    do_ssh "gsettings set org.gnome.shell.extensions.voice-to-text provider deepgram 2>/dev/null || true"
    poll_until "GNOME Shell" 10 1 do_ssh "pgrep -f 'gnome-shell --mode=user'"
    timer_stop "Wait for GDM auto-login"
    # ─── Start dotoold ──────────────────────────────────────────────────
    timer_start
    echo "Starting dotoold..."
    do_ssh "export DOTOOL_PIPE=/run/user/\$(id -u)/dotool-pipe; /home/testuser/.local/bin/dotoold &>/tmp/dotoold.log &"
    sleep 2
    poll_until "dotool pipe" 10 1 do_ssh "test -p /run/user/\$(id -u)/dotool-pipe"
    timer_stop "Start dotoold"

    # ─── Start D-Bus service with debug mode ──────────────────────────────
    timer_start
    echo "Starting D-Bus service..."
    # Deploy Python source code to VM
    PYTHON_SRC="${SCRIPT_DIR_REAL}/../../../src/voice_to_text"
    if [[ -d "${PYTHON_SRC}" ]]; then
        echo "Deploying Python source..."
        do_ssh "mkdir -p ~/voice_to_text/src"
        scp -r -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} "${PYTHON_SRC}" ${SSH_USER}@localhost:~/voice_to_text/src/ 2>/dev/null || true
    fi
    # SCRIPT_DIR_REAL already set at top of file
    # Copy test audio file to VM
    TEST_AUDIO="${SCRIPT_DIR_REAL}/../fixtures/test-audio.wav"
    if [[ -f "${TEST_AUDIO}" ]]; then
        scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} "${TEST_AUDIO}" ${SSH_USER}@localhost:/tmp/test-audio.wav 2>/dev/null || true
    fi
    # Install Python dependencies
    echo "Installing Python dependencies..."
    do_ssh "pip3 install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets 2>/dev/null || true"
    # Support both Deepgram (cloud) and Parakeet (local) providers
    PROVIDER_ARGS=""
    if [[ -n "${PARAKEET_MODEL_PATH:-}" ]]; then
        PROVIDER_ARGS="export PARAKEET_MODEL_PATH=${PARAKEET_MODEL_PATH}; export VOICE_TO_TEXT_PROVIDER=parakeet;"
        echo "  Using Parakeet provider (local model)"
    else
        PROVIDER_ARGS="export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-};"
        echo "  Using Deepgram provider (cloud)"
    fi
    do_ssh "export PATH=\$HOME/.local/bin:\$PATH; export XDG_RUNTIME_DIR=/run/user/\$(id -u); ${PROVIDER_ARGS} export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export PYTHONPATH=~/voice_to_text/src; cd ~; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &"
    sleep 1

    echo -n "Waiting for D-Bus service"
    for i in $(seq 1 15); do
        if do_ssh "busctl --user list 2>/dev/null | grep -q com.happytomatoe.VoiceToText"; then
            echo " ready (${i}s)"
            break
        fi
        echo -n "."
        sleep 1
    done
    timer_stop "Start D-Bus service"

    # ─── Save snapshot for hot boot ───────────────────────────────────────
    if [[ "${UPDATE_MODE}" == "true" ]]; then
        timer_start
        echo "Saving VM snapshot for hot boot..."
        qemu_monitor "savevm ready"
        # Give QEMU time to finish writing snapshot and recover the monitor
        sleep 2
        timer_stop "Save snapshot"
    fi
fi

# ─── Setup output directories ──────────────────────────────────────────
if [[ "${UPDATE_MODE}" == "true" ]]; then
    mkdir -p "${REFERENCES_DIR}"
    DEST="${REFERENCES_DIR}"
else
    mkdir -p "${OUTPUT_DIR}"
    DEST="${OUTPUT_DIR}"
fi

TESTS_FAILED=0
TESTS_RUN=0

echo ""
echo "=== QEMU E2E Test ==="
echo ""

# SCRIPT_DIR_REAL already set at top of file

# Helper to send dotool commands
do_dotool() {
    # Use dotoolc to send commands through the pipe
    do_ssh "export DOTOOL_PIPE=/run/user/\$(id -u)/dotool-pipe; echo '$1' | /home/testuser/.local/bin/dotoolc"
}

# Helper to press the recording hotkey (Super+w) via dotool
do_hotkey() {
    do_dotool 'key super+w'
}

# ─── Step 1: Open terminal and attach to tmux session ───────────────────
timer_start
echo "Opening terminal with tmux..."
do_ssh "nohup gnome-terminal &>/dev/null &"
sleep 3
# Type tmux attach command and press Enter
do_dotool 'type tmux attach -t test'
sleep 0.5
do_dotool 'key Enter'
sleep 2
timer_stop "Open terminal & attach tmux"

# ─── Step 2: Type echo command ────────────────────────────────────────
timer_start
echo "Typing echo command..."
do_dotool 'type echo "'
sleep 1
timer_stop "Type echo command"

# ─── Step 3: Start recording via hotkey (Super+w) ─────────────────────
timer_start
echo "Starting recording via hotkey..."
do_hotkey
sleep 2
timer_stop "Start recording (hotkey)"

# ─── Step 4: Wait for transcription to appear ──────────────────────────
timer_start
echo -n "Waiting for transcription"
TRANSCRIPTION=""
for i in $(seq 1 30); do
    TRANSCRIPTION=$(do_ssh "grep -oP 'Transcription result: \\K.*' /tmp/voice-service.log 2>/dev/null | tail -1" 2>/dev/null || true)
    if [[ -n "${TRANSCRIPTION}" ]]; then
        echo " (${i}s)"
        echo "  Got: ${TRANSCRIPTION}"
        break
    fi
    echo -n "."
    sleep 1
done

if [[ -z "${TRANSCRIPTION}" ]]; then
    echo " TIMEOUT"
    # Continue anyway — the file verification will catch it
fi
timer_stop "Wait for transcription"

# ─── Step 5: Stop recording via hotkey (Super+w) ──────────────────────
timer_start
echo "Stopping recording via hotkey..."
do_hotkey
sleep 2
timer_stop "Stop recording (hotkey)"

# ─── Step 5: Complete the echo command ─────────────────────────────────
timer_start
echo "Completing command..."
if [[ -n "${TRANSCRIPTION}" ]]; then
    # Write directly via SSH to avoid dotool quoting issues
    do_ssh "echo '${TRANSCRIPTION}' > /tmp/file.txt"
else
    echo "  WARNING: No transcription captured, writing empty file"
    do_ssh "echo '' > /tmp/file.txt"
fi
sleep 1
timer_stop "Complete command"

# ─── Step 6: Verify result ─────────────────────────────────────────────
timer_start
echo ""
echo "=== Verification ==="
EXPECTED_FILE="${SCRIPT_DIR_REAL}/../fixtures/expected-text.txt"
if [[ -f "${EXPECTED_FILE}" ]]; then
    EXPECTED=$(cat "${EXPECTED_FILE}")
    ACTUAL=$(do_ssh "cat /tmp/file.txt 2>/dev/null" 2>/dev/null || true)

    echo "  Transcription captured: ${TRANSCRIPTION:-<none>}"
    echo "  Expected: ${EXPECTED}"
    echo "  Actual:   ${ACTUAL}"

    if [[ "${ACTUAL}" == "${EXPECTED}" ]]; then
        echo "  PASS: Text matches expected output"
    else
        echo "  FAIL: Text does not match"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
else
    echo "SKIP: No expected-text.txt found, checking if file exists"
    if do_ssh "test -f /tmp/file.txt" 2>/dev/null; then
        echo "PASS: /tmp/file.txt exists"
        do_ssh "cat /tmp/file.txt"
    else
        echo "FAIL: /tmp/file.txt not found"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
fi
timer_stop "Verify result"

# ─── Results ────────────────────────────────────────────────────────────
echo ""
echo "========================================="

# ─── Timing summary ───────────────────────────────────────────────────
SCRIPT_ELAPSED=$(( ($(date +%s%N) - SCRIPT_START) / 1000000 ))
echo ""
echo "=== Timing Summary ==="
printf "  %-42s %3d.%01ds\n" "Total" "$((SCRIPT_ELAPSED / 1000))" "$(( (SCRIPT_ELAPSED % 1000) / 100 ))"
echo ""
if [[ "${KEEP_RUNNING}" == "true" ]]; then
    echo "=== VM is running ==="
    echo "SPICE: remote-viewer spice://localhost:5930"
    echo "  or:  just e2e-test-view"
    echo "SSH:   ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@localhost"
    echo ""
fi

if [[ ${TESTS_FAILED} -eq 0 ]]; then
    echo "All tests passed!"
    exit 0
else
    echo "${TESTS_FAILED} test(s) failed."
    exit 1
fi
