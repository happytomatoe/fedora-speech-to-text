#!/bin/bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
DBUS_SERVICE_DIR="${HOME}/.local/share/dbus-1/services"

mkdir -p "$INSTALL_DIR" "$DBUS_SERVICE_DIR"

# Install the Python package
uv tool install . --force

# Copy D-Bus service file
cp service/com.happytomatoe.VoiceToText.service "$DBUS_SERVICE_DIR/"

# Copy systemd user service file
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"
cp service/com.happytomatoe.VoiceToText.user.service "$SYSTEMD_USER_DIR/"
systemctl --user daemon-reload

# Install wrapper script
cp service/voice-to-text-dbus-wrapper "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/voice-to-text-dbus-wrapper"

echo "Service installed."
echo ""
echo "The D-Bus service will auto-start when the GNOME extension requests it."
echo "No manual start needed - just use the extension!"
echo ""
echo "To check if service is running:"
echo "  pgrep -af voice-to-text-dbus"
echo ""
echo "To view logs:"
echo "  journalctl --user | grep voice -f"
