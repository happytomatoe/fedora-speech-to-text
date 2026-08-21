#!/usr/bin/env bash
set -euo pipefail

# Setup E2E VM for libvirt (qemu:///session mode)
# Creates a minimal VM definition. The E2E test runner spawns QEMU directly
# with full configuration (network, SPICE, etc.). This definition is used for
# manual VM management via virsh start/stop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_NAME="e2e"
VM_DIR="$SCRIPT_DIR/qemu-images"
BASE_IMAGE="$VM_DIR/golden-gnome-deps.qcow2"
SSH_KEY="$VM_DIR/id_ed25519"
SSH_PORT=2222
SPICE_PORT=5930

# Session-mode libvirt stores images here
LIBVIRT_IMAGES="$HOME/.local/share/libvirt/images"
VOL_PATH="$LIBVIRT_IMAGES/${VM_NAME}.qcow2"

# --- Prerequisites ---
if ! command -v virsh &>/dev/null; then
  echo "❌ virsh not found. Run: just setup-deps"
  exit 1
fi

if [ ! -f "$BASE_IMAGE" ]; then
  echo "❌ Base image not found: $BASE_IMAGE"
  echo "   Run 'just qemu-e2e-setup' to download it."
  exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
  echo "❌ SSH key not found: $SSH_KEY"
  echo "   Run 'just qemu-e2e-setup' to generate it."
  exit 1
fi

# --- Destroy existing VM if running ---
echo "Cleaning up existing VM (if any)..."
virsh -c qemu:///session destroy "$VM_NAME" 2>/dev/null || true
virsh -c qemu:///session undefine "$VM_NAME" 2>/dev/null || true
rm -f "$VOL_PATH"

# --- Copy base image to libvirt images directory ---
mkdir -p "$LIBVIRT_IMAGES"
echo "Copying base image to libvirt storage..."
cp "$BASE_IMAGE" "$VOL_PATH"
echo "  Copied: $VOL_PATH"

# --- Create cloud-init ISO (if missing) ---
CLOUD_INIT="$VM_DIR/cloud-init.iso"
if [ ! -f "$CLOUD_INIT" ]; then
  echo "Creating cloud-init ISO..."
  PUB_KEY=$(cat "$SSH_KEY.pub")
  TEMP_DIR=$(mktemp -d)
  mkdir -p "$TEMP_DIR/cloud-init"
  cat > "$TEMP_DIR/cloud-init/user-data" << CIEOF
#cloud-config
users:
  - name: testuser
    ssh-authorized-keys:
      - $PUB_KEY
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: wheel,input
    shell: /bin/bash

password: ''
chpasswd: { expire: false }

package_update: false
packages: []

runcmd:
  - systemctl set-default graphical.target
CIEOF
  mkisofs -output "$CLOUD_INIT" -volid cidata -joliet -rock "$TEMP_DIR/cloud-init" 2>/dev/null
  rm -rf "$TEMP_DIR"
  echo "  Cloud-init ISO created: $CLOUD_INIT"
fi

# Copy cloud-init ISO to libvirt images directory (SELinux needs svirt_home_t context)
cp "$CLOUD_INIT" "$LIBVIRT_IMAGES/cloud-init.iso" 2>/dev/null || true

# --- Create minimal VM definition ---
# NOTE: Session-mode libvirt can't create network bridges or apply QEMU commandline
# overrides. The E2E test runner manages QEMU directly with full configuration.
# This definition is used for manual VM management (virsh start/stop/destroy).
VM_XML="/tmp/e2e-vm.xml"
cat > "$VM_XML" << XMLEOF
<domain type='qemu'>
  <name>${VM_NAME}</name>
  <memory unit='MiB'>4096</memory>
  <vcpu placement='static'>2</vcpu>
  <os>
    <type arch='x86_64' machine='pc-q35-9.2'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-model'/>
  <clock offset='utc'/>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${VOL_PATH}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='${LIBVIRT_IMAGES}/cloud-init.iso'/>
      <target dev='sda' bus='sata'/>
    </disk>
    <graphics type='spice' port='${SPICE_PORT}' tlsPort='0' autoport='no' listen='127.0.0.1'>
      <listen type='address' address='127.0.0.1'/>
      <image compression='off'/>
    </graphics>
    <video>
      <model type='virtio' heads='1' primary='yes'/>
    </video>
    <memballoon model='none'/>
  </devices>
</domain>
XMLEOF

echo "Creating VM definition..."
virsh -c qemu:///session define "$VM_XML"
rm -f "$VM_XML"

echo ""
echo "✅ VM '${VM_NAME}' created (libvirt definition)"
echo "   NOTE: For E2E tests, the test runner manages QEMU directly."
echo "   This definition is for manual management: virsh -c qemu:///session start ${VM_NAME}"
echo ""
echo "   For E2E tests: just e2e"
echo "   For manual use: virsh -c qemu:///session start ${VM_NAME} && spicy -h localhost -p ${SPICE_PORT}"
