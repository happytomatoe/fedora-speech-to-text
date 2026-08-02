# E2E Test Setup Guide

This guide explains how to set up and run the QEMU-based E2E tests for the voice-to-text GNOME extension.

## Overview

E2E tests verify the GNOME extension end-to-end:
- Boot a QEMU VM with Fedora + GNOME Shell
- Deploy the extension and Python service
- Play a test audio file
- Verify the transcription result matches expected text
- Capture screenshots for visual regression testing

## Prerequisites

### Host System Requirements

- **OS**: Fedora (Silverblue/Workstation) or similar Linux with KVM support
- **CPU**: Intel/AMD with VT-x/AMD-V virtualization support
- **RAM**: 4GB+ free for the VM
- **Disk**: 10GB+ free for VM images
- **Packages**: QEMU/KVM, libguestfs-tools

### Install System Dependencies

```bash
# Fedora Silverblue (requires reboot after install)
just qemu-install

# Fedora Workstation
sudo dnf install -y qemu-kvm libvirt virt-install qemu-img libguestfs-tools

# Ubuntu/Debian
sudo apt install -y qemu-kvm libvirt-daemon-system virtinst qemu-utils libguestfs-tools
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

The E2E tests require a QEMU base image. There are two options:

### Option 1: Download Pre-built Image (Recommended)

If a pre-built image is available from your team:

```bash
# Place the image in the qemu-images directory
cp /path/to/base-with-uv.qcow2 e2e/qemu-images/
```

### Option 2: Create Base Image from Scratch

#### Step 1: Download Fedora Cloud Image

```bash
# Download Fedora 41 Cloud image (qcow2 format)
cd e2e/qemu-images
wget https://download.fedoraproject.org/pub/fedora/linux/releases/41/Cloud/x86_64/images/Fedora-Cloud-Base-Generic.x86_64-41-1.4.qcow2

# Rename to base.qcow2
mv Fedora-Cloud-Base-Generic.x86_64-41-1.4.qcow2 base.qcow2
```

#### Step 2: Create SSH Key Pair

```bash
# Generate SSH key for VM access
ssh-keygen -t ed25519 -f e2e/qemu-images/id_ed25519 -N ""

# The public key needs to be embedded in the image (see Step 3)
```

#### Step 3: Customize the Image

Create a cloud-init config to set up the user and SSH key:

```bash
# Create cloud-init config
cat > /tmp/user-data << 'EOF'
#cloud-config
users:
  - name: testuser
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAA... your-public-key-here
EOF

# Create cloud-init ISO
genisoimage -output e2e/qemu-images/ci-data.iso -volid cidata -joliet -rock /tmp/user-data
```

#### Step 4: Boot and Customize Image

```bash
# Create a temporary VM to customize the image
qemu-img create -f qcow2 -b e2e/qemu-images/base.qcow2 -F qcow2 /tmp/temp-vm.qcow2

# Boot with cloud-init ISO
qemu-system-x86_64 \
  -enable-kvm -m 2048 -smp 2 \
  -drive file=/tmp/temp-vm.qcow2,format=qcow2,if=virtio \
  -cdrom e2e/qemu-images/ci-data.iso \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-pci,netdev=net0 \
  -display none &

# Wait for cloud-init to complete (check console output)
# Then customize the image:
```

#### Step 5: Install Dependencies in Image

```bash
# SSH into the VM (after cloud-init completes)
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost

# Install required packages
sudo dnf install -y tmux dotool gnome-shell

# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
cp ~/.local/bin/uv ~/.local/bin/uv-backup

# Install Python dependencies
~/.local/bin/uv pip install --system httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz

# Exit the VM
exit
```

#### Step 6: Optimize the Image

```bash
# Shutdown the VM gracefully
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost "sudo shutdown -h now"
wait

# Optimize for faster boot
./e2e/scripts/optimize-vm-image.sh e2e/qemu-images/base.qcow2
```

#### Step 7: Create UV-enhanced Image (Optional but Recommended)

```bash
# Create an optimized image with uv pre-installed
./e2e/scripts/create-base-with-uv.sh
```

## Running E2E Tests

### First Time Setup

```bash
# Ensure bun is installed
cd e2e && bun install

# Verify QEMU is installed
which qemu-system-x86_64
```

### Update Reference Screenshots

```bash
# Boot VM, capture reference screenshots, shut down
cd e2e && bun run e2e.ts --update

# Or via just
just qemu-e2e-update-ts
```

### Run Tests

```bash
# Run tests against reference screenshots
cd e2e && bun run e2e.ts

# Or via just
just e2e
```

### Test Specific Output Methods

```bash
# Test with virtual keyboard typing (default)
cd e2e && bun run e2e.ts --output-method type

# Test with clipboard paste
cd e2e && bun run e2e.ts --output-method clipboard

# Test with Mutter virtual device
cd e2e && bun run e2e.ts --output-method mutter-virtual
```

### Manual VM Access

```bash
# Start VM for manual debugging
just qemu-e2e-vm

# In another terminal, connect via SPICE
just e2e-test-view

# Or SSH directly
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost
```

## Test Architecture

### VM Configuration

- **Display**: SPICE (port 5930 default)
- **SSH**: port 2222
- **User**: testuser
- **RAM**: 4GB
- **CPU**: 2 cores

### Test Flow

1. **Boot**: Create overlay from base image, start QEMU
2. **Setup**: Wait for GDM login, deploy extension + Python service
3. **Execute**: Open terminal, start recording, wait for transcription
4. **Verify**: Compare screenshots with references (MSE < 100)
5. **Cleanup**: Shutdown VM, delete overlay

### Test Audio

- Test files: `e2e/fixtures/test-*.wav`
- Test cases: `e2e/fixtures/test-cases.json`
- Audio is pre-recorded, not played through speakers
- Transcription uses local Parakeet provider (no API key needed)

## Troubleshooting

### VM Won't Boot

```bash
# Check if KVM is available
lsmod | grep kvm

# Check QEMU version
qemu-system-x86_64 --version

# Check if base image exists
ls -la e2e/qemu-images/base*.qcow2
```

### SSH Connection Fails

```bash
# Check if VM is running
ps aux | grep qemu

# Check SSH port
netstat -tlnp | grep 2222

# Test SSH manually
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost echo ok
```

### Extension Not Loading

```bash
# Check extension logs in VM
journalctl --user -f | grep voice

# Check if extension is enabled
gnome-extensions list | grep voice-to-text

# Manually enable extension
gnome-extensions enable voice-to-text@happytomatoe.com
```

### Tests Fail with "Base image not found"

```bash
# Ensure base image exists
ls -la e2e/qemu-images/base*.qcow2

# If using base-with-uv.qcow2, ensure it was created
./e2e/scripts/create-base-with-uv.sh
```

### Tests Hang at GDM Login

```bash
# Check VM console output
cat e2e/qemu-images/serial.log

# Check if GDM is running
ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost "systemctl status gdm"
```

## Advanced Usage

### Recording Test Sessions

```bash
# Record video frames during test execution
cd e2e && bun run e2e.ts --record

# Output saved to e2e/output/recording/
```

### Debugging with Snapshots

```bash
# Save VM snapshot
virsh snapshot-create-as <vm-name> clean "Clean state"

# Restore snapshot
virsh snapshot-revert <vm-name> clean
```

### Custom Test Cases

Add new test cases to `e2e/fixtures/test-cases.json`:

```json
{
  "name": "my-test",
  "audio": "test-my-audio.wav",
  "expected": "Expected transcription text"
}
```

## CI/CD Integration

For automated testing in CI:

```yaml
# Example GitHub Actions workflow
- name: Run E2E tests
  run: |
    # Ensure KVM is available
    sudo modprobe kvm
    sudo modprobe kvm_intel
    
    # Run tests
    cd e2e && bun run e2e.ts
```

## Key Learnings

1. **GNOME 50 removed `St.Spinner`** — Extension uses custom GObject class instead
2. **`org.gnome.Shell.Eval` is disabled in GNOME 50** — Use D-Bus properties instead
3. **tmux must be inside gnome-terminal** — dotool types into focused window
4. **Activities must be dismissed** — Otherwise dotool types into search bar
5. **Audio levels are empty by design** — Tests verify UI state, not audio
