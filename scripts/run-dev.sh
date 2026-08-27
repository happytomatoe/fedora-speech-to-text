#!/usr/bin/env bash
set -euo pipefail

UUID="voice-to-text@happytomatoe.com"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST/schemas"
# Copy compiled JS from dist/
cp "$SRC"/dist/*.js "$DEST/"
# Copy other files from gnome-ext/
cp "$SRC"/metadata.json "$SRC"/stylesheet.css "$DEST/"
cp "$SRC"/schemas/*.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas/"

echo "Extension installed to $DEST"

if [ "${1:-}" = "--nested" ]; then
  echo "Starting nested GNOME Shell..."
  : > /tmp/gnome-shell-nested.log
  GNOME_VERSION=$(gnome-shell --version | awk '{print int($3)}')
  if [ "$GNOME_VERSION" -ge 49 ]; then
    dbus-run-session -- gnome-shell --wayland --devkit 2>&1 | tee /tmp/gnome-shell-nested.log
  else
    MUTTER_DEBUG_NESTED=1 dbus-run-session -- gnome-shell --wayland --nested 2>&1 | tee /tmp/gnome-shell-nested.log
  fi
else
  echo "Restart GNOME Shell (Alt+F2, r) or run with --nested for a nested session."
fi
