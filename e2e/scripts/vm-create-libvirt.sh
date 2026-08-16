#!/bin/bash
# Create a libvirt VM from the golden image.
# Uses qemu:///session (user-mode) — no root needed.
#
# Usage: ./vm-create-libvirt.sh [vm-name]
# Default vm-name: vtt-e2e

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="${SCRIPT_DIR}/../qemu-images"
GOLDEN_IMAGE="${VM_DIR}/golden-gnome-deps.qcow2"
SSH_KEY="${VM_DIR}/id_ed25519"
SSH_USER="testuser"

VM_NAME="${1:-vtt-e2e}"
VIRSH="virsh -c qemu:///session"
CACHE_DIR="${HOME}/.local/share/vtt-e2e-testing"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*" >&2; }
log_ok() { echo -e "${GREEN}[OK]${NC} $*" >&2; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Check prerequisites
if ! command -v virt-install &>/dev/null; then
    log_error "virt-install not found. Install with:"
    log_error "  Fedora: sudo dnf install -y virt-install"
    log_error "  Ubuntu: sudo apt-get install -y virtinst"
    exit 1
fi

if ! command -v virsh &>/dev/null; then
    log_error "virsh not found. Install with:"
    log_error "  Fedora: sudo dnf install -y libvirt-client"
    log_error "  Ubuntu: sudo apt-get install -y libvirt-clients"
    exit 1
fi

if [[ ! -f "$GOLDEN_IMAGE" ]]; then
    log_error "Golden image not found: $GOLDEN_IMAGE"
    log_error "Run 'just qemu-e2e-setup' first"
    exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
    log_error "SSH key not found: $SSH_KEY"
    log_error "Run 'just qemu-e2e-setup' first"
    exit 1
fi

# Check if VM already exists
if $VIRSH dominfo "$VM_NAME" &>/dev/null; then
    log_warn "VM '$VM_NAME' already exists"
    log_info "Destroy it first with: virsh -c qemu:///session destroy $VM_NAME"
    log_info "Or use: virsh -c qemu:///session undefine $VM_NAME --remove-all-storage"
    exit 1
fi

# Create cache directory
mkdir -p "$CACHE_DIR"

# Create overlay from golden image
OVERLAY="${CACHE_DIR}/${VM_NAME}-overlay.qcow2"
log_info "Creating overlay from golden image..."
qemu-img create -f qcow2 -b "$GOLDEN_IMAGE" -F qcow2 "$OVERLAY" >/dev/null

# Import VM using virt-install
log_info "Importing VM '$VM_NAME' into libvirt..."
virt-install \
    --name "$VM_NAME" \
    --import \
    --memory 8192 \
    --vcpus 4 \
    --disk "path=${OVERLAY},format=qcow2" \
    --os-variant fedora42 \
    --network none \
    --graphics spice,listen=127.0.0.1,port=5930 \
    --video qxl \
    --wait 0

log_ok "VM '$VM_NAME' imported into libvirt"

# Add SSH port forwarding
log_info "Adding SSH port forwarding..."
$VIRSH qemu-monitor-command "$VM hostfwd_add tcp::2222-:22" 2>/dev/null || true

# Start the VM
log_info "Starting VM..."
$VIRSH start "$VM_NAME"

# Wait for SSH
log_info "Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
           -o ConnectTimeout=2 -o BatchMode=yes -o LogLevel=ERROR \
           -i "$SSH_KEY" -p 2222 "${SSH_USER}@localhost" "true" 2>/dev/null; then
        log_ok "SSH ready (${i}s)"
        break
    fi
    sleep 2
done

# Wait for GNOME Shell
log_info "Waiting for GNOME Shell..."
for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
           -o ConnectTimeout=2 -o BatchMode=yes -o LogLevel=ERROR \
           -i "$SSH_KEY" -p 2222 "${SSH_USER}@localhost" \
           "pgrep -x gnome-shell" 2>/dev/null; then
        log_ok "GNOME Shell running (${i}s)"
        break
    fi
    sleep 2
done

# Take initial screenshot
log_info "Taking initial screenshot..."
SCREENSHOT_DIR="${VM_DIR}/screenshots"
mkdir -p "$SCREENSHOT_DIR"
$VIRSH screenshot "$VM_NAME" "${SCREENSHOT_DIR}/initial.ppm" 2>/dev/null || true
convert "${SCREENSHOT_DIR}/initial.ppm" "${SCREENSHOT_DIR}/initial.png" 2>/dev/null || true

log_ok "=== VM '$VM_NAME' ready ==="
log_info "  SSH: ssh -i $SSH_KEY -p 2222 ${SSH_USER}@localhost"
log_info "  Virsh: virsh -c qemu:///session console $VM_NAME"
log_info "  Screenshot: virsh -c qemu:///session screenshot $VM_NAME output.ppm"
log_info ""
log_info "To destroy: virsh -c qemu:///session destroy $VM_NAME && virsh -c qemu:///session undefine $VM_NAME --remove-all-storage"
