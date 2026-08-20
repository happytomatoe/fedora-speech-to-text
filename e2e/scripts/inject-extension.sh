#!/bin/bash
# Inject GNOME extension + D-Bus service into a golden image (offline, no VM boot)
# Usage: bash inject-extension.sh [--image PATH] [--ext-dir PATH]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Defaults
IMAGE="${PROJECT_ROOT}/qemu-images/golden-gnome-deps.qcow2"
EXT_DIR="${PROJECT_ROOT}/gnome-ext"
SERVICE_DIR="${PROJECT_ROOT}/service"
EXT_UUID="voice-to-text@happytomatoe.com"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --image) IMAGE="$2"; shift 2 ;;
    --ext-dir) EXT_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ ! -f "$IMAGE" ]; then
  echo "ERROR: Image not found: $IMAGE"
  echo "Run customize-golden-image.sh first to create it."
  exit 1
fi

if [ ! -d "$EXT_DIR/schemas" ]; then
  echo "ERROR: Extension dir not found: $EXT_DIR"
  exit 1
fi

# Detect virt-customize: prefer bare, fall back to toolbox
if command -v virt-customize >/dev/null 2>&1; then
  vc() { virt-customize "$@"; }
elif toolbox run --container fedora-toolbox-44 which virt-customize >/dev/null 2>&1; then
  vc() { toolbox run --container fedora-toolbox-44 virt-customize "$@"; }
else
  echo "ERROR: virt-customize not found (install virtinst or run inside toolbox)"
  exit 1
fi

echo "=== Injecting extension + D-Bus service ==="
echo "Image: $IMAGE"
echo "Extension: $EXT_UUID"
echo ""

# Step 1: Compile extension schemas (on host, offline)
echo "1. Compiling extension schemas..."
SCHEMA_DIR="${EXT_DIR}/schemas"
glib-compile-schemas "$SCHEMA_DIR/" 2>/dev/null || true

# Step 2: Copy extension to system-wide location
echo "2. Copying extension to /usr/share/gnome-shell/extensions/..."
vc \
  -a "$IMAGE" \
  --run-command "mkdir -p /usr/share/gnome-shell/extensions/$EXT_UUID" \
  --copy-in "$EXT_DIR"/metadata.json:/usr/share/gnome-shell/extensions/$EXT_UUID/ \
  --copy-in "$EXT_DIR"/schemas:/usr/share/gnome-shell/extensions/$EXT_UUID/ \
  --run-command "chmod -R a+rX /usr/share/gnome-shell/extensions/$EXT_UUID"

# Copy JS files separately (glob doesn't work with --copy-in)
for jsfile in "$EXT_DIR"/*.js; do
  vc \
    -a "$IMAGE" \
    --copy-in "$jsfile":/usr/share/gnome-shell/extensions/$EXT_UUID/
done

# Step 3: Install Python package + D-Bus service files
echo "3. Installing Python package + D-Bus service..."

# Create a temp dir with everything we need to upload
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Build a wheel for offline install
cd "$PROJECT_ROOT"
uv build --wheel -o "$TMPDIR/" 2>/dev/null

# Copy D-Bus service files
cp "$SERVICE_DIR/com.happytomatoe.VoiceToText.service" "$TMPDIR/"
cp "$SERVICE_DIR/com.happytomatoe.VoiceToText.user.service" "$TMPDIR/"

# Upload wheel + service files, install inside image
WHEEL=$(ls "$TMPDIR"/*.whl)
WHEEL_NAME=$(basename "$WHEEL")
vc \
  -a "$IMAGE" \
  --upload "$WHEEL":/tmp/"$WHEEL_NAME" \
  --upload "$TMPDIR/com.happytomatoe.VoiceToText.service":/tmp/dbus-session.service \
  --upload "$TMPDIR/com.happytomatoe.VoiceToText.user.service":/tmp/systemd-user.service \
  --run-command "pip3 install --break-system-packages /tmp/$WHEEL_NAME && rm /tmp/$WHEEL_NAME" \
  --run-command "mkdir -p /usr/share/dbus-1/services && cp /tmp/dbus-session.service /usr/share/dbus-1/services/com.happytomatoe.VoiceToText.service && rm /tmp/dbus-session.service" \
  --run-command "mkdir -p /usr/lib/systemd/user && cp /tmp/systemd-user.service /usr/lib/systemd/user/com.happytomatoe.VoiceToText.user.service && rm /tmp/systemd-user.service"

# Step 4: Enable extension via dconf (system-wide default)
echo "4. Enabling extension via dconf..."
vc \
  -a "$IMAGE" \
  --run-command "mkdir -p /etc/dconf/db/local.d" \
  --run-command "printf '[org/gnome/shell]\nenabled-extensions=[\"$EXT_UUID\"]\n' > /etc/dconf/db/local.d/00-extensions" \
  --run-command "dconf update"

echo ""
echo "=== Injection complete ==="
echo "Extension + D-Bus service baked into: $IMAGE"
echo "Boot the VM — extension will be active automatically."
