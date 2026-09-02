#!/usr/bin/env bash
# Set up the Ubuntu 26.04 E2E environment for the unified e2e/ suite:
# download the pinned resolute cloud image, inject user + SSH key + the exact
# CI apt package list, and prepare for QEMU boot (golden image).
#
# Idempotent: skips steps whose outputs already exist.
set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="$SUITE_DIR/golden-ubuntu-2604.qcow2"
BASE="$SUITE_DIR/ubuntu-2604-cloud.qcow2"
KEY="$SUITE_DIR/id_ed25519"

# 1. Download the cloud image (resolute = 26.04) — same URL as CI
if [ ! -f "$BASE" ]; then
  echo "Downloading Ubuntu 26.04 cloud image..."
  wget -q -O "$BASE" \
    "https://cloud-images.ubuntu.com/daily/server/resolute/current/resolute-server-cloudimg-amd64.img"
fi
ls -la "$BASE"

# 2. SSH key
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "e2e-ubuntu"
fi

# 3. Customize: user, key, CI package list, GDM auto-login, 20G disk
if [ ! -f "$IMAGE" ]; then
  echo "Customizing image (virt-customize)..."
  cp "$BASE" "$IMAGE"
  qemu-img resize "$IMAGE" 20G
  # direct backend: passt networking fails on GitHub Actions runners
  export LIBGUESTFS_BACKEND=direct
  virt-customize -a "$IMAGE" \
    --run-command 'growpart /dev/sda 1 || growpart /dev/vda 1 || true' \
    --run-command 'resize2fs /dev/sda1 || resize2fs /dev/vda1 || true' \
    --run-command 'useradd -m -s /bin/bash testuser' \
    --run-command 'echo "testuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/testuser' \
    --ssh-inject testuser:file:"$KEY.pub" \
    --run-command 'apt-get update' \
    --install 'gdm3,gnome-shell,gnome-session,glib2.0-bin,mesa-utils,libgl1-mesa-dri,libgbm1,dconf-gsettings-backend,gsettings-desktop-schemas,libportaudio2,tmux,dbus,curl,pulseaudio,pulseaudio-utils' \
    --run-command 'mkdir -p /etc/gdm3 && printf "[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=testuser\nWaylandEnable=true\n" > /etc/gdm3/custom.conf' \
    --firstboot-command 'systemctl restart gdm || true'
  rm -f "$IMAGE".*
fi

echo "Golden Ubuntu image ready: $IMAGE"
