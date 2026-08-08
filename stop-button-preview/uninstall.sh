#!/bin/bash
# Uninstall the stop-button-preview extension
set -e

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/stop-button-preview@local"

echo "Disabling extension..."
gnome-extensions disable stop-button-preview@local 2>/dev/null || true

echo "Removing files..."
rm -rf "$EXT_DIR"

echo "Restarting GNOME Shell..."
killall -3 gnome-shell 2>/dev/null || true

echo "Done!"
