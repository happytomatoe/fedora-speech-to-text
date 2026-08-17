#!/bin/bash
# E2E: Setup GDM and GNOME Shell
# Called with: bash setup-gdm.sh
set -euo pipefail

echo "--- Checking packages ---"
for pkg in mesa-libgbm mesa-dri-drivers polkit accountsservice gsettings-desktop-schemas; do
  rpm -q "$pkg" &>/dev/null || echo "  WARNING: $pkg not installed"
done

echo "--- Configuring journald ---"
sudo sed -i 's/^#ForwardToConsole=no/ForwardToConsole=yes/' /etc/systemd/journald.conf 2>/dev/null || true
sudo systemctl restart systemd-journald 2>/dev/null || true

echo "--- Disabling animations ---"
dconf write /org/gnome/desktop/interface/enable-animations false 2>/dev/null || true

echo "--- Memory before gnome-shell ---"
free -m | head -2

echo "--- Starting gnome-shell (headless) ---"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
setsid nohup gnome-shell --headless --unsafe-mode --mode=user --virtual-monitor 1280x720 > /tmp/gnome-shell.log 2>&1 </dev/null &
GSHELL_PID=$!
echo "  gnome-shell PID: $GSHELL_PID"

echo "--- Waiting for gnome-shell ready ---"
for i in $(seq 1 12); do
  sleep 5
  if pgrep -x gnome-shell >/dev/null 2>&1; then
    echo "  gnome-shell ready after $((i*5))s"
    break
  fi
  if [ "$i" = "12" ]; then
    echo "  FATAL: gnome-shell did not start"
    cat /tmp/gnome-shell.log | tail -20
    exit 1
  fi
done

echo "--- GDM setup complete ---"
