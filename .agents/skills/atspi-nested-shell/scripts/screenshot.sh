#!/usr/bin/env bash
# Take a screenshot of the nested GNOME Shell
# Usage: screenshot.sh [output-file]
# Default output: /tmp/nested-shell-screenshot.png
set -euo pipefail

OUTPUT_FILE="${1:-/tmp/nested-shell-screenshot.png}"

# Find the nested GNOME Shell process
NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | head -1 || true)
if [ -z "$NESTED_PID" ]; then
  echo "No nested GNOME Shell running. Run 'just gnome-ext-dev' first." >&2
  exit 1
fi

# Get the D-Bus session address from the nested shell
DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)
if [ -z "$DBUS_ADDR" ]; then
  echo "Could not find D-Bus address in nested shell process." >&2
  exit 1
fi

echo "Taking screenshot to $OUTPUT_FILE..."

# Try the Screenshot interface (may be restricted)
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" gdbus call --session \
  --dest org.gnome.Shell \
  --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot \
  false false "$OUTPUT_FILE" 2>&1

if [ -f "$OUTPUT_FILE" ]; then
  echo "Screenshot saved to $OUTPUT_FILE"
else
  echo "Screenshot failed - the Screenshot interface may be restricted." >&2
  echo "Try using AT-SPI to query the UI tree instead:" >&2
  echo "  just atspi-tree" >&2
  exit 1
fi
