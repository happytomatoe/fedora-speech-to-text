#!/bin/bash
# Install and enable the stop-button-preview extension
set -e

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/stop-button-preview@local"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing stop-button-preview extension..."

mkdir -p "$EXT_DIR"
cp "$SCRIPT_DIR/metadata.json" "$EXT_DIR/"
cp "$SCRIPT_DIR/extension.js" "$EXT_DIR/"

echo "Restarting GNOME Shell..."
killall -3 gnome-shell 2>/dev/null || true

sleep 3

echo "Enabling extension..."
gnome-extensions enable stop-button-preview@local 2>/dev/null || true

echo "Done! Click the puzzle piece icon in the top bar to see all button options."
echo ""
echo "To disable: gnome-extensions disable stop-button-preview@local"
echo "To uninstall: rm -rf $EXT_DIR && killall -3 gnome-shell"
