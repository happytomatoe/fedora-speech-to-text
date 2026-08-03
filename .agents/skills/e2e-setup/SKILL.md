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

### Option 1: Download Pre-built Image (Recommended)

```bash
cp /path/to/base-with-uv.qcow2 e2e/qemu-images/
```

### Option 2: Create Base Image from Scratch

#### Step 1: Download Fedora Cloud Image

```bash
cd e2e/qemu-images
wget https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2 -O base.qcow2
```

#### Step 2: Create SSH Key Pair

```bash
ssh-keygen -t ed25519 -f e2e/qemu-images/id_ed25519 -N ""
```

#### Step 3: Install GNOME and Customize Image

**This is the critical step** — use `virt-customize` to inject the SSH key directly into the image (no cloud-init needed):

```bash
sudo dnf install -y libguestfs-tools

sudo virt-customize \
  -a e2e/qemu-images/base.qcow2 \
  --format qcow2 \
  --run-command 'useradd -m -G wheel,input testuser' \
  --run-command 'echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers' \
  --ssh-inject testuser:file:e2e/qemu-images/id_ed25519.pub \
  --install gnome-shell,gdm,dotool,tmux,python3 \
  --run-command 'systemctl set-default graphical.target' \
  --selinux-relabel
```

**Key points:**
- `useradd` must come before `--ssh-inject` (libguestfs requires the target user to exist)
- `--ssh-inject` adds the public key to `~testuser/.ssh/authorized_keys`
- This works on first boot without cloud-init

#### Step 4: Optimize the Image

```bash
./e2e/scripts/optimize-vm-image.sh e2e/qemu-images/base.qcow2
```

#### Step 5: Create UV-enhanced Image (Optional but Recommended)

```bash
./e2e/scripts/create-base-with-uv.sh
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
- Re-run Step 3 (virt-customize) to inject the key
- Cloud-init does NOT re-run on subsequent boots — the key must be baked into the image

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

## Key Learnings

1. **Cloud-init does NOT re-run** — SSH key must be baked in via `virt-customize`, not cloud-init
2. **`useradd` must come before `--ssh-inject`** — libguestfs requires the target user to exist
3. **tmux must be inside gnome-terminal** — dotool types into focused window
4. **Activities must be dismissed** — Otherwise dotool types into search bar
5. **GNOME 50 removed `St.Spinner`** — Extension uses custom GObject class instead
