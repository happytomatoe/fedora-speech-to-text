#!/usr/bin/env bash
# Clone a specific branch into a fresh directory and run the POC test.
# Usage: scripts/checkout-and-test.sh <branch> [parent_dir] [golden_image_src]
#
#   branch             the branch to check out (required)
#   parent_dir         where to create the new clone (default: $HOME)
#   golden_image_src   path to a pre-baked golden image, or a directory
#                      containing golden-gnome-deps-autologin.qcow2
#                      (default: $HOME/git/fedora-speech-to-text/e2e/qemu-images)
#
# If golden image is not present, prompts to run `just prepare-img` to bake it
# from the base image (requires sudo + a base golden-gnome-deps.qcow2).
#
# Exits non-zero on any failure.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <branch> [parent_dir] [golden_image_src]"
    echo
    echo "Example:"
    echo "  $0 feat/openqa"
    echo "  $0 feat/openqa /tmp /path/to/golden-gnome-deps-autologin.qcow2"
    exit 1
fi

BRANCH="${1}"
PARENT_DIR="${2:-$HOME}"
GOLDEN_SRC="${3:-$HOME/git/fedora-speech-to-text/e2e/qemu-images}"

REPO_URL="https://github.com/happytomatoe/fedora-speech-to-text.git"
CLONE_DIR="${PARENT_DIR}/fedora-speech-to-text"
POC_DIR="${CLONE_DIR}/e2e/openqa-poc"
QEMU_DIR="${CLONE_DIR}/e2e/qemu-images"

echo "=== checkout-and-test.sh ==="
echo "  branch:  ${BRANCH}"
echo "  parent:  ${PARENT_DIR}"
echo "  clone:   ${CLONE_DIR}"
echo "  golden:  ${GOLDEN_SRC}"
echo

# Sanitize branch name for the clone dir name suffix
BRANCH_SLUG=$(echo "${BRANCH}" | tr '/' '-')
CLONE_DIR="${PARENT_DIR}/fedora-speech-to-text-${BRANCH_SLUG}"
POC_DIR="${CLONE_DIR}/e2e/openqa-poc"
QEMU_DIR="${CLONE_DIR}/e2e/qemu-images"

# 1. Clone
if [ -d "${CLONE_DIR}" ]; then
    echo "ERROR: ${CLONE_DIR} already exists. Remove it or pass a different parent_dir."
    exit 1
fi
echo "[1/6] Cloning ${BRANCH}..."
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${CLONE_DIR}" >&2
cd "${CLONE_DIR}"
git log -1 --oneline
echo

# 2. Ensure distri is in place
echo "[2/6] Checking /tmp/os-autoinst-distri-fedora..."
if [ ! -d /tmp/os-autoinst-distri-fedora/lib ]; then
    echo "      cloning..."
    sudo git clone --depth 1 https://github.com/os-autoinst/os-autoinst-distri-fedora /tmp/os-autoinst-distri-fedora >&2
else
    echo "      present."
fi

# 3. Stage golden image (or bake it)
echo "[3/6] Staging golden image..."
mkdir -p "${QEMU_DIR}"
COPIED=0
if [ -f "${GOLDEN_SRC}/golden-gnome-deps-autologin.qcow2" ]; then
    cp "${GOLDEN_SRC}/golden-gnome-deps-autologin.qcow2" "${QEMU_DIR}/"
    if [ -f "${GOLDEN_SRC}/golden-gnome-deps.qcow2" ]; then
        cp "${GOLDEN_SRC}/golden-gnome-deps.qcow2" "${QEMU_DIR}/"
    fi
    echo "      copied from ${GOLDEN_SRC}."
    COPIED=1
elif [ -f "${GOLDEN_SRC}" ] && [[ "${GOLDEN_SRC}" == *.qcow2 ]]; then
    cp "${GOLDEN_SRC}" "${QEMU_DIR}/golden-gnome-deps-autologin.qcow2"
    echo "      copied single image from ${GOLDEN_SRC}."
    COPIED=1
fi

if [ "${COPIED}" = "0" ]; then
    if [ -t 0 ] && [ -t 1 ]; then
        echo "      no pre-baked image found."
        if [ -f "${GOLDEN_SRC}/golden-gnome-deps.qcow2" ]; then
            echo "      found a base image at ${GOLDEN_SRC}/golden-gnome-deps.qcow2."
        else
            echo "      no base image either. Provision it from the README's recipe."
            exit 1
        fi
        read -rp "      Run 'just prepare-img' to bake the password into a copy? [y/N] " ans
        case "${ans}" in
            [Yy]|[Yy][Ee][Ss]) ;;
            *) echo "Aborted."; exit 1 ;;
        esac
    else
        echo "ERROR: no golden image at ${GOLDEN_SRC}"
        echo "       (non-interactive mode, refusing to run prepare-img without confirmation)"
        exit 1
    fi
    cp "${GOLDEN_SRC}/golden-gnome-deps.qcow2" "${QEMU_DIR}/"
    cd "${POC_DIR}"
    just prepare-img
fi

# 4. Check KVM
echo "[4/6] Checking /dev/kvm..."
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "ERROR: /dev/kvm not accessible. Run: sudo usermod -aG kvm \$USER  (and re-login)"
    exit 1
fi
echo "      OK."

# 5. Verify the justfile recipe exists (README often mentions old names)
echo "[5/6] Verifying justfile recipes..."
cd "${POC_DIR}"
if ! just --evaluate openqa-test >/dev/null 2>&1; then
    echo "WARN: no 'openqa-test' recipe in justfile. Available recipes:"
    just --list >&2
    echo "      Update scripts/cold-test.sh to match the actual recipe name."
fi

# 6. Run the test
echo "[6/6] Running the test..."
echo
just openqa-test
