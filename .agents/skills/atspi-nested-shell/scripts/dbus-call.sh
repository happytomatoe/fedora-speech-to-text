#!/usr/bin/env bash
# Call a D-Bus method on the nested GNOME Shell
# Usage: dbus-call.sh <destination> <object-path> <interface> <method> [args...]
# Example: dbus-call.sh org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval "'hello'"
set -euo pipefail

DESTINATION="${1:-}"
OBJECT_PATH="${2:-}"
INTERFACE="${3:-}"
METHOD="${4:-}"
shift 4 || true

if [ -z "$DESTINATION" ] || [ -z "$OBJECT_PATH" ] || [ -z "$INTERFACE" ] || [ -z "$METHOD" ]; then
  echo "Usage: $0 <destination> <object-path> <interface> <method> [args...]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval \"'hello'\"" >&2
  echo "  $0 org.gnome.Shell /org/gnome/Shell/Screenshot org.gnome.Shell.Screenshot.Screenshot false false '/tmp/screenshot.png'" >&2
  exit 1
fi

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

# Build the gdbus command
echo "Calling: gdbus call --session --dest $DESTINATION --object-path $OBJECT_PATH --method $INTERFACE.$METHOD $*"
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" gdbus call --session --dest "$DESTINATION" --object-path "$OBJECT_PATH" --method "$INTERFACE.$METHOD" "$@" 2>&1
