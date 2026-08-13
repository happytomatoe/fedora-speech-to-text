#!/bin/bash
# Customize golden image with all E2E dependencies using virt-customize
# This modifies the image directly without booting it

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GOLDEN_IMAGE="$PROJECT_ROOT/qemu-images/golden-gnome.qcow2"
CUSTOMIZED_IMAGE="$PROJECT_ROOT/qemu-images/golden-gnome-deps.qcow2"

echo "=== Customizing Golden Image ==="
echo "Input: $GOLDEN_IMAGE"
echo "Output: $CUSTOMIZED_IMAGE"

# Check if input image exists
if [ ! -f "$GOLDEN_IMAGE" ]; then
    echo "ERROR: Golden image not found at $GOLDEN_IMAGE"
    exit 1
fi

# Check if virt-customize is available
if ! toolbox run --container fedora-toolbox-44 which virt-customize >/dev/null 2>&1; then
    echo "ERROR: virt-customize not found in toolbox"
    echo "Install with: toolbox run --container fedora-toolbox-44 sudo dnf install -y libguestfs-tools"
    exit 1
fi

# Create a copy of the golden image
echo "1. Copying golden image..."
cp "$GOLDEN_IMAGE" "$CUSTOMIZED_IMAGE"

# Install all dependencies using virt-customize
echo "2. Installing dependencies with virt-customize..."
echo "   This may take 10-20 minutes..."

# Install base packages first (some may already be installed)
echo "   Installing base packages..."
toolbox run --container fedora-toolbox-44 virt-customize \
    -a "$CUSTOMIZED_IMAGE" \
    --install "gdm,gnome-shell,gnome-terminal,tmux,portaudio-devel" \
    --install "python3,python3-pip,python3-devel" \
    --run-command "dnf copr enable -y scottames/ghostty || true" \
    --run-command "dnf copr enable -y smallcms/dotool || true" \
    --run-command "dnf install -y ghostty dotool || true" \
    --run-command "pip3 install --break-system-packages httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz sounddevice groq" \
    --run-command "pip3 install --break-system-packages uv" \
    --run-command "systemctl set-default graphical.target" \
    --run-command "mkdir -p /etc/gdm" \
    --write "/etc/gdm/custom.conf:[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=testuser\nWaylandEnable=true\n" \
    --run-command "chmod 660 /dev/uinput || true" \
    --run-command "chown root:input /dev/uinput || true" \
    --run-command "usermod -aG input testuser || true" \
    --selinux-relabel

echo ""
echo "=== Customization Complete ==="
echo "Output: $CUSTOMIZED_IMAGE"
echo ""
echo "Next steps:"
echo "1. Use this image in E2E tests:"
echo "   bun run e2e.ts --golden-image=$CUSTOMIZED_IMAGE"
echo ""
echo "2. Or replace the original golden image:"
echo "   mv $CUSTOMIZED_IMAGE $GOLDEN_IMAGE"
