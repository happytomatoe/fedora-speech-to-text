#!/usr/bin/env bash
# Set up the Ubuntu 26.04 E2E environment for the unified e2e/ suite.
# Proven CI recipe (dev.to "qemu-kvm-ubuntu-minimal-cloudimg-ssh"): download
# the pinned resolute cloud image and build a cloud-init seed ISO — user, SSH
# key, packages and GDM autologin are applied AT BOOT by cloud-init, not baked
# into the image. No virt-customize, no golden image.
#
# Idempotent: skips steps whose outputs already exist.
set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$SUITE_DIR/ubuntu-2604-cloud.qcow2"
SEED="$SUITE_DIR/qemu-images/ubuntu-seed.iso"
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

# 3. Cloud-init seed ISO (user-data + meta-data)
if [ ! -f "$SEED" ]; then
  echo "Building cloud-init seed ISO..."
  TMPD="$(mktemp -d)"
  trap 'rm -rf "$TMPD"' EXIT
  PUB="$(cat "$KEY.pub")"
  cat > "$TMPD/user-data" <<EOF
#cloud-config
users:
  - name: testuser
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    groups: [sudo]
    shell: /bin/bash
    ssh_authorized_keys:
      - $PUB
ssh_pwauth: false
packages:
  - gdm3
  - gnome-shell
  - gnome-session
  - glib2.0-bin
  - mesa-utils
  - libgl1-mesa-dri
  - libgbm1
  - dconf-gsettings-backend
  - gsettings-desktop-schemas
  - libportaudio2
  - tmux
  - dbus
  - curl
  - pulseaudio
  - pulseaudio-utils
runcmd:
  - mkdir -p /etc/gdm3
  - printf '[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=testuser\nWaylandEnable=true\n' > /etc/gdm3/custom.conf
  # gnome-session #190: profile state from a previous run can abort the session
  # on next autologin; wipe it before GDM starts the session
  - sh -c 'rm -rf ~testuser/.config/gnome-* ~testuser/.cache/gnome-shell ~testuser/.local/share/gnome-shell ~testuser/.local/state/gnome-shell'
  - sh -c 'echo cloud-init-ready > /var/tmp/cloud-init-ready'
EOF
  cat > "$TMPD/meta-data" <<EOF
instance-id: e2e-ubuntu-2604
local-hostname: e2e-ubuntu
EOF
  if command -v cloud-localds >/dev/null; then
    cloud-localds "$SEED" "$TMPD/user-data" "$TMPD/meta-data"
  else
    # genisoimage fallback: volume label "cidata" is what cloud-init looks for
    genisoimage -output "$SEED" -volid cidata -joliet -rock "$TMPD/user-data" "$TMPD/meta-data"
  fi
fi
ls -la "$SEED"

echo "Ubuntu 26.04 E2E environment ready (raw image + seed ISO)"
