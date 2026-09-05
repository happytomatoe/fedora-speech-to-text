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

# Overlay persists across runs (caches uv/bun deps — harness bus-wait timeout
# is 30s; a wiped home means uv re-downloads and the service misses it).
# Pass fresh=1 to reset to the golden image.
if [ "${1:-}" = "fresh" ] || [ ! -f "$OVERLAY" ]; then
  rm -f "$OVERLAY"
  qemu-img create -f qcow2 -b "$IMAGE" -F qcow2 "$OVERLAY" > /dev/null
  echo "overlay created from golden image"
fi

# Internal snapshot support:
#   boot-vm.sh snapshot save <name>  — must be run while VM is running
#   boot-vm.sh snapshot load <name>  — stops VM, reverts overlay to snapshot
#   boot-vm.sh snapshot list
# Snapshots live inside overlay.qcow2 (qemu internal snapshots).
case "${1:-}" in
  snapshot)
    cmd="${2:-list}"; name="${3:-}"
    if [ "$cmd" = "list" ]; then
      printf 'info snapshots\n' | timeout 5 socat - unix:"$MONITOR" 2>/dev/null | grep -E '^\s+[0-9]' || echo "(VM not running — use qemu-img: qemu-img snapshot -l $OVERLAY)"
    elif [ -z "$name" ]; then
      echo "usage: boot-vm.sh snapshot save|load <name>" >&2; exit 1
    elif [ "$cmd" = "save" ]; then
      printf 'savevm %s\n' "$name" | timeout 30 socat - unix:"$MONITOR" >/dev/null 2>&1 && echo "snapshot '$name' saved"
    elif [ "$cmd" = "load" ]; then
      [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null && sleep 2
      qemu-img snapshot -a "$name" "$OVERLAY" && echo "reverted to snapshot '$name'"
    fi
    exit 0
    ;;
esac

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
