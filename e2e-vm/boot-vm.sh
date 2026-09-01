#!/usr/bin/env bash
# Boot the Ubuntu 26.04 E2E parity VM (or no-op if already running).
# SSH: localhost:2222 (user testuser, key in this dir)
set -euo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="$VM_DIR/golden-ubuntu-2604.qcow2"
OVERLAY="$VM_DIR/overlay.qcow2"
PID_FILE="$VM_DIR/qemu.pid"
MONITOR="$VM_DIR/qemu-monitor.sock"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "VM already running (PID $(cat "$PID_FILE"))"
  exit 0
fi
[ -f "$IMAGE" ] || { echo "Run e2e-vm/setup-vm.sh first" >&2; exit 1; }

rm -f "$OVERLAY"
qemu-img create -f qcow2 -b "$IMAGE" -F qcow2 "$OVERLAY" > /dev/null

cd "$VM_DIR"
qemu-system-x86_64 \
  -enable-kvm -cpu host -m 4096 -smp 2 \
  -drive file=overlay.qcow2,format=qcow2,if=virtio \
  -device virtio-vga \
  -display none \
  -monitor unix:qemu-monitor.sock,server,nowait \
  -serial file:serial.log \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-pci,netdev=net0 \
  -daemonize -pidfile qemu.pid

echo "QEMU started (PID $(cat "$PID_FILE")), waiting for SSH..."
for i in $(seq 1 60); do
  if ssh -i id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
       -o ConnectTimeout=2 -p 2222 testuser@localhost echo ok 2>/dev/null; then
    echo "SSH ready after ~$((i * 3))s"
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "FATAL: QEMU exited early" >&2
    tail -30 serial.log || true
    exit 1
  fi
  sleep 3
done
echo "FATAL: SSH not ready after 180s" >&2
exit 1
