---
name: e2e-setup
description: Set up the QEMU-based E2E test environment for the voice-to-text GNOME extension. Use when creating the base VM image, installing prerequisites, or performing first-time E2E setup.
---

# E2E Setup

Set up and maintain the QEMU-based E2E test environment for the voice-to-text GNOME extension.

## Prerequisites

- **OS**: Fedora (Silverblue/Workstation) or similar Linux with KVM support
- **CPU**: Intel/AMD with VT-x/AMD-V virtualization support
- **RAM**: 4GB+ free for the VM
- **Disk**: 10GB+ free for VM images
- **Packages**: QEMU/KVM, libguestfs-tools (for `virt-customize`)

### Install System Dependencies

```bash
# Fedora Silverblue (requires reboot after install)
just qemu-install

# Fedora Workstation
sudo dnf install -y qemu-kvm libvirt virt-install qemu-img libguestfs-tools
```

### Install Development Dependencies

```bash
# Install npm deps (lefthook) and set up git hooks
just setup

# Sync Python dev dependencies
just dev-sync

# Install bun (for E2E TypeScript tests)
curl -fsSL https://bun.sh/install | bash
```

## Quick Start: Download Pre-built Image

The fastest way to get started is to download the pre-built golden image with all dependencies from Filen:

```bash
cd e2e/qemu-images

# Download golden image + SSH keys from Filen
filen download /golden-gnome-deps.qcow2 .
filen download /id_ed25519 .
filen download /id_ed25519.pub .
chmod 600 id_ed25519

# The image includes:
# - Fedora 44 + GNOME Shell
# - GDM with auto-login configured
# - gnome-terminal, ghostty, dotool
# - Python packages (httpx, dbus-next, numpy, etc.)
# - uv package manager
# - SSH keys for testuser access
```

**Important:** The SSH keys (`id_ed25519`, `id_ed25519.pub`) on Filen are the ones baked into the golden image. You MUST use these keys — generating new ones will cause SSH auth failures.

### Using the Downloaded Image

```bash
# Just run it — uses --snapshot by default (~40s after first boot)
just e2e
```

## Base Image Setup

### Golden Image Approach (Recommended)

Build a golden image once with GDM pre-installed. Use COW overlays for each test run.

#### Step 1: Download Fedora Cloud Base Image

```bash
cd e2e/qemu-images
wget https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2 -O base.qcow2
```

#### Step 2: Create SSH Key Pair

```bash
ssh-keygen -t ed25519 -f id_ed25519 -N ""
```

#### Step 3: Create Cloud-init ISO

```bash
mkdir -p cloud-init
cat > cloud-init/user-data << 'EOF'
#cloud-config
users:
  - name: testuser
    ssh-authorized-keys:
      - ssh-ed25519 AAAAC3... your-key
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: wheel,input
    shell: /bin/bash

password: ''
chpasswd: { expire: false }

package_update: true
packages:
  - gnome-shell
  - gdm
  - dotool
  - tmux
  - python3

runcmd:
  - systemctl set-default graphical.target
EOF

genisoimage -output cloud-init.iso -volid cidata -joliet -rock cloud-init/user-data
```

#### Step 4: Build Golden Image

```bash
# Create overlay from base
qemu-img create -f qcow2 -b base.qcow2 -F qcow2 golden-gnome.qcow2

# Boot with cloud-init ISO
qemu-system-x86_64 \
  -enable-kvm -cpu host -m 4096 -smp 2 \
  -drive file=golden-gnome.qcow2,format=qcow2,if=virtio \
  -device virtio-vga \
  -spice port=5900,disable-ticketing=on \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-pci,netdev=net0 \
  -device virtio-rng-pci \
  -cdrom cloud-init.iso \
  -no-reboot &

# Wait for SSH (cloud-init installs packages)
for i in $(seq 1 60); do
  ssh -o ConnectTimeout=3 -i id_ed25519 -p 2222 testuser@localhost 'echo ready' && break
  sleep 5
done

# Verify GDM is running
ssh -i id_ed25519 -p 2222 testuser@localhost 'systemctl is-active gdm'

# Shutdown and save
ssh -i id_ed25519 -p 2222 testuser@localhost 'sudo shutdown -h now'
sleep 10
pkill -f qemu-system
```

#### Step 5: Use Golden Image for Tests

```bash
# Create fresh overlay (instant)
qemu-img create -f qcow2 -b golden-gnome.qcow2 -F qcow2 overlay.qcow2

# Boot VM
qemu-system-x86_64 \
  -enable-kvm -m 4096 -smp 2 \
  -drive file=overlay.qcow2,format=qcow2,if=virtio \
  -device virtio-vga \
  -spice port=5900,disable-ticketing=on \
  ...

# Delete when done
rm overlay.qcow2
```

### Alternative: virt-customize (Needs sudo)

Bakes SSH key + GDM + packages offline. One-time setup.

```bash
sudo dnf install -y libguestfs-tools
sudo virt-customize \
  -a base.qcow2 \
  --format qcow2 \
  --run-command 'useradd -m -G wheel,input testuser' \
  --run-command 'echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers' \
  --ssh-inject testuser:file:id_ed25519.pub \
  --install gnome-shell,gdm,dotool,tmux,python3 \
  --run-command 'systemctl set-default graphical.target' \
  --selinux-relabel
```

**Key points:**
- `useradd` must come before `--ssh-inject`
- This works on first boot without cloud-init

## Running E2E Tests

### Update Reference Screenshots

```bash
cd e2e && bun run e2e.ts --update
# or
just qemu-e2e-update-ts
```

### Run Tests

```bash
cd e2e && bun run e2e.ts
# or
just e2e
```

### Manual VM Access

```bash
# Start VM for manual debugging
just qemu-e2e-vm

# SSH directly
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost

# Connect with SPICE (visual)
spicy -h localhost -p 5900
# or
remote-viewer spice://localhost:5900
```

### Empty Password (Optional)

For convenience, set empty password for testuser:

```bash
# During golden image build
ssh -i id_ed25519 -p 2222 testuser@localhost 'echo "testuser:" | sudo chpasswd'

# Or in cloud-init.yaml
password: ''
chpasswd: { expire: false }
```

Safe for local QEMU VMs with user-mode networking (no external access).

## Troubleshooting

### SSH Authentication Failed

If SSH hangs at banner exchange or "Connection timed out during banner exchange":
- The image doesn't have the testuser with your SSH key
- If using `virt-customize`: re-run Step 4 to inject the key
- If using cloud-init ISO: delete the overlay (`rm -f e2e/qemu-images/overlay.qcow2`) so cloud-init runs again
- Cloud-init does NOT re-run on subsequent boots — the overlay must be recreated fresh

### VM Won't Boot

```bash
lsmod | grep kvm                    # Check KVM available
qemu-system-x86_64 --version        # Check QEMU version
ls -la e2e/qemu-images/base*.qcow2  # Check base image exists
```

### SSH Connection Fails

```bash
ps aux | grep qemu                  # Check VM running
netstat -tlnp | grep 2222           # Check SSH port
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost echo ok
```

### Tests Hang at GDM Login

```bash
cat e2e/qemu-images/serial.log                           # Check VM console
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost "systemctl status gdm"
```

### GDM Not Found

If you see `Failed to restart gdm.service: Unit gdm.service not found`:
- The base image doesn't have GDM installed
- The E2E code will auto-install it, but first run will be slower (~2min)
- Better: use `virt-customize` to pre-install GDM (see Base Image Setup Option 1)

## Key Learnings

1. **Cloud-init runs on first boot only** — when booting with `-cdrom cloud-init.iso`. It does NOT re-run on subsequent boots.
2. **`virt-customize` needs sudo** — but it's the fastest approach (offline, one-time setup)
3. **Cloud-init ISO is the no-sudo alternative** — but GDM must be installed at runtime
4. **`useradd` must come before `--ssh-inject`** — libguestfs requires the target user to exist
5. **tmux must be inside gnome-terminal** — dotool types into focused window
6. **Activities must be dismissed** — Otherwise dotool types into search bar
7. **GNOME 50 removed `St.Spinner`** — Extension uses custom GObject class instead
