#!/usr/bin/env bash
# Run the openQA POC test on the host (no podman).
# Requires: os-autoinst, xorg-x11-server-Xvfb, qemu-kvm, libguestfs-tools-c (or guestfs-tools),
#           and the cloned distri at /tmp/os-autoinst-distri-fedora.
# KVM (/dev/kvm) must be accessible.
set -euo pipefail

POC_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${POC_DIR}/testresults"
XVFB_DISPLAY=":99"
XVFB_SCREEN="1920x1080x24"

if [ ! -d /tmp/os-autoinst-distri-fedora/lib ]; then
    echo "ERROR: clone os-autoinst-distri-fedora first:"
    echo "  git clone --depth 1 https://github.com/os-autoinst/os-autoinst-distri-fedora /tmp/os-autoinst-distri-fedora"
    exit 1
fi

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "ERROR: /dev/kvm not accessible"
    exit 1
fi

# Find the golden image (autologin variant) and the corresponding base image
GOLDEN_DIR=""
for candidate in "${POC_DIR}/../qemu-images" "${POC_DIR}/qemu-images"; do
    if [ -f "${candidate}/golden-gnome-deps-autologin.qcow2" ]; then
        GOLDEN_DIR="${candidate}"
        break
    fi
done

if [ -z "${GOLDEN_DIR}" ]; then
    echo "ERROR: golden-gnome-deps-autologin.qcow2 not found in qemu-images/ or ../qemu-images/"
    echo "Run: just prepare-img   (or copy an existing one from another machine)"
    exit 1
fi

# Generate vars.json from template with absolute paths to this checkout
python3 - <<EOF
import json
with open("${POC_DIR}/vars.template.json") as f:
    vars = json.load(f)
vars["CASEDIR"]    = "${POC_DIR}"
vars["PRODUCTDIR"] = "${POC_DIR}"
vars["HDD_1"]      = "${GOLDEN_DIR}/golden-gnome-deps-autologin.qcow2"
# ISO slot is required by some backends even when empty
vars["ISO_1"]      = ""
vars["ISO_MAXSIZE"] = 20000000000
with open("${POC_DIR}/vars.json", "w") as f:
    json.dump(vars, f, indent=3)
EOF

echo "=== openQA POC: Boot to GNOME Desktop (host) ==="
echo "    CASEDIR: ${POC_DIR}"
echo "    HDD_1:   ${GOLDEN_DIR}/golden-gnome-deps-autologin.qcow2"
rm -rf "${RESULTS_DIR}"
mkdir -p "${RESULTS_DIR}"

# Start Xvfb
rm -f /tmp/.X11-unix/X99
Xvfb "${XVFB_DISPLAY}" -screen 0 "${XVFB_SCREEN}" -ac -nolisten tcp &
XVFB_PID=$!
sleep 2
if ! kill -0 ${XVFB_PID} 2>/dev/null; then
    echo "ERROR: Xvfb failed to start"
    exit 1
fi
echo "Xvfb started (PID: ${XVFB_PID})"
export DISPLAY="${XVFB_DISPLAY}"
export PERL5LIB="/usr/lib/os-autoinst:/tmp/os-autoinst-distri-fedora/lib:${PERL5LIB:-}"

cd "${POC_DIR}"
echo "Running isotovideo..."
timeout 300 isotovideo 2>&1 | tee "${RESULTS_DIR}/isotovideo.log"
ISO_EXIT=${PIPESTATUS[0]}

echo "Stopping Xvfb..."
kill ${XVFB_PID} 2>/dev/null || true
wait ${XVFB_PID} 2>/dev/null || true

echo
echo "=== Test Results ==="
if [ -f "${RESULTS_DIR}/result-login_with_password.json" ]; then
    cat "${RESULTS_DIR}/result-login_with_password.json" | python3 -m json.tool
elif ls "${RESULTS_DIR}"/result-*.json 1>/dev/null 2>&1; then
    cat "${RESULTS_DIR}"/result-*.json | python3 -m json.tool
else
    echo "No result-*.json found. Files in ${RESULTS_DIR}:"
    ls -la "${RESULTS_DIR}/"
fi
echo
echo "POC run complete. Exit code: ${ISO_EXIT}"
exit ${ISO_EXIT}
