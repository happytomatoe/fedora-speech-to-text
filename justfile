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
    echo "All lint checks passed!"

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
    rm -f ~/.local/bin/voice-to-text-dbus
    uv tool uninstall voice-to-text 2>/dev/null || true

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
    mkdir -p ~/.local/share/dbus-1/services/ ~/.local/bin/
    cp service/com.happytomatoe.VoiceToText.service ~/.local/share/dbus-1/services/
    @echo "Service installed. D-Bus activation handles startup automatically."

# @category service
# Uninstall the D-Bus service
service-uninstall:
    rm -f ~/.local/share/dbus-1/services/com.happytomatoe.VoiceToText.service
    rm -f ~/.local/bin/voice-to-text-dbus-wrapper
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
    journalctl --user -f -u voice-to-text-dbus

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
# Install extension, then start a nested GNOME Shell
gnome-ext-dev: reinstall gnome-ext-install
    #!/usr/bin/env bash
    set -euo pipefail
    # Load provider API keys from the system keyring in the parent session
    # (where the Secret Service is reachable) so the nested D-Bus service
    # inherits them. The wrapper does this for the real service; gnome-ext-dev
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
    LOG_FILE="$LOG_DIR/gnome-ext-dev.log"
    mkdir -p "$LOG_DIR"
    echo "" > "$LOG_FILE"
    if ! rpm -q mutter-devkit &>/dev/null; then
        echo "mutter-devkit not installed, installing..."
        if command -v rpm-ostree &>/dev/null; then
            sudo rpm-ostree install mutter-devkit
            echo "mutter-devkit was staged via rpm-ostree. Reboot, then rerun 'just gnome-ext-dev'." >&2
            exit 1
        else
            sudo dnf install -y mutter-devkit
        fi
    fi
    UUID="voice-to-text@happytomatoe.com"
    # Enable extension via dconf (gnome-extensions CLI needs a running session)
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

    # Start the D-Bus service inside the isolated session bus so the
    # GNOME extension can find and call it on real hardware.
    # Trap EXIT/INT/TERM to kill the background service when the shell exits,
    dbus-run-session -- sh -c "
      voice-to-text-dbus >> \"$LOG_FILE\" 2>&1 &
      DBUS_PID=\$!
      sleep 1
      trap 'kill \$DBUS_PID 2>/dev/null || true' EXIT INT TERM
      gnome-shell --wayland $DEVKIT_FLAG
    " 2>&1 | tee -a "$LOG_FILE"
    echo "Logs written to $LOG_FILE"
# Install extension files directly (no nested shell)
gnome-ext-install:
    #!/usr/bin/env bash
    set -euo pipefail
    UUID="voice-to-text@happytomatoe.com"
    DEST=$HOME/.local/share/gnome-shell/extensions/$UUID
    # No TypeScript build needed — extension is plain JS
    mkdir -p "$DEST/schemas"
    # Copy JS files from gnome-ext/
    cp gnome-ext/*.js "$DEST/"
    # Copy vendor directory (js-yaml)
    cp -r gnome-ext/vendor "$DEST/"
    # Copy other files from gnome-ext/
    cp gnome-ext/metadata.json gnome-ext/stylesheet.css "$DEST/"
    cp gnome-ext/schemas/*.xml "$DEST/schemas/"
    glib-compile-schemas "$DEST/schemas/"
    echo "Extension installed to $DEST"

# Uninstall extension by removing it from the extensions directory
gnome-ext-uninstall:
    rm -rf ~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com
    echo "Extension uninstalled"

# @category gnome-ext
# Verify GTK4 widget APIs used in prefs.js actually exist (catches GTK3→GTK4 regressions)
gtk4-api-check:
    gjs gnome-ext/tests/test-gtk4-api.js
# Validate GNOME extension (syntax + schema)
gnome-ext-lint:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Checking JS syntax..."
    for f in gnome-ext/**/*.js gnome-ext/*.js; do
        [ -f "$f" ] && node --input-type=module --check < "$f" || exit 1
    done
    echo "Checking GTK4 API compatibility..."
    if [ -f gnome-ext/tests/test-gtk4-api.js ]; then
        gjs gnome-ext/tests/test-gtk4-api.js 2>&1 || exit 1
    else
        echo "Skipping GTK4 API check (test file not found)"
    fi
    echo "Validating GSettings schema..."
    python3 -c "import xml.etree.ElementTree as ET; ET.parse('gnome-ext/schemas/org.gnome.shell.extensions.voice-to-text.gschema.xml')"
    glib-compile-schemas --strict gnome-ext/schemas/ 2>&1 || exit 1
    echo "All checks passed!"
# Reinstall files and reset in GNOME Shell
gnome-ext-reload:
    ./gnome-ext/run-dev.sh && gnome-extensions reset voice-to-text@happytomatoe.com && gnome-extensions enable voice-to-text@happytomatoe.com

# Pack extension into a ZIP for distribution
gnome-ext-pack:
    #!/usr/bin/env bash
    UUID="voice-to-text@happytomatoe.com"
    SRC="gnome-ext"
    rm -rf "dist/$UUID"
    mkdir -p "dist/$UUID/schemas"
    # No TypeScript build needed — extension is plain JS
    # Copy JS files from gnome-ext/
    cp "$SRC"/*.js "dist/$UUID/"
    # Copy vendor directory (js-yaml)
    cp -r "$SRC"/vendor "dist/$UUID/"
    # Copy other files from gnome-ext/
    cp "$SRC"/metadata.json "$SRC"/stylesheet.css "dist/$UUID/"
    cp "$SRC"/schemas/*.xml "dist/$UUID/schemas/"
    glib-compile-schemas "dist/$UUID/schemas/"
    cd dist && zip -r "$UUID.shell-extension.zip" "$UUID"
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
# Run E2E tests via TypeScript (bun)
qemu-e2e-test-ts:
    cd e2e && bun run e2e.ts

# @category e2e-qemu
# Update E2E reference images via TypeScript (bun)
qemu-e2e-update-ts:
    cd e2e && bun run e2e.ts --update

# @category e2e-qemu
# Run E2E tests (boots VM if needed, executes test, shuts down unless --keep-running)
e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e && bun run e2e.ts

# @category e2e-qemu
# Run E2E tests with snapshot restore (retry on failure)
e2e-snapshot:
    cd e2e && bun run e2e.ts --snapshot

# @category e2e-qemu
# Update E2E reference images in snapshot mode
e2e-update-snapshot:
    cd e2e && bun run e2e.ts --snapshot --update

# @category sonarqube
# Run a one-shot SonarQube scan (starts temp server, scans, exports reports, tears down)
sonar-scan:
    scripts/sonar-scan.sh

# @category sonarqube
# Run SonarQube scan and keep the server running (view results at localhost:9000)
sonar-scan-keep:
    scripts/sonar-scan.sh --keep-server

# @category sonarqube
# Stop a previously kept SonarQube server
sonar-stop:
    scripts/sonar-scan.sh --tear-down

# @category sonarqube
# Start SonarQube server (persistent, for repeated scans)
sonar-start:
    #!/usr/bin/env bash
    set -euo pipefail
    CONTAINER="sonarqube-oneshot"
    if podman ps --format '{{'.Names'}}' | grep -q "^${CONTAINER}$"; then
        echo "SonarQube already running at http://localhost:9000"
        exit 0
    fi
    sudo sysctl -w vm.max_map_count=262144 >/dev/null 2>&1 || true
    podman rm -f "$CONTAINER" 2>/dev/null || true
    podman run -d --name "$CONTAINER" -p 9000:9000 \
        -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true \
        sonarqube:26.4.0.121862-community >/dev/null
    echo "SonarQube starting... UI will be ready in ~60-90s at http://localhost:9000"
    echo "Credentials: admin / Sonarless123!"

# @category sonarqube
# Show SonarQube container logs
sonar-logs:
    podman logs -f sonarqube-oneshot
