#!/usr/bin/env bash
set -euo pipefail

# --- Constants ---
REPO="happytomatoe/voice-to-text"
EXT_UUID="voice-to-text@happytomatoe.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
DBUS_SERVICE_DIR="$HOME/.local/share/dbus-1/services"

# --- Helper functions ---
command_exists() {
  command -v "$1" &>/dev/null
}

install_pkg() {
  local pkg="$1"
  if command_exists "$pkg"; then
    echo "  $pkg already installed, skipping."
    return 0
  fi
  if rpm -q "$pkg" &>/dev/null; then
    echo "  $pkg already installed, skipping."
    return 0
  fi
  echo "  Installing $pkg..."
  sudo "$PKG_MGR" install -y "$pkg" || true
}

# --- High-level functions ---
detect_os() {
  if command_exists rpm-ostree; then
    PKG_MGR="rpm-ostree"
  elif command_exists dnf; then
    PKG_MGR="dnf"
  else
    echo "ERROR: This installer requires Fedora (dnf or rpm-ostree)."
    exit 1
  fi
  echo "Detected package manager: $PKG_MGR"
  echo ""
}

install_prerequisites() {
  echo "Installing prerequisites..."
  install_pkg unzip
  install_pkg curl
  install_pkg wget2
  # Fedora 42 names the binary wget2, but SileroVAD calls wget
  [ -e /usr/bin/wget ] || ln -sf /usr/bin/wget2 /usr/bin/wget
  install_pkg libsecret

  if ! command_exists dotool; then
    if [ "$UPGRADE" = true ]; then
      echo ""
      echo "WARNING: dotool is not installed."
    else
      echo ""
      echo "dotool is a keyboard input tool. We can build it from source now"
      echo "or you can use other output methods like the ones Fedora's internal API provides by default."
      read -p "Install dotool now? [Y/n] " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        install_dotool || echo "WARNING: dotool installation failed (non-fatal)"
      fi
    fi
  fi
}

install_dotool() {
  if command_exists dotool && command_exists dotoold && command_exists dotoolc; then
    echo "  dotool already installed, skipping."
    return 0
  fi

  echo "  Building dotool from source..."
  local BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  export PATH="$BIN_DIR:$PATH"

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

  echo "  Attempting direct build..."
  local BUILD_DEPS="gcc make libev-devel systemd-devel"
  local install_ok=false
  sudo "$PKG_MGR" install -y $BUILD_DEPS git 2>/dev/null && install_ok=true
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

install_uv() {
  if command_exists uv; then
    echo "uv already installed, skipping."
    return 0
  fi
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command_exists uv; then
    echo "ERROR: Failed to install uv."
    exit 1
  fi
  echo "uv installed."
}

fetch_latest_tag() {
  echo "Fetching latest release tag..."
  LATEST_TAG=$(
    GIT_TERMINAL_PROMPT=0 timeout 30 git ls-remote --tags --sort=-v:refname "https://github.com/$REPO.git" |
      awk -F'/' '$NF !~ /\^\{\}$/ { print $NF; exit }' || true
  )
  if [ -z "$LATEST_TAG" ]; then
    echo "ERROR: Could not fetch release tags for $REPO."
    echo "  Check your network connection and try again."
    exit 1
  fi
  echo "Found version $LATEST_TAG"
}

install_python_service() {
  echo ""
  echo "--- Installing Python D-Bus service ---"
  echo "Installing version $LATEST_TAG..."
  uv tool install "git+https://github.com/$REPO.git@$LATEST_TAG" --force
  echo "Python D-Bus service installed (voice-to-text-dbus)."
}

install_dbus_services() {
  echo ""
  echo "--- Installing D-Bus service files ---"
  mkdir -p "$DBUS_SERVICE_DIR"
  mkdir -p "$HOME/.local/bin"

  if [ -f "service/com.happytomatoe.VoiceToText.service" ]; then
    cp service/com.happytomatoe.VoiceToText.service "$DBUS_SERVICE_DIR/"
    echo "Copied D-Bus service file."
  else
    echo "Downloading D-Bus service file from repository..."
    curl -sL "https://raw.githubusercontent.com/$REPO/$LATEST_TAG/service/com.happytomatoe.VoiceToText.service" -o "$DBUS_SERVICE_DIR/com.happytomatoe.VoiceToText.service"
  fi

  local SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"
  # Try local copy first (for --local installs), fall back to download
  if [ -f "service/com.happytomatoe.VoiceToText.user.service" ]; then
    cp service/com.happytomatoe.VoiceToText.user.service "$SYSTEMD_DIR/"
    echo "Copied systemd user service."
  elif curl -sL "https://raw.githubusercontent.com/$REPO/$LATEST_TAG/service/com.happytomatoe.VoiceToText.user.service" -o "$SYSTEMD_DIR/com.happytomatoe.VoiceToText.user.service"; then
    echo "Downloaded systemd user service."
  else
    echo "WARNING: Could not install systemd user service."
  fi
  systemctl --user daemon-reload
}

install_gnome_extension() {
  echo ""
  echo "--- Installing GNOME extension ---"

  if [ -n "${LOCAL_DIR:-}" ]; then
    echo "Installing from local directory: $LOCAL_DIR"
    mkdir -p "$INSTALL_DIR"
    rsync -av --delete \
      --include='prefs/' --include='prefs/**' \
      --include='schemas/' --include='schemas/**' \
      --include='vendor/' --include='vendor/**' \
      --include='*.js' --include='*.json' --include='*.css' \
      --exclude='*' \
      "$LOCAL_DIR/" "$INSTALL_DIR/"
    glib-compile-schemas "$INSTALL_DIR/schemas/"
  else
    RELEASE_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$EXT_UUID.shell-extension.zip"
    echo "Downloading: $RELEASE_URL"
    local TMPDIR
    TMPDIR=$(mktemp -d)
    curl -L -o "$TMPDIR/extension.zip" "$RELEASE_URL"
    gnome-extensions install --force "$TMPDIR/extension.zip"
    rm -rf "$TMPDIR"
  fi
}

enable_extension() {
  echo ""
  echo "--- Enabling GNOME extension ---"

  if gnome-extensions enable "$EXT_UUID" 2>/dev/null; then
    echo "Extension enabled."
  elif command_exists dconf; then
    local CURRENT
    CURRENT=$(dconf read /org/gnome/shell/enabled-extensions)
    if ! echo "$CURRENT" | grep -q "$EXT_UUID"; then
      if [ -z "$CURRENT" ] || [ "$CURRENT" = "[]" ]; then
        dconf write /org/gnome/shell/enabled-extensions "['$EXT_UUID']"
      else
        dconf write /org/gnome/shell/enabled-extensions "${CURRENT%]}, '$EXT_UUID']"
      fi
    fi
    echo "Extension added to dconf. It will be active on next GNOME Shell login."
  else
    echo "WARNING: Could not enable extension. Enable it manually: gnome-extensions enable $EXT_UUID"
  fi
}

configure_api_key() {
  echo ""
  echo "--- API Key Configuration ---"
  if command_exists secret-tool; then
    echo "Run the following to configure your API key:"
    echo "  secret-tool store --label='Voice-to-Text API Key' service mistral_api_key account $USER"
  else
    echo "Install libsecret-tools for secure key storage:"
    echo "  sudo dnf install libsecret"
    echo "Then set API keys via environment variables:"
    echo "  export VOXTRAL_API_KEY=<your-key>"
  fi
}

install_config() {
  local CONFIG_DIR="$HOME/.config/voice-to-text"
  local CONFIG_FILE="$CONFIG_DIR/config.yaml"
  mkdir -p "$CONFIG_DIR"

  if [ -f "$CONFIG_FILE" ]; then
    echo "Existing config found at $CONFIG_FILE; leaving it unchanged."
  else
    echo "Downloading default config..."
    curl -L -o "$CONFIG_FILE" "https://raw.githubusercontent.com/$REPO/$LATEST_TAG/config.yaml" || true
    if [ -f "$CONFIG_FILE" ]; then
      echo "Default config installed at $CONFIG_FILE."
    else
      echo "WARNING: Failed to download default config."
    fi
  fi
}

configure_dotool() {
  local PIPE_PATH="/run/user/$(id -u)/dotool-pipe"

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

  local WRAPPER_PATH="$HOME/.local/bin/dotoold-wrapper"
  mkdir -p "$HOME/.local/bin"
  cat > "$WRAPPER_PATH" << 'WRAPPER_EOF'
#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"
if id -nG "$USER" | grep -qw input; then
  exec dotoold "$@"
else
  if [ -t 1 ]; then
    exec sg input -c "dotoold $@"
  else
    echo "WARNING: dotoold needs 'input' group access but no terminal is available."
    echo "  Run: sudo usermod -aG input $USER && logout"
    exec dotoold "$@"
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
}

print_summary() {
  echo ""
  if [ "$UPGRADE" = true ]; then
    echo "=== Upgrade Complete ==="
  else
    echo "=== Installation Complete ==="
  fi
  echo ""
  echo "Next steps:"
  echo "  1. Restart GNOME Shell (Alt+F2, r, Enter on X11) or log out/in on Wayland"
  if [ "$UPGRADE" = false ]; then
    echo "  2. Set your API keys in environment variables or via secret-tool"
    echo "  3. Use the hotkey (default: Super+Q) to start/stop recording"
  fi
  echo ""
  echo "Useful commands:"
  echo "  ps aux | grep voice-to-text-dbus    # Check if service is running"
  echo "  journalctl --user | grep voice      # Service logs"
  echo "  gnome-extensions prefs $EXT_UUID    # Extension settings"
}

# --- Parse arguments ---
LOCAL_DIR=""
for arg in "$@"; do
  if [ "$arg" = "--debug" ]; then
    set -x
  fi
done
for ((i=1; i<=$#; i++)); do
  if [ "${!i}" = "--local" ]; then
    next=$((i+1))
    LOCAL_DIR="${!next}"
  fi
done
if [ -n "$LOCAL_DIR" ] && [ ! -d "$LOCAL_DIR" ]; then
  echo "ERROR: --local directory does not exist: $LOCAL_DIR" >&2
  exit 1
fi

# Auto-detect: upgrade if extension or Python package already exists
UPGRADE=false
if [ -d "$INSTALL_DIR" ] || command_exists voice-to-text-dbus; then
  UPGRADE=true
fi
# --- Main ---
main() {
  detect_os
  install_prerequisites
  install_uv
  # Skip fetch_latest_tag when using local directory (no git needed)
  if [ -z "$LOCAL_DIR" ]; then
    fetch_latest_tag
  else
    LATEST_TAG="local"
  fi
  # Skip Python service install when using local dir (deployed separately)
  if [ -z "$LOCAL_DIR" ]; then
    install_python_service
  fi
  install_dbus_services
  install_gnome_extension
  enable_extension
  if [ "$UPGRADE" = false ]; then
    configure_api_key
  fi
  install_config
  configure_dotool
  print_summary
}

main
