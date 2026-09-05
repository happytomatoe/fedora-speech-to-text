#!/usr/bin/env bash
# Set up the Ubuntu 26.04 E2E parity VM: download cloud image, inject user +
# SSH key + the exact CI apt package list (from poc-ubuntu-26-04-debug.yml),
# and prepare for QEMU boot.
#
# Idempotent: skips steps whose outputs already exist.
set -euo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="$VM_DIR/golden-ubuntu-2604.qcow2"
BASE="$VM_DIR/ubuntu-2604-cloud.qcow2"
KEY="$VM_DIR/id_ed25519"

# 1. Download the cloud image (resolute = 26.04)
if [ ! -f "$BASE" ]; then
  echo "Downloading Ubuntu 26.04 cloud image..."
  wget -q -O "$BASE" \
    "https://cloud-images.ubuntu.com/daily/server/resolute/current/resolute-server-cloudimg-amd64.img"
fi
ls -la "$BASE"

# 2. SSH key
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "e2e-vm"
fi

# 3. Customize: user, key, CI package list (mirrors poc-ubuntu-26-04-debug.yml
#    apt install steps 1:1), GDM auto-login
if [ ! -f "$IMAGE" ]; then
  echo "Customizing image (virt-customize)..."
  cp "$BASE" "$IMAGE"
  # Cloud image disk is too small for GNOME (~600MB free); grow to 20G
  qemu-img resize "$IMAGE" 20G
  virt-customize -a "$IMAGE" \
    --run-command 'growpart /dev/sda 1 || growpart /dev/vda 1 || true' \
    --run-command 'resize2fs /dev/sda1 || resize2fs /dev/vda1 || true' \
    --run-command 'useradd -m -s /bin/bash testuser' \
    --run-command 'echo "testuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/testuser' \
    --ssh-inject testuser:file:"$KEY.pub" \
    --run-command 'apt-get update' \
    --install 'gnome-shell,gnome-shell-common,gnome-session,glib2.0-bin,dbus,mesa-utils,libgl1-mesa-dri,libgbm1,dconf-gsettings-backend,gsettings-desktop-schemas,libportaudio2,curl,pulseaudio,pulseaudio-utils' \
    --run-command 'systemctl set-default graphical.target' \
    --run-command 'mkdir -p /etc/gdm3' \
    --upload /dev/stdin:/etc/gdm3/custom.conf <<'GDMEOF'
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=testuser
WaylandEnable=true
GDMEOF
    --run-command 'rm -f /etc/ssh/ssh_host_*; ssh-keygen -A' \
    --run-command 'systemctl mask ssh.socket && systemctl enable ssh.service' \
    --run-command 'rm -f /etc/systemd/system/ssh.service.requires/ssh.socket'
fi
ls -la "$IMAGE"
echo "VM image ready: $IMAGE"
