#!/usr/bin/env bash
# Open extension preferences in the nested GNOME Shell
# Usage: open-prefs.sh [extension-uuid]
# Default UUID: voice-to-text@happytomatoe.com
set -euo pipefail

EXTENSION_UUID="${1:-voice-to-text@happytomatoe.com}"

# Find the nested GNOME Shell process
NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | head -1 || true)
if [ -z "$NESTED_PID" ]; then
  echo "No nested GNOME Shell running. Run 'just dev' first." >&2
  exit 1
fi

# Get the D-Bus session address from the nested shell
DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)
if [ -z "$DBUS_ADDR" ]; then
  echo "Could not find D-Bus address in nested shell process." >&2
  exit 1
fi

echo "Opening preferences for $EXTENSION_UUID in nested shell..."
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" gnome-extensions prefs "$EXTENSION_UUID" 2>&1 &

sleep 2
echo "Preferences window should be open."
