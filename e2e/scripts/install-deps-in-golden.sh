#!/bin/bash
# Install all E2E dependencies in golden image
# Run this inside the VM to pre-install everything

set -e

echo "=== Installing E2E Dependencies ==="

# 1. Install GDM + GNOME Shell (headless cloud image doesn't have these)
echo "1. Installing GDM + GNOME Shell..."
sudo dnf install -y gdm gnome-shell 2>/dev/null || true

# 2. Install gnome-terminal (needed for tmux in E2E tests)
echo "2. Installing gnome-terminal..."
sudo dnf install -y gnome-terminal 2>/dev/null || true

# 3. Install Ghostty via COPR (for testing mutter-paste clipboard behavior)
echo "3. Installing Ghostty..."
sudo dnf copr enable -y scottames/ghostty 2>/dev/null || true
sudo dnf install -y ghostty 2>/dev/null || true

# 4. Install dotool via COPR (for keyboard input simulation)
echo "4. Installing dotool..."
sudo dnf copr enable -y smallcms/dotool 2>/dev/null || true
sudo dnf install -y dotool 2>/dev/null || true

# 5. Install portaudio-devel (needed for sounddevice Python package)
echo "5. Installing portaudio-devel..."
sudo dnf install -y portaudio-devel 2>/dev/null || true

# 6. Install uv (fast Python package installer)
echo "6. Installing uv..."
if [ ! -f "$HOME/.local/bin/uv" ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi

# 7. Install Python packages
echo "7. Installing Python packages..."
$HOME/.local/bin/uv pip install --system --quiet \
    httpx \
    dbus-next \
    numpy \
    pyyaml \
    python-dotenv \
    websockets \
    jellyfish \
    rapidfuzz \
    sounddevice \
    groq 2>/dev/null || {
    echo "  uv install failed, falling back to pip..."
    python3 -m pip install --user --break-system-packages --quiet \
        httpx \
        dbus-next \
        numpy \
        pyyaml \
        python-dotenv \
        websockets \
        jellyfish \
        rapidfuzz \
        sounddevice \
        groq
}

# 8. Configure GDM for auto-login
echo "8. Configuring GDM auto-login..."
sudo tee /etc/gdm/custom.conf > /dev/null << 'EOF'
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=testuser
WaylandEnable=true

[security]

[debug]
EOF

# 9. Fix /dev/uinput permissions for dotool
echo "9. Fixing /dev/uinput permissions..."
sudo chmod 660 /dev/uinput 2>/dev/null || true
sudo chown root:input /dev/uinput 2>/dev/null || true

# 10. Enable GDM service
echo "10. Enabling GDM service..."
sudo systemctl enable gdm 2>/dev/null || true

echo ""
echo "=== All dependencies installed! ==="
echo "Golden image is ready for E2E tests."
