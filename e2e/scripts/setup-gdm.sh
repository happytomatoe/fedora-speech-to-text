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

# Dismiss GNOME welcome tour dialog
echo "--- Disabling GNOME welcome tour ---"
dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'" 2>/dev/null || true

echo "--- Configuring GDM auto-login ---"
sudo mkdir -p /etc/gdm
cat << 'EOF' | sudo tee /etc/gdm/custom.conf > /dev/null
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=testuser
EOF
sync

# Restart GDM to pick up the new config (kills current session, but SSH survives)
echo "--- Restarting GDM ---"
sudo systemctl restart gdm 2>/dev/null || true
sleep 2

echo "--- Memory before gnome-shell ---"
free -m | head -2

echo "--- Waiting for GDM auto-login to start gnome-shell ---"
for i in $(seq 1 30); do
  sleep 1
  if pgrep -x gnome-shell >/dev/null 2>&1; then
    echo "  gnome-shell ready after ${i}s"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "  FATAL: gnome-shell did not start"
    exit 1
  fi
done

echo "--- Disabling DPMS/screen blank ---"
dconf write /org/gnome/desktop/session/idle-delay 0 2>/dev/null || true
dconf write /org/gnome/desktop/screensaver/lock-enabled false 2>/dev/null || true
dconf write /org/gnome/desktop/screensaver/idle-activation-enabled false 2>/dev/null || true

# Pre-grant screenshot permission for portal screenshots
echo "--- Pre-granting screenshot permission ---"
# Allow all screenshot requests via portal permission store (flatpak permission-set doesn't work for portal perms)
gdbus call --session \
  --dest org.freedesktop.impl.portal.PermissionStore \
  --object-path /org/freedesktop/impl/portal/PermissionStore \
  --method org.freedesktop.impl.portal.PermissionStore.Set \
  'screenshot' true 'screenshot' '{"": ["yes"]}' '<byte 0x00>' 2>/dev/null || true

echo "--- GDM setup complete ---"
