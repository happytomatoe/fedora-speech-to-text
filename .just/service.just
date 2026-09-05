install:
    uv tool install -e .

uninstall:
    gnome-extensions disable voice-to-text@happytomatoe.com 2>/dev/null || true
    rm -rf ~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com
    rm -f ~/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service
    rm -f ~/.config/systemd/user/com.happytomatoe.VoiceToText.user.service
    rm -f ~/.local/bin/voice-to-text-dbus-wrapper
    rm -f ~/.local/bin/voice-to-text-dbus
    uv tool uninstall voice-to-text 2>/dev/null || true
    systemctl --user daemon-reload
    echo "Uninstalled extension, D-Bus service, and Python package."
# Reinstall Python package from source
reinstall: gnome-ext-install service-install
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Reinstalling voice-to-text from source..."
    uv tool install -e . --force
    echo "voice-to-text-dbus reinstalled from source"

# @category setup
# Store an API key in the OS keyring (service=voice-to-text)
build-python:
    uv build --out-dir dist

# @category service
# Install the D-Bus service (D-Bus activation only, no systemd)
service-install:
    uv tool install -e . --force
    mkdir -p ~/.local/share/dbus-1/services/ ~/.local/bin/ ~/.config/systemd/user/
    cp service/com.happytomatoe.VoiceToText.service ~/.local/share/dbus-1/services/
    cp service/com.happytomatoe.VoiceToText.user.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    @echo "Service installed. D-Bus activation handles startup automatically."

# @category service
# Uninstall the D-Bus service
service-uninstall:
    # Stop the running service before removing its files, otherwise an
    # already-active D-Bus process keeps serving with stale code.
    systemctl --user stop com.happytomatoe.VoiceToText.user.service 2>/dev/null || true
    systemctl --user disable com.happytomatoe.VoiceToText.user.service 2>/dev/null || true
    rm -f ~/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service
    rm -f ~/.config/systemd/user/com.happytomatoe.VoiceToText.user.service
    rm -f ~/.local/bin/voice-to-text-dbus-wrapper
    systemctl --user daemon-reload
    @echo "D-Bus service uninstalled."

# @category service
# Install parakeet-v2 as a Quadlet service (starts on boot)
parakeet-start-on-boot:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p ~/.config/containers/systemd
    cp parakeet-v2.container ~/.config/containers/systemd/parakeet-v2.container
    systemctl --user daemon-reload
    systemctl --user enable --now parakeet-v2.service
    echo "Parakeet v2 Quadlet service installed and started."
    echo "It will auto-start on boot."

# @category service
# Uninstall parakeet-v2 Quadlet service (stops and removes it)
parakeet-dont-start-on-boot:
    #!/usr/bin/env bash
    set -euo pipefail
    systemctl --user stop parakeet-v2.service 2>/dev/null || true
    systemctl --user disable parakeet-v2.service 2>/dev/null || true
    rm -f ~/.config/containers/systemd/parakeet-v2.container
    systemctl --user daemon-reload
    podman rm -f parakeet-v2 2>/dev/null || true
    echo "Parakeet v2 Quadlet service removed."
    echo "Model files in ~/parakeet/models/ were kept."

# @category service
# Start the service (runs in background via D-Bus activation or directly)
service-start:
    #!/usr/bin/env bash
    set -euo pipefail
    if pgrep -f voice-to-text-dbus >/dev/null 2>&1; then
        echo "Service already running"
    else
        "$HOME/.local/bin/voice-to-text-dbus" &
        sleep 1
        if pgrep -f voice-to-text-dbus >/dev/null 2>&1; then
            echo "Service started"
        else
            echo "Failed to start service"
            exit 1
        fi
    fi

# @category service
# Stop the running service (D-Bus activation will restart on next request)
service-stop:
    #!/usr/bin/env bash
    if pgrep -f voice-to-text-dbus >/dev/null 2>&1; then
        pkill -f voice-to-text-dbus
        echo "Service stopped"
    else
        echo "Service not running"
    fi

# @category service
# Run the service directly in the foreground (for debugging)
service-run:
    uv run voice-to-text-dbus

# @category service
# Show service process status
service-status:
    #!/usr/bin/env bash
    if pgrep -f voice-to-text-dbus >/dev/null 2>&1; then
        ps aux | grep voice-to-text-dbus | grep -v grep
    else
        echo "Service not running"
    fi

# @category service
# Tail service logs
service-logs:
    journalctl --user -f | grep voice

# @category service
# Tail D-Bus service logs (includes D-Bus activation logs and Python service logs)
dbus-logs:
    journalctl --user -f -u com.happytomatoe.VoiceToText.user.service

# @category service
# Show WPM statistics from recent recordings (default: last 100)
wpm *ARGS:
    ./scripts/wpm-stats.sh {{ ARGS }}

# @category service
# Restart the service by stopping it (D-Bus activation restarts on next extension use)
service-restart: service-stop
    @echo "Service stopped. It will auto-start when GNOME extension requests it."

# @category service
# Reinstall from source
service-reinstall: reinstall
    @echo "Done. Service will auto-start on next extension use."

# @category service
# Alias for reinstall (kept for backward compatibility)
reinstall-all: reinstall
    @echo "Done. Service and extension reinstalled."

# @category gnome-ext
# Install extension, then start a nested GNOME Shell for interactive development
# Usage: just gnome-ext-dev

setup:
    npm install
    lefthook install

store-secret:
    #!/usr/bin/env bash
    set -euo pipefail
    ./scripts/store-api-keys.sh

# @category setup
# Full development setup: system deps + Python dev deps
dev-setup: setup-deps dev-sync
    @echo "Development environment ready."

# @category setup
# Install system dependencies for development and E2E testing
setup-deps:
    #!/usr/bin/env bash
    set -euo pipefail

    # Package mappings: command to check -> package name
    declare -A FEDORA_PKGS=(
        [rsync]="rsync"
        [qemu-system-x86_64]="qemu-kvm"
        [virsh]="libvirt"
        [virt-install]="virt-install"
        [qemu-img]="qemu-img"
        [ssh]="openssh-clients"
    )

    declare -A UBUNTU_PKGS=(
        [rsync]="rsync"
        [qemu-system-x86_64]="qemu-kvm"
        [virsh]="libvirt-daemon-system"
        [virt-install]="virtinst"
        [qemu-img]="qemu-utils"
        [ssh]="openssh-client"
    )

    # Detect package manager
    if command -v rpm-ostree &>/dev/null; then
        PKG_MGR="rpm-ostree"
    elif command -v dnf &>/dev/null; then
        PKG_MGR="dnf"
    elif command -v apt &>/dev/null; then
        PKG_MGR="apt"
    else
        echo "ERROR: Unsupported package manager"
        exit 1
    fi

    # Check which packages are missing
    MISSING=()
    for cmd in "${!FEDORA_PKGS[@]}"; do
        if ! command -v "$cmd" &>/dev/null; then
            if [ "$PKG_MGR" = "apt" ]; then
                MISSING+=("${UBUNTU_PKGS[$cmd]}")
            else
                MISSING+=("${FEDORA_PKGS[$cmd]}")
            fi
        fi
    done

    if [ ${#MISSING[@]} -eq 0 ]; then
        echo "All system dependencies already installed."
        exit 0
    fi

    echo "Missing packages: ${MISSING[*]}"
    echo "Installing..."

    case "$PKG_MGR" in
        rpm-ostree) sudo rpm-ostree install -y "${MISSING[@]}" ;;
        dnf)        sudo dnf install -y "${MISSING[@]}" ;;
        apt)        sudo apt install -y "${MISSING[@]}" ;;
    esac

    echo "System dependencies installed."

# @category setup
# Sync Python dev dependencies (pytest, ruff, pyright, etc.)
dev-sync:
    uv sync
    @echo "Dev dependencies synced."

