#!/usr/bin/env bash
# Setup open source references for API inspection
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENSRC_DIR="$SCRIPT_DIR/../opensrc"

mkdir -p "$OPENSRC_DIR"

# GNOME Shell (target: GNOME 45-50)
if [ -d "$OPENSRC_DIR/gnome-shell/.git" ]; then
    echo "GNOME Shell already cloned"
elif [ -d "$OPENSRC_DIR/gnome-shell" ]; then
    echo "Warning: Directory exists but is not a valid git repository, removing..."
    rm -rf "$OPENSRC_DIR/gnome-shell"
    echo "Cloning GNOME Shell (gnome-50 branch)..."
    git clone --depth 1 --branch gnome-50 \
        https://gitlab.gnome.org/GNOME/gnome-shell.git \
        "$OPENSRC_DIR/gnome-shell"
else
    echo "Cloning GNOME Shell (gnome-50 branch)..."
    git clone --depth 1 --branch gnome-50 \
        https://gitlab.gnome.org/GNOME/gnome-shell.git \
        "$OPENSRC_DIR/gnome-shell"
fi

echo ""
echo "Done. Key files to inspect:"
echo "  - opensrc/gnome-shell/js/misc/inputMethod.js (Main.inputMethod.commit)"
echo "  - opensrc/gnome-shell/js/ui/main.js (Main module)"
