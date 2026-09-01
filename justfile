default:
    @just --list

# @category e2e-qemu
# Install SPICE viewer (Remote Viewer) via Flatpak
install-spice-client:
    flatpak install -y flathub org.virt_manager.virt-viewer
    # Block GNOME Shell portal to suppress "Allow inhibiting shortcuts" dialog
    # This prevents the app from requesting shortcut inhibition via the portal
    flatpak override --user --no-talk-name=org.gnome.Shell org.virt_manager.virt-viewer

# @category setup
# Install npm deps (lefthook) and set up git hooks
setup:
    npm install
    lefthook install

run *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.__main__ {{ args }}

test:
    uv run pytest -n auto

# @category lint
# Run all linters (Python + GNOME extension)
lint:
    uv run ruff check .
    uv run ruff format --check .
    uv run pyright
    just gnome-ext-lint
    just check-output-methods-sync
    echo "All lint checks passed!"

# @category lint
# Check output methods are in sync across engine, prefs, and schema
check-output-methods-sync:
    ./scripts/check-output-methods-sync.sh

# @category lint
# Auto-fix lint issues
lint-fix:
    uv run ruff check --fix .
    uv run ruff format .
    echo "Lint fixes applied."
# @category test
test-all: test

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

build-python:
    uv build --out-dir dist

# @category service
# Install the D-Bus service (D-Bus activation only, no systemd)
service-install:
    uv tool install -e .
    mkdir -p ~/.local/share/dbus-1/services/ ~/.local/bin/ ~/.config/systemd/user/
    cp service/com.happytomatoe.VoiceToText.service ~/.local/share/dbus-1/services/
    cp service/com.happytomatoe.VoiceToText.user.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    @echo "Service installed. D-Bus activation handles startup automatically."

# @category service
# Uninstall the D-Bus service
service-uninstall:
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
[no-exit-message]
gnome-ext-dev: reinstall gnome-ext-install
    #!/usr/bin/env bash
    set -euxo pipefail
    # Load provider API keys from the system keyring in the parent session
    # (where the Secret Service is reachable) so the nested D-Bus service
    # inherits them. The wrapper does this for the real service; dev
    # launches voice-to-text-dbus directly and must load keys here instead.
    if command -v secret-tool &>/dev/null; then
        export VOXTRAL_API_KEY=$(secret-tool lookup service voice-to-text username voxtral 2>/dev/null)
        export DEEPGRAM_API_KEY=$(secret-tool lookup service voice-to-text username deepgram 2>/dev/null)
        export GROQ_API_KEY=$(secret-tool lookup service voice-to-text username groq 2>/dev/null)
        export ELEVENLABS_API_KEY=$(secret-tool lookup service voice-to-text username elevenlabs 2>/dev/null)
        export SIXTYDB_API_KEY=$(secret-tool lookup service voice-to-text username 60db 2>/dev/null)
    fi
    if [ -n "${TOOLBOX_PATH:-}" ] || [ "${container:-}" = "oci" ]; then
        echo "Error: Cannot start a development GNOME Shell from within a toolbox container. Run this command on the host system." >&2
        exit 1
    fi
    LOG_DIR="$PWD/logs"
    LOG_FILE="$LOG_DIR/dev.log"
    mkdir -p "$LOG_DIR"
    echo "" > "$LOG_FILE"
    if ! rpm -q mutter-devkit &>/dev/null; then
        echo "mutter-devkit not installed, installing..."
        if command -v rpm-ostree &>/dev/null; then
            sudo rpm-ostree install mutter-devkit
            echo "mutter-devkit was staged via rpm-ostree. Reboot, then rerun 'just dev'." >&2
            exit 1
        else
            sudo dnf install -y mutter-devkit
        fi
    fi
    GNOME_VERSION=$(gnome-shell --version | awk '{print int($3)}')
    if [ "$GNOME_VERSION" -ge 49 ]; then
      DEVKIT_FLAG=--devkit
      export MUTTER_DEBUG_NESTED=
    else
      DEVKIT_FLAG=--nested
      export MUTTER_DEBUG_NESTED=1
    fi

    # Start the D-Bus service inside the isolated session bus so the
    # GNOME extension can find and call it on real hardware.
    # Also start AT-SPI accessibility bus for UI inspection.
    # Trap EXIT/INT/TERM to kill the background services when the shell exits,
    # Remove gnome-shell-disable-extensions file (disables all extensions in nested session)
    rm -f /run/user/1000/gnome-shell-disable-extensions
    export LOG_FILE DEVKIT_FLAG
    dbus-run-session -- sh "$PWD/scripts/gnome-ext-dev-session.sh"
    echo "Logs written to $LOG_FILE"
# @category gnome-ext
# Start nested GNOME Shell and wait for GDM registration, then check for errors
gnome-ext-check: reinstall gnome-ext-install
    #!/usr/bin/env bash
    set -euo pipefail
    LOG_DIR="$PWD/logs"
    LOG_FILE="$LOG_DIR/dev.log"
    mkdir -p "$LOG_DIR"
    echo "" > "$LOG_FILE"
    if ! rpm -q mutter-devkit &>/dev/null; then
        echo "mutter-devkit not installed, installing..."
        if command -v rpm-ostree &>/dev/null; then
            sudo rpm-ostree install mutter-devkit
            echo "mutter-devkit was staged via rpm-ostree. Reboot, then rerun." >&2
            exit 1
        else
            sudo dnf install -y mutter-devkit
        fi
    fi
    UUID="voice-to-text@happytomatoe.com"
    CURRENT=$(dconf read /org/gnome/shell/enabled-extensions)
    if ! echo "$CURRENT" | grep -q "$UUID"; then
      if [ -z "$CURRENT" ] || [ "$CURRENT" = "[]" ]; then
        dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
      else
        dconf write /org/gnome/shell/enabled-extensions "${CURRENT%]}, '$UUID']"
      fi
    fi
    GNOME_VERSION=$(gnome-shell --version | awk '{print int($3)}')
    if [ "$GNOME_VERSION" -ge 49 ]; then
      DEVKIT_FLAG=--devkit
      export MUTTER_DEBUG_NESTED=
    else
      DEVKIT_FLAG=--nested
      export MUTTER_DEBUG_NESTED=1
    fi
    # Start nested shell in background
    dbus-run-session -- sh -c "
      /usr/libexec/at-spi-bus-launcher >> \"$LOG_FILE\" 2>&1 &
      ATSPI_PID=\$!
      sleep 0.5
      /usr/libexec/at-spi2-registryd --use-gnome-session >> \"$LOG_FILE\" 2>&1 &
      ATSPI_REG_PID=\$!
      sleep 0.5
      voice-to-text-dbus >> \"$LOG_FILE\" 2>&1 &
      DBUS_PID=\$!
      sleep 1
      trap 'kill \$DBUS_PID \$ATSPI_PID \$ATSPI_REG_PID 2>/dev/null || true' EXIT INT TERM
      gnome-shell --wayland --headless $DEVKIT_FLAG
    " >> "$LOG_FILE" 2>&1 &
    NESTED_PID=$!
    echo "Nested shell started (PID: $NESTED_PID), waiting for GDM..."
    # Wait for GDM registration or timeout
    TIMEOUT=15
    for i in $(seq 1 $TIMEOUT); do
      if grep -q "Registering display with GDM" "$LOG_FILE" 2>/dev/null; then
        echo "✅ GDM registered (${i}s)"
        sleep 1  # Let extension finish loading
        break
      fi
      if ! ps -p $NESTED_PID >/dev/null 2>&1; then
        echo "❌ Nested shell exited prematurely"
        break
      fi
      sleep 1
    done
    if [ $i -eq $TIMEOUT ]; then
      echo "⚠️  Timeout waiting for GDM (${TIMEOUT}s)"
    fi
    # Check for extension errors
    echo ""
    echo "=== Extension Status ==="
    if grep -q "CRITICAL.*extension" "$LOG_FILE" 2>/dev/null || grep -q "SyntaxError" "$LOG_FILE" 2>/dev/null; then
      echo "❌ Extension errors found:"
      grep -E "CRITICAL|SyntaxError|Error.*extension" "$LOG_FILE" | tail -5
      exit 1
    elif grep -q "VoiceToText" "$LOG_FILE" 2>/dev/null; then
      echo "✅ Extension loaded successfully"
      grep "VoiceToText" "$LOG_FILE" | tail -5
    else
      echo "⚠️  No extension messages found in logs"
    fi
    echo ""
    echo "Full log: $LOG_FILE"
    echo "Kill with: kill $NESTED_PID"
    wait $NESTED_PID 2>/dev/null
# Install extension files directly (no nested shell)
gnome-ext-install:
    #!/usr/bin/env bash
    set -euo pipefail
    UUID="voice-to-text@happytomatoe.com"
    DEST=$HOME/.local/share/gnome-shell/extensions/$UUID
    # No TypeScript build needed — extension is plain JS
    rsync -av --delete \
        --exclude='tests/' \
        --exclude='run-dev.sh' \
        --exclude='gjs-env.d.ts' \
        --exclude='bun.lock' \
        gnome-ext/ "$DEST/"
    glib-compile-schemas "$DEST/schemas/"
    echo "Extension installed to $DEST"

# Uninstall extension by removing it from the extensions directory
gnome-ext-uninstall:
    gnome-extensions disable voice-to-text@happytomatoe.com 2>/dev/null || true
    rm -rf ~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com
    echo "Extension uninstalled"

# @category gnome-ext
# Verify GTK4 widget APIs used in prefs.js actually exist (catches GTK3→GTK4 regressions)
gtk4-api-check:
    gjs --module gnome-ext/tests/test-gtk4-api.js
# Validate GNOME extension (syntax + schema)
gnome-ext-lint:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Checking JS syntax..."
    for f in gnome-ext/**/*.js gnome-ext/*.js; do
        [ -f "$f" ] && node --input-type=module --check < "$f" || exit 1
    done
    echo "Running static analysis tests..."
    gjs --module gnome-ext/tests/test-prefs-methods.js 2>&1 || exit 1
    echo "Running TypeScript type check..."
    npx tsc --noEmit 2>&1 || exit 1
    echo "Checking GTK4 API compatibility..."
    if [ -f gnome-ext/tests/test-gtk4-api.js ]; then
        gjs --module gnome-ext/tests/test-gtk4-api.js 2>&1 || exit 1
    else
        echo "Skipping GTK4 API check (test file not found)"
    fi
    echo "Validating GSettings schema..."
    python3 -c "import xml.etree.ElementTree as ET; ET.parse('gnome-ext/schemas/org.gnome.shell.extensions.voice-to-text.gschema.xml')"
    glib-compile-schemas --strict gnome-ext/schemas/ 2>&1 || exit 1
    echo "All checks passed!"
# Reinstall files and reset in GNOME Shell

# @category gnome-ext
# Quick check: run nested shell for N seconds and report errors (headless by default)
gnome-ext-quick-check TIMEOUT='8': reinstall gnome-ext-install
    #!/usr/bin/env bash
    set -uo pipefail

    LOG_DIR="$PWD/logs"
    LOG_FILE="$LOG_DIR/gnome-ext-quick-check.log"
    mkdir -p "$LOG_DIR"
    echo "" > "$LOG_FILE"

    if ! rpm -q mutter-devkit &>/dev/null; then
        echo "mutter-devkit not installed, installing...";
        if command -v rpm-ostree &>/dev/null; then
            sudo rpm-ostree install mutter-devkit;
            echo "mutter-devkit was staged via rpm-ostree. Reboot, then rerun 'just gnome-ext-quick-check'." >&2;
            exit 1;
        else
            sudo dnf install -y mutter-devkit;
        fi
    fi

    UUID="voice-to-text@happytomatoe.com"
    CURRENT=$(dconf read /org/gnome/shell/enabled-extensions)
    if ! echo "$CURRENT" | grep -q "$UUID"; then
      if [ -z "$CURRENT" ] || [ "$CURRENT" = "[]" ]; then
        dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
      else
        dconf write /org/gnome/shell/enabled-extensions "${CURRENT%]}, '$UUID']"
      fi
    fi

    export MUTTER_DEBUG_NESTED=
    export MUTTER_DEBUG=1

    # Run in a new process group; on EXIT/INT/TERM kill the whole tree.
    cleanup() { kill -- -$(ps -o pgid= -p $BASHPID | tr -d ' ') 2>/dev/null || true; }
    trap cleanup EXIT INT TERM
    echo "Running nested shell for {{ TIMEOUT }}s (headless)..."
    timeout {{ TIMEOUT }} setsid bash -c '
      dbus-run-session -- sh -c "
        /usr/libexec/at-spi-bus-launcher >> \"$LOG_FILE\" 2>&1 &
        sleep 0.3
        voice-to-text-dbus >> \"$LOG_FILE\" 2>&1 &
        sleep 0.5
        gnome-shell --wayland --headless --devkit
      "
    ' 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=${PIPESTATUS[0]}

    echo ""
    echo "=== Results ==="

    # Check for extension errors
    if grep -q "CRITICAL.*extension" "$LOG_FILE" 2>/dev/null || grep -q "SyntaxError" "$LOG_FILE" 2>/dev/null; then
        echo "❌ Extension errors found:"
        grep -E "CRITICAL|SyntaxError|Error.*extension|parsing error" "$LOG_FILE" | tail -10
        exit 1
    elif grep -q "VoiceToText" "$LOG_FILE" 2>/dev/null; then
        echo "✅ Extension loaded successfully"
        grep "VoiceToText" "$LOG_FILE" | tail -5
    else
        echo "⚠️  No extension messages found"
    fi

    if [ $EXIT_CODE -eq 124 ]; then
        echo "✅ Timeout reached (expected)"
    fi
    if [ "$EXIT_CODE" -ne 0 ] && [ "$EXIT_CODE" -ne 124 ]; then
        echo "❌ Nested GNOME Shell exited with status $EXIT_CODE"
        exit "$EXIT_CODE"
    fi

    echo ""
    echo "Full log: $LOG_FILE"
gnome-ext-reload:
    ./gnome-ext/run-dev.sh && gnome-extensions reset voice-to-text@happytomatoe.com && gnome-extensions enable voice-to-text@happytomatoe.com

# Pack extension into a ZIP for distribution
gnome-ext-pack:
    #!/usr/bin/env bash
    UUID="voice-to-text@happytomatoe.com"
    SRC="gnome-ext"
    rm -rf "dist/$UUID"
    rsync -av \
        --exclude='tests/' \
        --exclude='run-dev.sh' \
        --exclude='gjs-env.d.ts' \
        --exclude='bun.lock' \
        "$SRC/" "dist/$UUID/"
    glib-compile-schemas "dist/$UUID/schemas/"
    rm -f "dist/$UUID.shell-extension.zip"
    cd "dist/$UUID" && zip -r "../$UUID.shell-extension.zip" . -x '*.pyc' '__pycache__/*'
    echo "Extension packed to dist/$UUID.shell-extension.zip"

# @category e2e
# Watch container via VNC (real-time live view)
# Usage: just container-watch
container-watch:
    #!/usr/bin/env bash
    set -euo pipefail

    # Find running container
    POD=$(podman ps --filter ancestor=voice-to-text-e2e --format '{'{'.ID'}'}' | head -1)
    if [ -z "$POD" ]; then
      echo "No running voice-to-text-e2e container found."
      echo "Start one with: just e2e-full (in background) or podman run..."
      exit 1
    fi

    echo "Found container: $POD"

    # Install x11vnc as root (not gnomeshell user)
    echo "Installing x11vnc..."
    podman exec $POD dnf install -y --nogpgcheck x11vnc 2>/dev/null || true

    # Kill any existing VNC server
    podman exec --user gnomeshell $POD pkill x11vnc 2>/dev/null || true
    sleep 1

    # Start VNC server with -noshm to fix MIT-SHM error
    echo "Starting VNC server on port 5900..."
    podman exec --user gnomeshell -e DISPLAY=:100 -d $POD bash -c "nohup /usr/bin/x11vnc -display :100 -nopw -forever -shared -rfbport 5900 -noshm > /tmp/x11vnc.log 2>&1 &"
    sleep 3

    # Verify it started
    echo "Checking VNC server..."
    podman exec --user gnomeshell $POD cat /tmp/x11vnc.log 2>/dev/null | tail -5 || echo "No log yet"

    echo ""
    echo "========================================="
    echo "VNC server is running!"
    echo "Connect with any VNC client to: localhost:5900"
    echo ""
    echo "Suggested viewers:"
    echo "  - GNOME Connections"
    echo "  - Remmina"
    echo "  - TigerVNC Viewer"
    echo "  - macOS Screen Sharing (vnc://localhost:5900)"
    echo "========================================="
    echo ""
    echo "Press Ctrl+C to stop the VNC server"

    # Keep script running and cleanup on exit
    trap "podman exec --user gnomeshell $POD pkill x11vnc 2>/dev/null || true; echo 'VNC server stopped.'" EXIT
    # Block until user presses Ctrl+C (wait won't work since no background jobs in this shell)
    while true; do sleep 3600; done

# @category e2e-qemu
# Kill any running QEMU E2E test VM
qemu-e2e-kill:
    #!/usr/bin/env bash
    set -euo pipefail
    PID_FILE="e2e/qemu-images/qemu.pid"
    if [[ -f "${PID_FILE}" ]]; then
        PID=$(cat "${PID_FILE}")
        if kill -0 "${PID}" 2>/dev/null; then
            echo "Killing QEMU (PID ${PID})..."
            kill "${PID}" 2>/dev/null || true
            sleep 2
            kill -9 "${PID}" 2>/dev/null || true
        else
            echo "QEMU PID ${PID} not running"
        fi
        rm -f "${PID_FILE}"
    fi
    # Also kill any stray QEMU processes
    # Kill only QEMU processes using THIS repo's overlay (not unrelated VMs)
    pkill -9 -f "qemu-system-x86.*overlay.qcow2" 2>/dev/null || true
    rm -f e2e/qemu-images/overlay.qcow2 e2e/qemu-images/qemu-monitor.sock
    echo "Done"

# @category e2e-qemu
# Start QEMU E2E test VM (keeps running for SPICE connection)
qemu-e2e-vm port='5930':
    #!/usr/bin/env bash
    set -euo pipefail
    VM_DIR="e2e/qemu-images"
    VM_DIR_ABS="$(pwd)/${VM_DIR}"

    # Kill any existing QEMU for this VM (use specific path to avoid killing unrelated VMs)
    if [ -f "${VM_DIR_ABS}/qemu.pid" ]; then
        QEMU_PID=$(cat "${VM_DIR_ABS}/qemu.pid")
        # Verify the PID is a QEMU process before killing
        if ps -p "$QEMU_PID" -o comm= 2>/dev/null | grep -q qemu; then
            kill -9 "$QEMU_PID" 2>/dev/null || true
        fi
        rm -f "${VM_DIR_ABS}/qemu.pid"
    fi
    sleep 1

    # Create fresh overlay
    rm -f "${VM_DIR_ABS}/overlay.qcow2"
    qemu-img create -f qcow2 -b "${VM_DIR_ABS}/base.qcow2" -F qcow2 "${VM_DIR_ABS}/overlay.qcow2"

    # Start QEMU with SPICE
    cd "${VM_DIR_ABS}"
    qemu-system-x86_64 \
        -enable-kvm \
        -cpu host \
        -m 4096 \
        -smp 2 \
        -drive file=overlay.qcow2,format=qcow2,if=virtio \
        -device virtio-vga \
        -display vnc=:1 \
        -spice port={{ port }},disable-ticketing=on \
        -monitor unix:qemu-monitor.sock,server,nowait \
        -serial file:serial.log \
        -netdev user,id=net0,hostfwd=tcp::2222-:22 \
        -device virtio-net-pci,netdev=net0 \
        -cdrom cloud-init.iso \
        -no-reboot &
    QEMU_PID=$!
    echo $QEMU_PID > qemu.pid

    echo "QEMU started (PID: ${QEMU_PID})"
    echo ""
    echo "Waiting for SSH..."
    ssh_ready=false
    for i in $(seq 1 30); do
        if ssh -i id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -p 2222 testuser@localhost echo ok 2>/dev/null; then
            echo "SSH ready (${i}s)"
            ssh_ready=true
            break
        fi
        echo -n "."
        sleep 2
    done

    if [ "$ssh_ready" = false ]; then
        echo ""
        echo "❌ ERROR: SSH connection failed after 60 seconds"
        kill "${QEMU_PID}" 2>/dev/null || true
        rm -f "${VM_DIR_ABS}/qemu.pid"
        exit 1
    fi

    echo ""
    echo "=== VM is ready ==="
    echo "SPICE: remote-viewer spice://localhost:5930"
    echo "  or:  just e2e-test-view"
    echo "SSH:   ssh -i ${VM_DIR}/id_ed25519 -p 2222 testuser@localhost"
    echo "Kill:  just qemu-e2e-kill"
    echo ""
    echo "Press Ctrl+C to stop the VM"

    # Wait for user interrupt
    trap "echo ''; echo 'Shutting down VM...'; kill ${QEMU_PID} 2>/dev/null || true; exit 0" INT TERM
    wait ${QEMU_PID} 2>/dev/null || true

# @category e2e-qemu
# Open SPICE viewer to QEMU E2E test VM
# Usage: just e2e-test-view [spice_port] [ssh_port]
# If no ports specified, auto-detects from listening QEMU processes
e2e-test-view spice_port='' ssh_port='':
    #!/usr/bin/env bash
    set -euo pipefail

    # Auto-detect ports if not specified
    if [ -z "{{ spice_port }}" ]; then
        # Find SPICE port from QEMU processes (look for -spice port=XXXX)
        SPICE_PORT=$(ps aux | grep -oP 'qemu.*-spice port=\K\d+' | head -1 || true)
        if [ -z "$SPICE_PORT" ]; then
            # Fallback: find any listening port in SPICE range (5930-5999)
            SPICE_PORT=$(ss -tlnp 2>/dev/null | grep -oP ':\K(59[3-9]\d)\b' | head -1 || true)
        fi
        if [ -z "$SPICE_PORT" ]; then
            echo "ERROR: Could not auto-detect SPICE port"
            echo "Specify manually: just e2e-test-view <spice_port> <ssh_port>"
            exit 1
        fi
    else
        SPICE_PORT="{{ spice_port }}"
    fi

    if [ -z "{{ ssh_port }}" ]; then
        # Find SSH port from QEMU processes (look for hostfwd=tcp::XXXX-:22)
        SSH_PORT=$(ps aux | grep -oP 'hostfwd=tcp::\K\d+' | head -1 || true)
        if [ -z "$SSH_PORT" ]; then
            SSH_PORT="2222"  # Default fallback
        fi
    else
        SSH_PORT="{{ ssh_port }}"
    fi

    echo "Using SPICE port: $SPICE_PORT, SSH port: $SSH_PORT"

    if ! ss -tlnp | grep -q ":$SPICE_PORT "; then
        echo "ERROR: QEMU VM not running (no SPICE on port $SPICE_PORT)"
        echo "Run 'just e2e' or 'just qemu-e2e-test-host' first."
        exit 1
    fi

    SSH_KEY="e2e/qemu-images/id_ed25519"
    SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $SSH_PORT testuser@localhost"
    # Wait for GDM login screen
    echo -n "Waiting for GDM..."
    for i in $(seq 1 30); do
        if $SSH "pgrep -x gdm >/dev/null 2>&1"; then
            echo " ready"
            break
        fi
        sleep 1
        echo -n "."
    done
    sleep 2
    # Wait for GNOME Shell to be ready
    echo -n "Waiting for desktop..."
    for i in $(seq 1 30); do
        if $SSH "pgrep -x gnome-shell >/dev/null 2>&1"; then
            echo " ready"
            break
        fi
        sleep 1
        echo -n "."
    done
    # Dismiss lock screen if present
    $SSH "echo 'key Escape' > /run/user/1000/dotool-pipe" 2>/dev/null || true
    sleep 0.5
    echo "Connecting to QEMU VM via SPICE (localhost:$SPICE_PORT)..."
    if flatpak list --app 2>/dev/null | grep -q org.virt_manager.virt-viewer; then
        flatpak run org.virt_manager.virt-viewer spice://localhost:$SPICE_PORT &
    elif command -v remote-viewer &>/dev/null; then
        remote-viewer spice://localhost:$SPICE_PORT &
    elif command -v remmina &>/dev/null; then
        remmina spice://localhost:$SPICE_PORT &
    else
        echo "No SPICE client found. Install one:"
        echo "  just install-spice-client"
        echo "  sudo dnf install virt-viewer"
        exit 1
    fi
    SPICE_PID=$!
    # Wait for window to appear, then tile to right half
    sleep 2
    if command -v dotool &>/dev/null; then
        echo "Tiling window to right half..."
        printf 'keydown leftmeta\nkey right\nkeyup leftmeta\n' | dotool
        sleep 0.5
        # Click on left side of screen to focus terminal
        printf 'mouseto 0.25 0.5\nclick left\n' | dotool
    fi
    wait $SPICE_PID 2>/dev/null || true
# @category e2e-qemu
# Install QEMU/KVM on host (Fedora Silverblue — requires reboot)
qemu-install:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Installing QEMU/KVM on host via rpm-ostree..."
    rpm-ostree install qemu-kvm libvirt virt-install qemu-img
    echo "Packages staged. Run 'systemctl reboot' to activate."

# @category e2e-qemu
# Check E2E test prerequisites
qemu-e2e-check:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Checking E2E prerequisites..."

    # Check QEMU
    if ! command -v qemu-system-x86_64 &>/dev/null; then
        echo "❌ qemu-system-x86_64 not found. Run 'just qemu-install' first."
        exit 1
    fi
    echo "✓ QEMU installed: $(qemu-system-x86_64 --version | head -1)"

    # Check KVM
    if ! lsmod | grep -q kvm; then
        echo "❌ KVM modules not loaded. Run 'sudo modprobe kvm kvm_intel' or 'kvm_amd'."
        exit 1
    fi
    echo "✓ KVM available"

    # Check base image (qemu-e2e-vm uses base.qcow2)
    if [[ ! -f "e2e/qemu-images/base.qcow2" ]]; then
        echo "❌ Base image not found (e2e/qemu-images/base.qcow2). See docs/e2e-setup.md for instructions."
        exit 1
    fi
    echo "✓ Base image found"

    # Check SSH key
    if [[ ! -f "e2e/qemu-images/id_ed25519" ]]; then
        echo "❌ SSH key not found. Generate with: ssh-keygen -t ed25519 -f e2e/qemu-images/id_ed25519"
        exit 1
    fi
    echo "✓ SSH key found"

    # Check bun
    if ! command -v bun &>/dev/null; then
        echo "❌ bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    echo "✓ bun installed"

    # Check npm deps
    if [[ ! -d "e2e/node_modules" ]]; then
        echo "Installing npm dependencies..."
        cd e2e && bun install
    fi
    echo "✓ npm dependencies installed"

    echo ""
    echo "All prerequisites met! Run 'just e2e' to execute tests."
# @category e2e-qemu
# Create base QEMU image with uv and dependencies
qemu-e2e-create-base:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Creating E2E base image..."
    echo ""
    echo "This script creates a QEMU base image for E2E testing."
    echo "See docs/e2e-setup.md for detailed instructions."
    echo ""

    VM_DIR="e2e/qemu-images"
    mkdir -p "$VM_DIR"

    # Check if image already exists
    if [[ -f "$VM_DIR/base.qcow2" ]]; then
        echo "Base image already exists: $VM_DIR/base.qcow2"
        echo "Delete it first or use 'just qemu-e2e-create-uv' to create UV-enhanced image."
        exit 1
    fi

    echo "Downloading Fedora Cloud image (this may take a few minutes)..."
    wget -O "$VM_DIR/base.qcow2" https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2
    echo ""
    echo "Base image downloaded: $VM_DIR/base.qcow2"
    echo ""
    echo "Next steps:"
    echo "  1. Generate SSH key: ssh-keygen -t ed25519 -f $VM_DIR/id_ed25519"
    echo "  2. Install virt-customize: sudo dnf install -y libguestfs-tools"
    echo "  3. Customize image: see docs/e2e-setup.md Step 3"
    echo "  4. Run 'just qemu-e2e-create-uv' to create UV-enhanced image"
    echo "  5. Run 'just qemu-e2e-check' to verify all prerequisites."

# @category e2e-qemu
# Create UV-enhanced base image (requires base.qcow2)
qemu-e2e-create-uv:
    ./e2e/scripts/create-base-with-uv.sh

# @category e2e-qemu
# Set up E2E test environment (check local copies first, fall back to Filen)
qemu-e2e-setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Setting up E2E test environment..."
    echo ""

    VM_DIR="e2e/qemu-images"
    MAIN_VM_DIR="../../main/e2e/qemu-images"
    mkdir -p "$VM_DIR"

    # 1. Golden image
    GOLDEN_FILE="$VM_DIR/golden-gnome-deps.qcow2"
    if [[ -f "$GOLDEN_FILE" ]]; then
        echo "✓ Golden image already exists: $GOLDEN_FILE"
    elif [[ -f "$MAIN_VM_DIR/golden-gnome-deps.qcow2" ]]; then
        echo "Copying golden image from main branch..."
        cp "$MAIN_VM_DIR/golden-gnome-deps.qcow2" "$GOLDEN_FILE"
        echo "✓ Copied: $GOLDEN_FILE"
    else
        echo "Downloading golden-gnome-deps.qcow2 from Filen..."
        filen download "/golden-gnome-deps.qcow2" "$GOLDEN_FILE"
        echo "✓ Downloaded: $GOLDEN_FILE"
    fi
    echo ""

    # 2. SSH keys
    if [[ -f "$VM_DIR/id_ed25519" && -f "$VM_DIR/id_ed25519.pub" ]]; then
        echo "✓ SSH keys already exist"
    elif [[ -f "$MAIN_VM_DIR/id_ed25519" ]]; then
        echo "Copying SSH keys from main branch..."
        cp "$MAIN_VM_DIR/id_ed25519" "$VM_DIR/id_ed25519"
        cp "$MAIN_VM_DIR/id_ed25519.pub" "$VM_DIR/id_ed25519.pub"
        chmod 600 "$VM_DIR/id_ed25519"
        echo "✓ SSH keys copied: $VM_DIR/id_ed25519"
    else
        echo "Downloading SSH keys from Filen..."
        [[ -f "$VM_DIR/id_ed25519" ]] || filen download "/id_ed25519" "$VM_DIR/id_ed25519"
        [[ -f "$VM_DIR/id_ed25519.pub" ]] || filen download "/id_ed25519.pub" "$VM_DIR/id_ed25519.pub"
        chmod 600 "$VM_DIR/id_ed25519"
        echo "✓ SSH keys downloaded: $VM_DIR/id_ed25519"
    fi
    echo ""

    # 2b. Overlay with 'ready' snapshot (from main worktree, else Filen)
    OVERLAY_FILE="$VM_DIR/persistent-run/main/overlay.qcow2"
    if [[ -f "$OVERLAY_FILE" ]]; then
        echo "✓ Overlay already exists: $OVERLAY_FILE"
    elif [[ -f "$MAIN_VM_DIR/persistent-run/main/overlay.qcow2" ]]; then
        echo "Copying overlay from main branch..."
        mkdir -p "$(dirname "$OVERLAY_FILE")"
        cp "$MAIN_VM_DIR/persistent-run/main/overlay.qcow2" "$OVERLAY_FILE"
        echo "✓ Copied: $OVERLAY_FILE"
    else
        echo "Downloading overlay.qcow2 from Filen..."
        mkdir -p "$(dirname "$OVERLAY_FILE")"
        filen download "/overlay.qcow2" "$OVERLAY_FILE"
        echo "✓ Downloaded: $OVERLAY_FILE"
    fi
    echo ""

    # 3. Cloud-init ISO (required by QEMU boot)
    CLOUD_INIT="$VM_DIR/cloud-init.iso"
    if [[ -f "$CLOUD_INIT" ]]; then
        echo "✓ Cloud-init ISO already exists: $CLOUD_INIT"
    elif [[ -f "$MAIN_VM_DIR/cloud-init.iso" ]]; then
        echo "Copying cloud-init ISO from main branch..."
        cp "$MAIN_VM_DIR/cloud-init.iso" "$CLOUD_INIT"
        echo "✓ Copied: $CLOUD_INIT"
    else
        echo "Creating cloud-init ISO..."
        PUB_KEY=$(cat "$VM_DIR/id_ed25519.pub")
        TEMP_DIR=$(mktemp -d)
        mkdir -p "$TEMP_DIR/cloud-init"
        echo "#cloud-config" > "$TEMP_DIR/cloud-init/user-data"
        echo "users:" >> "$TEMP_DIR/cloud-init/user-data"
        echo "  - name: testuser" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    ssh-authorized-keys:" >> "$TEMP_DIR/cloud-init/user-data"
        echo "      - $PUB_KEY" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    sudo: ALL=(ALL) NOPASSWD:ALL" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    groups: wheel,input" >> "$TEMP_DIR/cloud-init/user-data"
        echo "    shell: /bin/bash" >> "$TEMP_DIR/cloud-init/user-data"
        echo "" >> "$TEMP_DIR/cloud-init/user-data"
        echo "password: ''" >> "$TEMP_DIR/cloud-init/user-data"
        echo "chpasswd: { expire: false }" >> "$TEMP_DIR/cloud-init/user-data"
        echo "" >> "$TEMP_DIR/cloud-init/user-data"
        echo "package_update: false" >> "$TEMP_DIR/cloud-init/user-data"
        echo "packages: []" >> "$TEMP_DIR/cloud-init/user-data"
        echo "" >> "$TEMP_DIR/cloud-init/user-data"
        echo "runcmd:" >> "$TEMP_DIR/cloud-init/user-data"
        echo "  - systemctl set-default graphical.target" >> "$TEMP_DIR/cloud-init/user-data"
        mkisofs -output "$CLOUD_INIT" -volid cidata -joliet -rock "$TEMP_DIR/cloud-init" 2>/dev/null
        rm -rf "$TEMP_DIR"
        echo "✓ Cloud-init ISO created: $CLOUD_INIT"
    fi
    echo ""

    # 4. Create base.qcow2 overlay (backing image for VM runs)
    BASE_IMAGE="$VM_DIR/base.qcow2"
    if [[ -f "$BASE_IMAGE" ]]; then
        echo "✓ Base image already exists: $BASE_IMAGE"
    else
        echo "Creating base.qcow2 overlay from golden image..."
        qemu-img create -f qcow2 -b "$(realpath "$GOLDEN_FILE")" -F qcow2 "$BASE_IMAGE"
        echo "✓ Base image created: $BASE_IMAGE"
    fi
    echo ""

    echo "═══════════════════════════════════════════════════"
    echo "  E2E environment ready!"
    echo ""
    echo "  Images:"
    echo "    $GOLDEN_FILE"
    echo "    $CLOUD_INIT"
    echo ""
    echo "  Run tests:  just e2e"
    echo "═══════════════════════════════════════════════════"

# @category e2e-qemu
# Run E2E tests via TypeScript (bun)
qemu-e2e-test-ts:
    cd e2e && bun run e2e.ts

# @category e2e-qemu
# Update E2E reference images via TypeScript (bun)
qemu-e2e-update-ts:
    cd e2e && bun run e2e.ts --update

# @category e2e-qemu
# Run E2E tests (snapshot mode by default, fast ~40s after first run)
# Output is always tee'd to /tmp/fedora-speech-to-text-e2e-run.log — tail it to
# watch progress: tail -f /tmp/fedora-speech-to-text-e2e-run.log
# Override with args: just e2e --update
e2e *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    env="fedora-local"
    if [[ "${1:-}" =~ ^(fedora-local|ubuntu-local|ubuntu-ci)$ ]]; then
      env="$1"; shift
    fi
    cd e2e
    LOG="${E2E_LOG:-/tmp/fedora-speech-to-text-e2e-run.log}"
    : > "$LOG"
    if [[ "$env" == "fedora-local" ]]; then
      bun run e2e.ts --save-snapshot {{ ARGS }} 2>&1 | tee "$LOG"
      exit ${PIPESTATUS[0]}
    else
      bun run e2e.ts --env "$env" {{ ARGS }} 2>&1 | tee "$LOG"
      exit ${PIPESTATUS[0]}
    fi

# @category e2e-qemu
# Run E2E tests in parallel mode
e2e-parallel *ARGS:
    cd e2e && bun run e2e.ts --parallel {{ ARGS }}

# @category e2e-qemu
# Run preferences screenshot tests
e2e-prefs:
    cd e2e && bun run e2e.ts --test-prefs

# @category e2e-qemu
# Run all E2E tests (parallel + preferences)
e2e-all *ARGS:
    cd e2e && bun run e2e.ts --parallel 2 {{ ARGS }}

# @category e2e-qemu
# @category e2e-qemu
# Ensure 'ready' snapshot exists (saves it if missing), then run tests
# Usage: just e2e-snapshot [extra args, e.g. -- --save-snapshot]
e2e-snapshot *ARGS:
    cd e2e && bun run e2e.ts --save-snapshot {{ ARGS }}

# Run E2E tests without snapshots (full boot, ~75s)
e2e-no-snapshot:
    cd e2e && bun run e2e.ts --no-snapshot

# @category e2e-qemu
# Update E2E reference images in snapshot mode
e2e-update:
    cd e2e && bun run e2e.ts --update

# @category e2e-qemu
# Set up libvirt VM definition (for manual management)
e2e-setup-vm:
    bash e2e/setup-vm.sh

# @category e2e-qemu
# Start E2E VM via libvirtd (manual management)
e2e-start:
    virsh -c qemu:///session start e2e

# @category e2e-qemu
# Stop E2E VM via libvirtd
e2e-stop:
    virsh -c qemu:///session destroy e2e

# @category e2e-qemu
# Record VM screen via SPICE (requires spice-gtk3)
e2e-record output='e2e/output/recording.mp4':
    python3 e2e/lib/spice-record.py --host localhost --port 5930 --output {{ output }}

# @category e2e-qemu
# Clone open-source repos for API reference (GNOME Shell, etc.)
download-open-src:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p opensrc
    if [ ! -d opensrc/gnome-shell ]; then
      echo "Cloning GNOME Shell (gnome-48 branch)..."
      git clone --depth 1 --branch gnome-48 https://gitlab.gnome.org/GNOME/gnome-shell.git opensrc/gnome-shell
    else
      echo "opensrc/gnome-shell already exists, skipping."
    fi

# Query AT-SPI accessibility tree in the nested GNOME Shell
atspi-tree:
    ./skills/atspi-nested-shell/scripts/atspi-query.sh

# Find the Voice to Text indicator in the panel via AT-SPI
atspi-find-indicator:
    ./.agents/skills/atspi-nested-shell/scripts/atspi-find-indicator.sh

# Take a screenshot of the nested shell via xdg-desktop-portal
atspi-screenshot output="/tmp/nested-shell-screenshot.png":
    ./.agents/skills/atspi-nested-shell/scripts/portal-screenshot.sh "{{ output }}"

# @category review
# Run EGO (extensions.gnome.org) compliance checks on GNOME extension
# Determines review readiness, identifies blocking issues, and provides
# specific fix recommendations for extension.gnome.org submission.
ego-lint:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== GNOME Extension EGO Compliance Check ==="
    echo "Running comprehensive compliance checks for extensions.gnome.org"
    echo ""
    echo "This runs ego-lint against the gnome-ext/ directory to:"
    echo "  ✓ Validate metadata.json format and required fields"
    echo "  ✓ Check JS syntax and TypeScript compliance"  
    echo "  ✓ Verify lifecycle symmetry (enable/disable)"
    echo "  ✓ Detect deprecated module imports"
    echo "  ✓ Identify AI slop patterns"
    echo "  ✓ Check security issues (subprocess, eval, etc.)"
    echo ""
    echo "Check results provide specific fix suggestions for each issue."
    echo ""
    echo "⚠️  Warning: Extensions with FAIL issues will likely be REJECTED."
    echo ""
    echo "Running ego-lint on gnome-ext/..."
    ./scripts/ego-lint --show=fail,warn gnome-ext/
    echo ""
    echo "=== EGO Review Complete ==="

# @category e2e-vm
# Local CI-parity: set up the Ubuntu 26.04 VM (image download + customize)
ubuntu-vm-setup:
    ./e2e-vm/setup-vm.sh

# @category e2e
# First-time setup for the Ubuntu env of the unified suite: pinned resolute
# cloud image + golden customization + ssh key (same URL/recipe as CI).
e2e-setup-ubuntu:
    ./e2e/setup-ubuntu-vm.sh

# @category e2e-ubuntu-ci (LEGACY - forwards to the unified suite)
ubuntu-ci-e2e *args='':
    just e2e ubuntu-ci {{ args }}

# @category e2e-ubuntu-ci (LEGACY)
ubuntu-ci-e2e-setup:
    just e2e-setup-ubuntu

# @category e2e-vm
# Local CI-parity: boot the Ubuntu 26.04 VM headless (idempotent).
# Overlay persists across runs; `just ubuntu-vm-boot fresh` resets to golden image.
ubuntu-vm-boot *args='':
    ./e2e-vm/boot-vm.sh {{ args }}

# @category e2e-vm
# Local CI-parity: boot the Ubuntu 26.04 VM with a visible desktop window
# (GTK display instead of headless). Same disk/SSH as ubuntu-vm-boot.
ubuntu-vm-boot-gui:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e-vm
    if [ -f qemu.pid ] && kill -0 "$(cat qemu.pid)" 2>/dev/null; then
      echo "VM already running (PID $(cat qemu.pid)) — run 'just ubuntu-vm-kill' first" >&2
      exit 1
    fi
    [ -f golden-ubuntu-2604.qcow2 ] || { echo "Run 'just ubuntu-vm-setup' first" >&2; exit 1; }
    rm -f overlay.qcow2
    qemu-img create -f qcow2 -b golden-ubuntu-2604.qcow2 -F qcow2 overlay.qcow2 > /dev/null
    qemu-system-x86_64 \
      -enable-kvm -cpu host -m 4096 -smp 2 \
      -drive file=overlay.qcow2,format=qcow2,if=virtio \
      -device virtio-vga \
      -display gtk,gl=off \
      -monitor unix:qemu-monitor.sock,server,nowait \
      -serial file:serial.log \
      -netdev user,id=net0,hostfwd=tcp::2222-:22 \
      -device virtio-net-pci,netdev=net0 \
      -daemonize -pidfile qemu.pid
    echo "Ubuntu 26.04 desktop window open (GDM auto-login: testuser), SSH on :2222"

# @category e2e-vm
# Full local CI-parity cycle: boot Ubuntu 26.04 VM (if not running) + Parakeet
# + run the CI harness + stop the VM. Add GUI=1 for a visible desktop window.
ubuntu-vm-test GUI='':
    #!/usr/bin/env bash
    set -euo pipefail
    just ubuntu-vm-{{ if GUI == "1" { "boot-gui" } else { "boot" } }}
    trap 'just ubuntu-vm-kill' EXIT
    just ubuntu-vm-parakeet
    just ubuntu-vm-run

# @category e2e-vm
# Local CI-parity: run the CI harness (ci-e2e-headless.sh) inside the VM.
# Requires Parakeet on the host: just ubuntu-vm-parakeet
ubuntu-vm-run:
    ./e2e-vm/run-parity.sh

# @category e2e-vm
# Start Parakeet on the host (port 5092) for the Ubuntu VM parity run
ubuntu-vm-parakeet:
    #!/usr/bin/env bash
    set -euo pipefail
    RUNTIME=docker
    command -v docker >/dev/null 2>&1 || RUNTIME=podman
    $RUNTIME rm -f parakeet-e2e-parity >/dev/null 2>&1 || true
    $RUNTIME run -d --name parakeet-e2e-parity --network host \
      ghcr.io/achetronic/parakeet:latest > /dev/null
    for i in $(seq 1 60); do
      curl -sf http://localhost:5092/health >/dev/null && { echo "Parakeet ready"; exit 0; }
      sleep 2
    done
    echo "FATAL: Parakeet not ready" >&2; exit 1

# @category e2e-vm
# Stop the Ubuntu 26.04 parity VM
ubuntu-vm-kill:
    #!/usr/bin/env bash
    PID_FILE="e2e-vm/qemu.pid"
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    echo "VM stopped"
