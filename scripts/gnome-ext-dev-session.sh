#!/usr/bin/env bash
# Runs inside dbus-run-session: starts AT-SPI, D-Bus service, enables extension, launches nested GNOME Shell.
# Called by `just gnome-ext-dev`.
set -euo pipefail
echo "DEBUG: Script started, LOG_FILE=$LOG_FILE" >> "$LOG_FILE"

LOG_FILE="${LOG_FILE:?}"
DEVKIT_FLAG="${DEVKIT_FLAG:?}"
UUID="voice-to-text@happytomatoe.com"
# Remove gnome-shell-disable-extensions file if it exists (disables all extensions)
echo "DEBUG: Checking for gnome-shell-disable-extensions..." >> "$LOG_FILE"
if [ -f /run/user/1000/gnome-shell-disable-extensions ]; then
  echo "DEBUG: Found gnome-shell-disable-extensions, removing..." >> "$LOG_FILE"
  rm -f /run/user/1000/gnome-shell-disable-extensions
  echo "DEBUG: Removed gnome-shell-disable-extensions" >> "$LOG_FILE"
else
  echo "DEBUG: gnome-shell-disable-extensions not found" >> "$LOG_FILE"
fi

# Start AT-SPI accessibility bus (needed for UI inspection)
/usr/libexec/at-spi-bus-launcher >> "$LOG_FILE" 2>&1 &
ATSPI_PID=$!
sleep 0.5

# Start AT-SPI registry daemon (registers accessibility providers)
/usr/libexec/at-spi2-registryd --use-gnome-session >> "$LOG_FILE" 2>&1 &
ATSPI_REG_PID=$!
sleep 0.5

voice-to-text-dbus >> "$LOG_FILE" 2>&1 &
DBUS_PID=$!
sleep 1
trap 'kill $DBUS_PID $ATSPI_PID $ATSPI_REG_PID 2>/dev/null || true' EXIT INT TERM
echo 'AT-SPI bus running. Use: just atspi-tree' >> "$LOG_FILE"

# Enable extension in this session's isolated dconf
echo "DEBUG: Checking dconf for enabled extensions..." >> "$LOG_FILE"
CURRENT=$(dconf read /org/gnome/shell/enabled-extensions)
echo "DEBUG: CURRENT=$CURRENT" >> "$LOG_FILE"
if ! echo "$CURRENT" | grep -q "$UUID"; then
  echo "DEBUG: Extension not found, enabling..." >> "$LOG_FILE"
  if [ -z "$CURRENT" ] || [ "$CURRENT" = "[]" ]; then
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
  else
    dconf write /org/gnome/shell/enabled-extensions "${CURRENT%]}, '$UUID']"
  fi
  echo "DEBUG: dconf write done" >> "$LOG_FILE"
else
  echo "DEBUG: Extension already enabled" >> "$LOG_FILE"
fi
echo "DEBUG: Final enabled-extensions=$(dconf read /org/gnome/shell/enabled-extensions)" >> "$LOG_FILE"

gnome-shell --wayland "$DEVKIT_FLAG"
