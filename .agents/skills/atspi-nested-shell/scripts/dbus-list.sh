#!/usr/bin/env bash
# List D-Bus services and interfaces in the nested GNOME Shell
# Usage: dbus-list.sh [filter]
# Example: dbus-list.sh gnome
set -euo pipefail

FILTER="${1:-}"

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

echo "D-Bus services in nested shell:"
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" dbus-send --session --type=method_call --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>&1 | tr ',' '\n' | sed 's/.*string "//;s/".*//' | grep -v "^org.freedesktop.DBus$" | sort | while read -r service; do
  if [ -z "$FILTER" ] || echo "$service" | grep -qi "$FILTER"; then
    echo "  $service"
  fi
done
