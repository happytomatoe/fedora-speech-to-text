#!/usr/bin/env bash
# Parse arguments
for arg in "$@"; do
  if [ "$arg" = "--debug" ]; then
    set -x
  fi
done
set -euo pipefail
REPO="happytomatoe/voice-to-text"
EXT_UUID="voice-to-text@happytomatoe.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
DBUS_SERVICE_DIR="$HOME/.local/share/dbus-1/services"

# --- Helper: check if a command is available ---
command_exists() {
  command -v "$1" &>/dev/null
}

# --- Detect OS ---
if command_exists rpm-ostree; then
  PKG_MGR="rpm-ostree"
elif command_exists dnf; then
  PKG_MGR="dnf"
elif command_exists pacman; then
  PKG_MGR="pacman"
elif command_exists apt; then
  PKG_MGR="apt"
else
  echo "ERROR: Unsupported package manager. Supported: rpm-ostree, dnf, pacman, apt"
  exit 1
fi

echo "Detected package manager: $PKG_MGR"
echo ""

# --- Helper: install a package if not already present ---
install_pkg() {
  local pkg="$1"
  if command_exists "$pkg"; then
    echo "  $pkg already installed, skipping."
    return 0
  fi
  case "$PKG_MGR" in
  apt)
    if dpkg -s "$pkg" &>/dev/null; then
      echo "  $pkg already installed, skipping."
      return 0
    fi
    ;;
  dnf | rpm-ostree)
    if rpm -q "$pkg" &>/dev/null; then
      echo "  $pkg already installed, skipping."
      return 0
    fi
    ;;
  pacman)
    if pacman -Qi "$pkg" &>/dev/null; then
      echo "  $pkg already installed, skipping."
      return 0
    fi
    ;;
  esac
  echo "  Installing $pkg..."
  case "$PKG_MGR" in
  rpm-ostree)
    sudo rpm-ostree install -y "$pkg" || true
    ;;
  dnf)
    sudo dnf install -y "$pkg" || true
    ;;
  pacman)
    sudo pacman -S --noconfirm "$pkg" || true
    ;;
  apt)
    sudo apt install -y "$pkg" || true
    ;;
  esac
}

# --- Install dotool (build from source) ---
install_dotool() {
  # Check if all required binaries already exist
  if command_exists dotool && command_exists dotoold && command_exists dotoolc; then
    echo "  dotool already installed (dotool, dotoold, dotoolc), skipping."
    return 0
  fi

  echo "  Building dotool from source..."

  local BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  export PATH="$BIN_DIR:$PATH"

  # Try Toolbox first (recommended for rpm-ostree/Silverblue)
  if command_exists toolbox; then
    echo "  Building dotool via Toolbox..."
    local TOOLBOX_NAME="dotool-build"
    if ! toolbox list 2>/dev/null | grep -q "$TOOLBOX_NAME"; then
      toolbox create -c "$TOOLBOX_NAME" >/dev/null 2>&1 || true
    fi
    if toolbox run -c "$TOOLBOX_NAME" sh -c "
      sudo dnf install -y gcc make libev-devel systemd-devel git
      rm -rf /tmp/dotool-build
      git clone --depth 1 https://git.sr.ht/~geb/dotool /tmp/dotool-build
      cd /tmp/dotool-build && ./build.sh
      cp dotool dotoolc dotoold \"$BIN_DIR/\"
    " 2>/dev/null; then
      echo "  dotool built successfully via Toolbox."
      return 0
    fi
    echo "  Toolbox build failed, trying alternative..."
  fi

  # Try Podman/Docker fallback
  local CONTAINER_BIN=""
  if command_exists podman; then
    CONTAINER_BIN="podman"
  elif command_exists docker; then
    CONTAINER_BIN="docker"
  fi

  if [ -n "$CONTAINER_BIN" ]; then
    echo "  Building dotool via $CONTAINER_BIN..."
    if $CONTAINER_BIN run --rm \
      -v "$BIN_DIR:/out:Z" \
      fedora:latest sh -c "
        dnf install -y gcc make libev-devel systemd-devel git
        git clone --depth 1 https://git.sr.ht/~geb/dotool /tmp/dotool
        cd /tmp/dotool && ./build.sh
        cp dotool dotoolc dotoold /out/
      " 2>/dev/null; then
      echo "  dotool built successfully via $CONTAINER_BIN."
      return 0
    fi
    echo "  $CONTAINER_BIN build failed."
  fi

  # Direct build (last resort)
  echo "  Attempting direct build..."
  local BUILD_DEPS="gcc make libev-devel systemd-devel"
  case "$PKG_MGR" in
    apt) BUILD_DEPS="gcc make libev-dev libsystemd-dev" ;;
    pacman) BUILD_DEPS="gcc make libev systemd" ;;
  esac
  install_ok=false
  if [ "$PKG_MGR" = "pacman" ]; then
    sudo pacman -S --noconfirm $BUILD_DEPS git 2>/dev/null && install_ok=true
  else
    sudo "$PKG_MGR" install -y $BUILD_DEPS git 2>/dev/null && install_ok=true
  fi
  if [ "$install_ok" = true ]; then
    local TMPDIR
    TMPDIR=$(mktemp -d)
    if git clone --depth 1 https://git.sr.ht/~geb/dotool "$TMPDIR/dotool" 2>/dev/null &&
      (cd "$TMPDIR/dotool" && ./build.sh 2>/dev/null && cp dotool dotoolc dotoold "$BIN_DIR/"); then
      rm -rf "$TMPDIR"
      echo "  dotool built successfully from source."
      return 0
    fi
    rm -rf "$TMPDIR"
  fi

  echo ""
  echo "ERROR: Failed to install dotool automatically."
  echo "Please install manually (see https://git.sr.ht/~geb/dotool):"
  echo "  sudo dnf install -y gcc make libev-devel systemd-devel"
  echo "  git clone https://git.sr.ht/~geb/dotool"
  echo "  cd dotool && make"
  echo "  cp dotool dotoolc dotoold ~/.local/bin/"
  return 1
}

# --- Install prerequisites ---
echo "Installing prerequisites..."
case "$PKG_MGR" in
rpm-ostree)
  install_dotool
  install_pkg unzip
  install_pkg curl
  install_pkg libsecret
  echo ""
  echo "NOTE: rpm-ostree changes require a reboot to take effect."
  echo "      If this is the first time layering packages, reboot before continuing."
  ;;
dnf)
  install_dotool
  install_pkg unzip
  install_pkg curl
  install_pkg libsecret
  ;;
pacman)
  install_dotool
  install_pkg unzip
  install_pkg curl
  install_pkg libsecret
  ;;
apt)
  install_dotool
  install_pkg unzip
  install_pkg curl
  install_pkg libsecret-1-dev
  install_pkg libsecret-tools
  ;;
esac

# --- Install uv if not present ---
if ! command_exists uv; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command_exists uv; then
    echo "ERROR: Failed to install uv."
    exit 1
  fi
  echo "uv installed."
else
  echo "uv already installed, skipping."
fi

# --- Install Python D-Bus service ---
echo ""
echo "--- Installing Python D-Bus service ---"
echo "Fetching latest release tag..."
LATEST_TAG=$(
  # GIT_TERMINAL_PROMPT=0 prevents git from hanging on credential prompts
  # timeout prevents indefinite hang if git ls-remote stalls
  # Keep stderr separate so git errors don't get parsed by awk as tags
  GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote --tags --sort=-v:refname "https://github.com/$REPO.git" |
    awk -F'/' '$NF !~ /\^\{\}$/ { print $NF; exit }' || true
)
if [ -z "$LATEST_TAG" ]; then
  echo "WARNING: Could not fetch release tags for $REPO."
  echo "  This can happen due to network issues or authentication prompts."
  echo "  Falling back to installing from source..."
  REPO_DIR=$(mktemp -d)
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 "https://github.com/$REPO.git" "$REPO_DIR"
  uv tool install "$REPO_DIR" --force
  rm -rf "$REPO_DIR"
else
  echo "Installing version $LATEST_TAG..."
  uv tool install "git+https://github.com/$REPO.git@$LATEST_TAG" --force
fi
echo "Python D-Bus service installed (voice-to-text-dbus)."

# --- Install D-Bus service files ---
echo ""
echo "--- Installing D-Bus service files ---"
mkdir -p "$DBUS_SERVICE_DIR"
mkdir -p "$HOME/.local/bin"

# Copy D-Bus service file - check local or download from repo
if [ -f "service/com.happytomatoe.VoiceToText.service" ]; then
  cp service/com.happytomatoe.VoiceToText.service "$DBUS_SERVICE_DIR/"
else
  echo "Downloading D-Bus service file from repository..."
  curl -sL "https://raw.githubusercontent.com/$REPO/main/service/com.happytomatoe.VoiceToText.service" -o "$DBUS_SERVICE_DIR/com.happytomatoe.VoiceToText.service"
fi

# D-Bus service auto-activates when extension requests the name
# No systemd daemon-reload or enable needed

# --- Install GNOME extension ---
echo ""
echo "--- Installing GNOME extension ---"

echo "Fetching latest release..."
if [ -z "$LATEST_TAG" ]; then
  echo "Falling back to installing the extension from source..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR/schemas"
  TMPDIR=$(mktemp -d)
  git clone --depth 1 "https://github.com/$REPO.git" "$TMPDIR/repo"
  cp "$TMPDIR/repo/gnome-ext"/*.js "$TMPDIR/repo/gnome-ext"/*.json "$INSTALL_DIR/"
  mkdir -p "$INSTALL_DIR/prefs"
  cp "$TMPDIR/repo/gnome-ext/prefs/"*.js "$INSTALL_DIR/prefs/" 2>/dev/null || true
  cp "$TMPDIR/repo/gnome-ext"/*.css "$INSTALL_DIR/" 2>/dev/null || true
  cp "$TMPDIR/repo/gnome-ext"/schemas/*.xml "$INSTALL_DIR/schemas/"
  glib-compile-schemas "$INSTALL_DIR/schemas/"
  rm -rf "$TMPDIR"
else
  RELEASE_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$EXT_UUID.shell-extension.zip"
  echo "Downloading: $RELEASE_URL"
  cd /tmp
  curl -LO "$RELEASE_URL"
  filename=$(basename "$RELEASE_URL")
  gnome-extensions install --force /tmp/$filename
  rm -f /tmp/$filename
fi

# --- Configure API key ---
echo ""
echo "--- API Key Configuration ---"
if command_exists secret-tool; then
  echo "Setting up API key..."
  echo "Run the following to configure your API key:"
  echo "  secret-tool store --label='Voice-to-Text API Key' service mistral_api_key account $USER"
else
  echo "Install libsecret-tools for secure key storage:"
  echo "  sudo dnf install libsecret  # or equivalent"
  echo "Then set API keys via environment variables:"
  echo "  export VOXTRAL_API_KEY=<your-key>"
fi
echo ""

# Install default config (only if user has none)
CONFIG_DIR="$HOME/.config/voice-to-text"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
if [ -f "$CONFIG_FILE" ]; then
  echo "Existing config found at $CONFIG_FILE; leaving it unchanged."
else
  echo "Downloading default config..."
  curl -L -o "$CONFIG_FILE" "https://raw.githubusercontent.com/$REPO/main/config.yaml" || true
  if [ -f "$CONFIG_FILE" ]; then
    echo "Default config installed at $CONFIG_FILE."
  else
    echo "WARNING: Failed to download default config."
  fi
fi

# --- Configure dotool daemon (user service) ---
PIPE_PATH="/run/user/$(id -u)/dotool-pipe"

# Check input group membership (required for /dev/uinput access)
if ! id -nG | grep -qw input; then
  if getent group input >/dev/null 2>&1; then
    echo ""
    echo "WARNING: Your user is not in the 'input' group."
    echo "  dotoold needs access to /dev/uinput."
    echo "  Run: sudo usermod -aG input $USER"
    echo "  Then log out and back in (or reboot) before using voice-to-text."
  else
    echo ""
    echo "WARNING: The 'input' group does not exist."
    echo "  Run as root: sudo groupadd -r input && sudo usermod -aG input $USER"
    echo "  Then reboot before using voice-to-text."
  fi
fi

# Create dotoold-wrapper
WRAPPER_PATH="$HOME/.local/bin/dotoold-wrapper"
mkdir -p "$HOME/.local/bin"
cat > "$WRAPPER_PATH" << WRAPPER_EOF
#!/bin/bash
# Wrapper to ensure proper group membership and PATH for dotoold
export PATH="$HOME/.local/bin:\$PATH"
if id -nG "\$USER" | grep -qw input; then
  exec dotoold "\$@"
else
  # sg input -c requires a terminal; warn if running headless (e.g., via systemd)
  if [ -t 1 ]; then
    exec sg input -c "dotoold \$@"
  else
    echo "WARNING: dotoold needs 'input' group access but no terminal is available."
    echo "  Run: sudo usermod -aG input \$USER && logout"
    exec dotoold "\$@"
  fi
fi
WRAPPER_EOF
chmod +x "$WRAPPER_PATH"
echo "dotoold-wrapper created at $WRAPPER_PATH"

if [ -p "$PIPE_PATH" ] && systemctl --user is-active --quiet dotoold.service 2>/dev/null; then
  echo "dotoold pipe already present at $PIPE_PATH."
else
  echo "dotoold pipe missing. Creating user service..."

  mkdir -p ~/.config/systemd/user

  cat > ~/.config/systemd/user/dotoold.service <<EOF
[Unit]
Description=dotoold daemon for keyboard input
After=graphical-session.target
StartLimitBurst=3
StartLimitIntervalSec=60

[Service]
Type=simple
ExecStart=$HOME/.local/bin/dotoold-wrapper
Environment=DOTOOL_PIPE=$PIPE_PATH
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now dotoold.service
  sleep 1

  if [ -p "$PIPE_PATH" ]; then
    echo "dotoold started successfully. Pipe at $PIPE_PATH"
    echo "type voice-to-text service installed" | DOTOOL_PIPE="$PIPE_PATH" dotoolc
  else
    echo "ERROR: Pipe not found at $PIPE_PATH"
    journalctl --user -u dotoold.service --no-pager -n 20
    exit 1
  fi
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "The voice-to-text D-Bus service is now installed."
echo ""
echo "Next steps:"
echo "  1. Restart GNOME Shell (Alt+F2, r, Enter on X11) or log out/in on Wayland"
echo "  2. Set your API keys in environment variables or via secret-tool"
echo "  3. Use the hotkey (default: Super+Q) to start/stop recording"
echo ""
echo "Useful commands:"
echo "  ps aux | grep voice-to-text-dbus    # Check if service is running"
echo "  journalctl --user | grep voice      # Service logs"
echo "  gnome-extensions prefs $EXT_UUID    # Extension settings"
