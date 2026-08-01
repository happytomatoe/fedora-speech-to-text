#!/bin/bash
# Optimize the QEMU VM image for faster E2E testing.
# Uses guestfish to modify the image without mounting.
#
# What this does:
# 1. Disables cloud-init (saves ~10-15 seconds)
# 2. Sets UseDNS no in sshd_config (saves ~2-5 seconds)
# 3. Disables NetworkManager-wait-online (saves ~5 seconds)
#
# Usage: ./optimize-vm-image.sh [path-to-base.qcow2]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="${SCRIPT_DIR}/../qemu-images"
BASE_IMAGE="${1:-${VM_DIR}/base.qcow2}"

if [[ ! -f "$BASE_IMAGE" ]]; then
    echo "Error: Base image not found: $BASE_IMAGE"
    exit 1
fi

# Check if virt-customize is available
if ! command -v virt-customize &>/dev/null; then
    echo "Error: virt-customize not found. Install with:"
    echo "  sudo dnf install -y libguestfs-tools"
    exit 1
fi

echo "=== Optimizing VM image for faster boot ==="
echo "Image: $BASE_IMAGE"

# Backup the original
BACKUP_IMAGE="${BASE_IMAGE}.backup"
if [[ ! -f "$BACKUP_IMAGE" ]]; then
    echo "Creating backup: $BACKUP_IMAGE"
    cp "$BASE_IMAGE" "$BACKUP_IMAGE"
fi

# Use guestfish to modify the image
echo "Modifying image with guestfish..."

echo "Using virt-customize to apply optimizations..."

virt-customize -a "$BASE_IMAGE" \
    --run-command 'touch /etc/cloud/cloud-init.disabled' \
    --run-command 'grep -q "^#*UseDNS" /etc/ssh/sshd_config && sed -i "s/^#*UseDNS .*/UseDNS no/" /etc/ssh/sshd_config || echo "UseDNS no" >> /etc/ssh/sshd_config' \
    --run-command 'rm -f /etc/systemd/system/network-online.target.wants/NetworkManager-wait-online.service' \
    --install tmux \
    --selinux-relabel 2>&1

echo ""
echo "=== Optimization complete ==="
echo ""
echo "Optimizations applied:"
echo "  - cloud-init disabled (saves ~10-15s)"
echo "  - UseDNS no set in sshd (saves ~2-5s)"
echo "  - NetworkManager-wait-online disabled (saves ~5s)"
echo ""
echo "Original image backed up to: $BACKUP_IMAGE"
echo "To restore: cp $BACKUP_IMAGE $BASE_IMAGE"
