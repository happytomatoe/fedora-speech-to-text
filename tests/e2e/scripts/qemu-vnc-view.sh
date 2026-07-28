#!/bin/bash
# Start QEMU VM with VNC for interactive viewing.
# Connect with VNC viewer to localhost:5901
#
# Usage: ./qemu-vnc-view.sh
#
# Then connect with:
#   - Remmina: vnc://localhost:5901
#   - TigerVNC: localhost:5901
#   - macOS Screen Sharing: vnc://localhost:5901

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="/tmp/gnome-ext-vm"

echo "=== QEMU VNC Viewer ==="
echo ""
echo "Starting QEMU VM with VNC display..."
echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│  Connect with VNC viewer to:  localhost:5901            │"
echo "│                                                         │"
echo "│  • Remmina:      vnc://localhost:5901                   │"
echo "│  • TigerVNC:     localhost:5901                         │"
echo "│  • macOS:        vnc://localhost:5901                   │"
echo "│  • Windows:      use TightVNC or RealVNC                │"
echo "└─────────────────────────────────────────────────────────┘"
echo ""
echo "Press Ctrl+C to stop the VM"
echo ""

# ─── Step 1: Kill any existing QEMU ─────────────────────────────────
echo "1. Cleaning up existing QEMU..."
podman exec fedora-toolbox-44 bash -c "pkill -9 -f 'qemu-system-x86' 2>/dev/null || true"
sleep 2

# ─── Step 2: Start QEMU VM with VNC ──────────────────────────────────
echo "2. Starting QEMU VM..."
podman exec -d fedora-toolbox-44 bash -c "
    cd /tmp/gnome-ext-vm
    rm -f qemu-monitor.sock serial.log
    
    # Create fresh overlay
    qemu-img create -f qcow2 -b base.qcow2 -F qcow2 overlay.qcow2 5G
    
    # Start QEMU with VNC on display :1 (port 5901)
    qemu-system-x86_64 \
        -enable-kvm \
        -cpu host \
        -m 4096 \
        -smp 2 \
        -drive file=overlay.qcow2,format=qcow2,if=virtio \
        -drive file=seed.iso,format=raw,if=virtio,readonly=on \
        -device virtio-vga \
        -display vnc=:1 \
        -monitor unix:qemu-monitor.sock,server,nowait \
        -serial file:serial.log \
        -netdev user,id=net0,hostfwd=tcp::2222-:22 \
        -device virtio-net-pci,netdev=net0 \
        -no-reboot
"

# ─── Step 3: Wait for VNC to be ready ────────────────────────────────
echo "3. Waiting for VNC to be ready..."
for i in $(seq 1 30); do
    if podman exec fedora-toolbox-44 bash -c "ss -tlnp | grep -q ':5901'" 2>/dev/null; then
        echo "   VNC ready!"
        break
    fi
    echo -n "."
    sleep 1
done

# ─── Step 4: Set up port forwarding ──────────────────────────────────
echo "4. Setting up port forwarding..."

# Forward VNC port (5901) from container to host
# First try SSH tunnel
ssh -f -N -L 5901:localhost:5901 -p 2222 -i "${VM_DIR}/id_ed25519" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    testuser@localhost 2>/dev/null || true

# Also forward SSH port
ssh -f -N -L 2223:localhost:2222 -p 2222 -i "${VM_DIR}/id_ed25519" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    testuser@localhost 2>/dev/null || true

sleep 1

# Verify VNC is accessible
if nc -z localhost 5901 2>/dev/null; then
    echo "   VNC forwarding active on localhost:5901"
else
    echo "   WARNING: VNC port forwarding may not be working"
    echo "   Try connecting directly to container IP"
fi

# ─── Step 5: Wait for SSH ───────────────────────────────────────────
echo "5. Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh -p 2222 -i "${VM_DIR}/id_ed25519" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        testuser@localhost echo ok >/dev/null 2>&1; then
        echo "   SSH ready (${i}s)"
        break
    fi
    echo -n "."
    sleep 2
done

# ─── Step 6: Start GNOME Shell ──────────────────────────────────────
echo "6. Starting GNOME Shell..."
podman exec fedora-toolbox-44 bash -c "
    ssh -p 2222 -i /tmp/gnome-ext-vm/id_ed25519 \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        testuser@localhost 'export DISPLAY=:1; dbus-launch gnome-session &'"
sleep 5

echo ""
echo "✓ VM is ready!"
echo ""
echo "GNOME Shell should be visible in your VNC viewer."
echo "You can now run E2E tests in another terminal:"
echo ""
echo "  podman exec -e DEEPGRAM_API_KEY=\$DEEPGRAM_API_KEY fedora-toolbox-44 \\"
echo "    bash -c 'REPO_ROOT=/var/home/l/git/voice-to-text-test-pod \\"
echo "    /var/home/l/git/voice-to-text-test-pod/tests/e2e/scripts/qemu-snapshot.sh'"
echo ""
echo "Press Ctrl+C to stop the VM"
echo ""

# Trap to cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down VM..."
    podman exec fedora-toolbox-44 bash -c "
        echo 'system_powerdown' | socat - UNIX-CONNECT:/tmp/gnome-ext-vm/qemu-monitor.sock 2>/dev/null || true
    " 2>/dev/null || true
    pkill -f "ssh.*-L.*5901" 2>/dev/null || true
    pkill -f "ssh.*-L.*2223" 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT INT TERM

# Wait forever (until Ctrl+C)
echo "VM running... (PID: $(podman exec fedora-toolbox-44 pgrep qemu-system-x86_64 2>/dev/null || echo 'unknown'))"
while true; do
    sleep 5
    # Check if QEMU is still running
    if ! podman exec fedora-toolbox-44 pgrep qemu-system-x86_64 >/dev/null 2>&1; then
        echo "QEMU exited unexpectedly"
        break
    fi
done
