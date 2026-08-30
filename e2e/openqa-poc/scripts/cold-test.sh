#!/usr/bin/env bash
# Clone feat/openqa to a fresh directory and run the POC test.
# Usage: scripts/cold-test.sh [parent_dir] [golden_image_src]
#
#   parent_dir         where to create the new clone (default: $HOME)
#   golden_image_src   path to a pre-baked golden-gnome-deps-autologin.qcow2
#                      to copy into the new clone's qemu-images/ (default:
#                      $HOME/git/fedora-speech-to-text/e2e/qemu-images/
#                      if it exists)
#
# Exits non-zero on any failure.

set -euo pipefail

PARENT_DIR="${1:-$HOME}"
GOLDEN_SRC="${2:-$HOME/git/fedora-speech-to-text/e2e/qemu-images}"

REPO_URL="https://github.com/happytomatoe/fedora-speech-to-text.git"
BRANCH="feat/openqa"
CLONE_DIR="${PARENT_DIR}/fedora-speech-to-text"
POC_DIR="${CLONE_DIR}/e2e/openqa-poc"
QEMU_DIR="${CLONE_DIR}/e2e/qemu-images"

echo "=== cold-test.sh ==="
echo "  parent:  ${PARENT_DIR}"
echo "  clone:   ${CLONE_DIR}"
echo "  branch:  ${BRANCH}"
echo "  golden:  ${GOLDEN_SRC}"
echo

# 1. Clone (shallow, branch-only, with the distri submodule we need)
if [ -d "${CLONE_DIR}" ]; then
    echo "ERROR: ${CLONE_DIR} already exists. Remove it or pass a different parent_dir."
    exit 1
fi
echo "[1/5] Cloning ${BRANCH}..."
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${CLONE_DIR}" >&2
echo "      done."

# 2. Ensure the os-autoinst distri is in place (required by run-host.sh)
echo "[2/5] Checking /tmp/os-autoinst-distri-fedora..."
if [ ! -d /tmp/os-autoinst-distri-fedora/lib ]; then
    echo "      not found; cloning..."
    sudo git clone --depth 1 https://github.com/os-autoinst/os-autoinst-distri-fedora /tmp/os-autoinst-distri-fedora >&2
else
    echo "      present."
fi

# 3. Stage the golden image
echo "[3/5] Staging golden image at ${QEMU_DIR}/..."
mkdir -p "${QEMU_DIR}"
if [ -f "${GOLDEN_SRC}/golden-gnome-deps-autologin.qcow2" ]; then
    cp "${GOLDEN_SRC}/golden-gnome-deps-autologin.qcow2" "${QEMU_DIR}/"
    if [ -f "${GOLDEN_SRC}/golden-gnome-deps.qcow2" ]; then
        cp "${GOLDEN_SRC}/golden-gnome-deps.qcow2" "${QEMU_DIR}/"
    fi
    echo "      copied from ${GOLDEN_SRC}."
elif [ -f "${GOLDEN_SRC}" ] && [[ "${GOLDEN_SRC}" == *.qcow2 ]]; then
    cp "${GOLDEN_SRC}" "${QEMU_DIR}/golden-gnome-deps-autologin.qcow2"
    echo "      copied single image from ${GOLDEN_SRC}."
else
    echo "ERROR: golden image not found at ${GOLDEN_SRC}"
    echo "       Pass an explicit path as the second arg, or run: just prepare-img"
    exit 1
fi

# 4. Check KVM
echo "[4/5] Checking /dev/kvm..."
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "ERROR: /dev/kvm not accessible. Run: sudo usermod -aG kvm \$USER  (and re-login)"
    exit 1
fi
echo "      OK."

# 5. Run the test
echo "[5/5] Running just openqa-test..."
echo
cd "${POC_DIR}"
just openqa-test
