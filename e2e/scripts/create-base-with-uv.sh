#!/bin/bash
# Create a new base image with uv and tmux pre-installed.
# This image is based on the existing optimized base.qcow2
# and adds uv for faster Python dependency installation.
#
# Usage: ./create-base-with-uv.sh
# Output: e2e/qemu-images/base-with-uv.qcow2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="${SCRIPT_DIR}/../qemu-images"
SOURCE_IMAGE="${VM_DIR}/base.qcow2"
OUTPUT_IMAGE="${VM_DIR}/base-with-uv.qcow2"

if [[ ! -f "$SOURCE_IMAGE" ]]; then
    echo "Error: Source image not found: $SOURCE_IMAGE"
    echo "Run optimize-vm-image.sh first to create the optimized base."
    exit 1
fi

if [[ -f "$OUTPUT_IMAGE" ]]; then
    echo "Output image already exists: $OUTPUT_IMAGE"
    echo "Delete it first or use a different name."
    exit 1
fi

echo "=== Creating base image with uv ==="
echo "Source: $SOURCE_IMAGE"
echo "Output: $OUTPUT_IMAGE"

# Check if virt-customize is available
if ! command -v virt-customize &>/dev/null; then
    echo "Error: virt-customize not found. Install with:"
    echo "  sudo dnf install -y libguestfs-tools"
    exit 1
fi

# Create overlay from source
echo "Creating overlay..."
qemu-img create -f qcow2 -b "$SOURCE_IMAGE" -F qcow2 "$OUTPUT_IMAGE" >/dev/null

# Install uv in the image
echo "Installing uv..."
virt-customize -a "$OUTPUT_IMAGE" \
    --run-command 'curl -LsSf https://astral.sh/uv/install.sh | sh' \
    --run-command 'ln -sf /root/.local/bin/uv /usr/local/bin/uv' \
    --selinux-relabel 2>&1

echo ""
echo "=== Base image with uv created ==="
echo "Image: $OUTPUT_IMAGE"
echo ""
echo "Features:"
echo "  - tmux (from base.qcow2)"
echo "  - uv (Python package manager)"
echo "  - cloud-init disabled"
echo "  - UseDNS no in sshd"
echo "  - NetworkManager-wait-online disabled"
echo ""
echo "To use: Update e2e/lib/vm.ts to use this image as baseImage"
