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

## Base Image Setup

### Option 1: virt-customize (Recommended — needs sudo)

This bakes SSH key + GDM + packages into the image offline. One-time setup, fastest E2E runs.

```bash
cd e2e/qemu-images

# Step 1: Download Fedora Cloud Image
wget https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2 -O base.qcow2

# Step 2: Create SSH Key Pair
ssh-keygen -t ed25519 -f id_ed25519 -N ""

# Step 3: Install dependencies
sudo dnf install -y libguestfs-tools

# Step 4: Customize image (user + SSH key + GDM + packages)
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
- `useradd` must come before `--ssh-inject` (libguestfs requires the target user to exist)
- `--ssh-inject` adds the public key to `~testuser/.ssh/authorized_keys`
- This works on first boot without cloud-init

### Option 2: Cloud-init ISO (No sudo needed)

If you can't use `virt-customize`, boot the VM with the cloud-init ISO. Cloud-init runs on first boot to create the user + SSH key.

```bash
cd e2e/qemu-images

# Download base image + create SSH key (same as Option 1 Steps 1-2)

# Boot with cloud-init ISO (already exists in e2e/qemu-images/cloud-init.iso)
# The E2E test code automatically passes -cdrom cloud-init.iso to QEMU
```

**Limitations:**
- GDM/GNOME Shell must be installed at runtime (adds ~2min to first E2E run)
- Cloud-init does NOT re-run on subsequent boots — the overlay must be recreated fresh each time
- First run is slower; subsequent runs using snapshot restore are fast

### Option 3: Pre-built Image

```bash
cp /path/to/base-with-uv.qcow2 e2e/qemu-images/
```

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
```

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
