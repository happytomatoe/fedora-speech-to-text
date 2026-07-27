#!/bin/bash
# QEMU-based E2E snapshot testing.
# Boots a fresh VM overlay, captures screenshots, compares against references.
#
# Usage: ./qemu-snapshot.sh [--update]
#   --update: Save screenshots as new references instead of comparing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../../.."
VM_DIR="/tmp/gnome-ext-vm"
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
if [[ "${1:-}" == "--update" ]]; then
    UPDATE_MODE=true
fi

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
    echo "$1" | socat -t 10 - UNIX-CONNECT:"${VM_DIR}/qemu-monitor.sock" 2>/dev/null
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
    echo "Cleaning up..."
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
    # ─── Start GNOME Shell ────────────────────────────────────────────────
    timer_start
    echo "Starting GNOME Shell..."
    do_ssh "sudo Xorg :0 -configure 2>/dev/null || true"
    do_ssh "nohup sudo Xorg :0 &>/dev/null &"
    sleep 2
    do_ssh "eval \$(dbus-launch --sh-syntax) && echo \"\$DBUS_SESSION_BUS_ADDRESS\" > /tmp/dbus-address"
    do_ssh "nohup gnome-shell --x11 &>/dev/null &"
    sleep 2
    do_ssh "gnome-extensions enable voice-to-text@happytomatoe.com 2>/dev/null || true"
    do_ssh "gsettings set org.gnome.shell.extensions.voice-to-text provider deepgram 2>/dev/null || true"

    # Wait for GNOME Shell
    poll_until "GNOME Shell" 30 1 do_ssh "gnome-extensions list"
    timer_stop "Start GNOME Shell"

    # Dismiss GNOME welcome tour if present
    # The tour is a GNOME Shell modal — not a regular X11 window
    # Click the "Skip" button directly by coordinates (1280x720 display)
    timer_start
    echo "Dismissing welcome tour..."
    for attempt in 1 2 3 4 5; do
        # Check if tour is visible by looking for the Skip button area
        # On 1280x720, Skip button is at approximately x=530, y=595
        do_ssh "xdotool mousemove 530 595 click 1 2>/dev/null" || true
        sleep 1
        # Also try Escape in case the button didn't work
        do_ssh "xdotool key Escape 2>/dev/null" || true
        sleep 0.5
        echo "  Welcome tour dismiss attempted (attempt ${attempt})"
        # Check if tour is gone by looking for the overview grid
        if do_ssh "xdotool search --name 'Activities' 2>/dev/null | head -1" >/dev/null 2>&1; then
            echo "  Tour dismissed"
            break
        fi
    done
    timer_stop "Dismiss welcome tour"

    # Close overview if open
    timer_start
    do_ssh xdotool keydown super 2>/dev/null || true
    sleep 0.5
    do_ssh xdotool keyup super 2>/dev/null || true
    sleep 2
    timer_stop "Close overview"

    # ─── Start D-Bus service with debug mode ──────────────────────────────
    timer_start
    echo "Starting D-Bus service..."
    # Install dotoolc wrapper (translates dotool commands to xdotool)
    SCRIPT_DIR_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    do_ssh "mkdir -p ~/.local/bin" || true
    scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} "${SCRIPT_DIR_REAL}/dotoolc-wrapper.sh" ${SSH_USER}@localhost:~/.local/bin/dotoolc 2>/dev/null || true
    do_ssh "chmod +x ~/.local/bin/dotoolc" || true
    do_ssh "mkdir -p /run/user/\$(id -u) && mkfifo /run/user/\$(id -u)/dotool-pipe 2>/dev/null || true" || true
    # Copy test audio file to VM
    TEST_AUDIO="${SCRIPT_DIR_REAL}/../fixtures/test-audio.wav"
    if [[ -f "${TEST_AUDIO}" ]]; then
        scp -i "${SSH_KEY}" ${SCP_OPTS} -P ${SSH_PORT} "${TEST_AUDIO}" ${SSH_USER}@localhost:/tmp/test-audio.wav 2>/dev/null || true
    fi
    do_ssh "export PATH=\$HOME/.local/bin:\$PATH; export XDG_RUNTIME_DIR=/run/user/\$(id -u); export DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}; export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav; export PYTHONPATH=~/voice_to_text/..; cd ~; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &"
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
echo "=== QEMU E2E Snapshot Tests ==="
echo ""

# ─── State 1: Desktop with extension indicator ─────────────────────────
timer_start
echo "1. Desktop with extension indicator"
snapshot_test "snapshot-desktop-indicator" "desktop with mic icon in top bar"
timer_stop "Screenshot: desktop"

# ─── State 2: Preferences dialog ──────────────────────────────────────
timer_start
echo ""
echo "2. Preferences dialog"
# Ensure overview is closed first
do_ssh xdotool keydown super 2>/dev/null || true
sleep 0.3
do_ssh xdotool keyup super 2>/dev/null || true
sleep 1

# Open preferences dialog with retries
PREFS_OPENED=false
for attempt in 1 2 3 4 5; do
    do_ssh "gnome-extensions prefs voice-to-text@happytomatoe.com &" 2>/dev/null || true
    sleep 3
    # Try multiple search patterns — dialog title varies across GNOME versions
    PREFS_WID=$(do_ssh "xdotool search --name 'Voice' 2>/dev/null | head -1" 2>/dev/null || true)
    if [[ -z "${PREFS_WID}" ]]; then
        PREFS_WID=$(do_ssh "xdotool search --name 'Extension' 2>/dev/null | head -1" 2>/dev/null || true)
    fi
    if [[ -n "${PREFS_WID}" ]]; then
        do_ssh "xdotool windowactivate ${PREFS_WID} 2>/dev/null" || true
        do_ssh "xdotool windowraise ${PREFS_WID} 2>/dev/null" || true
        sleep 1
        PREFS_OPENED=true
        echo "  Preferences dialog opened (attempt ${attempt})"
        break
    fi
    echo "  Retry ${attempt}..."
    sleep 1
done

if [[ "${PREFS_OPENED}" == "true" ]]; then
    snapshot_test "snapshot-prefs" "preferences dialog"
    # Close preferences
    do_ssh "xdotool keydown alt; xdotool key F4; xdotool keyup alt" 2>/dev/null || true
    sleep 2
    # Verify dialog is closed
    PREFS_STILL_OPEN=$(do_ssh "xdotool search --name 'Voice' 2>/dev/null | head -1" 2>/dev/null || true)
    if [[ -n "${PREFS_STILL_OPEN}" ]]; then
        do_ssh "xdotool keydown alt; xdotool key F4; xdotool keyup alt" 2>/dev/null || true
        sleep 1
    fi
else
    echo "  Skipping (preferences window not found after 5 attempts)"
fi
timer_stop "Screenshot: preferences"

# ─── State 3: Recording state ─────────────────────────────────────────
timer_start
echo ""
echo "3. Recording state"

# Start recording — service uses output_method:"type" to type the result
do_ssh "gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StartRecording '{\"provider\": \"deepgram\", \"language\": \"en\", \"mode\": \"batch\", \"device\": \"__system_default__\", \"output_method\": \"type\", \"stop_timeout\": 300}'" 2>/dev/null || true

# Wait for audio simulation (3 seconds in debug mode)
sleep 4
snapshot_test "snapshot-recording" "recording state with audio level"
snapshot_test "snapshot-recording-indicator" "recording indicator" "crop:100x30+1100+0"
timer_stop "Screenshot: recording"

# ─── State 4: Transcription result ────────────────────────────────────
timer_start
echo ""
echo "4. Transcription result"

# Wait for the D-Bus service to type the transcription via xdotool
# The service handles typing — we just wait and screenshot
echo -n "  Waiting for service to type transcription"
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
fi

# The service typed the result — take a screenshot of whatever is on screen
snapshot_test "snapshot-transcription" "transcription typed by service"
timer_stop "Screenshot: transcription"

# ─── Results ────────────────────────────────────────────────────────────
echo ""
echo "========================================="

# ─── Timing summary ───────────────────────────────────────────────────
SCRIPT_ELAPSED=$(( ($(date +%s%N) - SCRIPT_START) / 1000000 ))
echo ""
echo "=== Timing Summary ==="
printf "  %-42s %3d.%01ds\n" "Total" "$((SCRIPT_ELAPSED / 1000))" "$(( (SCRIPT_ELAPSED % 1000) / 100 ))"
echo ""

if [[ "${UPDATE_MODE}" == "true" ]]; then
    echo "Reference images saved to: ${REFERENCES_DIR}"
    echo "Review the screenshots and commit them."
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
