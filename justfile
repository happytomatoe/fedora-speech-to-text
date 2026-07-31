default:
    @just --list

run *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.__main__ {{args}}

test:
  uv run pytest -n auto


# @category test  
test-all: test

install:
    uv tool install -e .

uninstall:
    rm -f ~/.local/bin/voice-to-text-dbus
    uv tool uninstall voice-to-text 2>/dev/null || true

# Reinstall Python package from source
reinstall:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Reinstalling voice-to-text from source..."
    uv tool install -e . --force
    echo "voice-to-text-dbus reinstalled from source"

# @category setup
# Store an API key in the OS keyring (service=voice-to-text)
store-secret:
    ./scripts/store-api-keys.sh

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
    echo "" > /tmp/gnome-shell-nested.log
    echo "" > /tmp/voice-to-text.log
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
      voice-to-text-dbus > /tmp/voice-to-text.log 2>&1 &
      DBUS_PID=\$!
      sleep 1
      trap 'kill \$DBUS_PID 2>/dev/null || true' EXIT INT TERM
      gnome-shell --wayland $DEVKIT_FLAG
    " 2>&1 | tee /tmp/gnome-shell-nested.log

# Install extension files directly (no nested shell)
gnome-ext-install:
    #!/usr/bin/env bash
    UUID="voice-to-text@happytomatoe.com"
    DEST=$HOME/.local/share/gnome-shell/extensions/$UUID
    mkdir -p "$DEST/schemas"
    cp gnome-ext/*.js gnome-ext/*.json gnome-ext/*.css "$DEST/" 2>/dev/null || true
    cp gnome-ext/schemas/*.xml "$DEST/schemas/"
    glib-compile-schemas "$DEST/schemas/"
    echo "Extension installed to $DEST"

# Uninstall extension by removing it from the extensions directory
gnome-ext-uninstall:
    rm -rf ~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com
    echo "Extension uninstalled"

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
    cp "$SRC"/*.js "$SRC"/*.json "$SRC"/*.css "dist/$UUID/"
    cp "$SRC"/schemas/*.xml "dist/$UUID/schemas/"
    glib-compile-schemas "dist/$UUID/schemas/"
    cd dist && zip -r "$UUID.shell-extension.zip" "$UUID"
    echo "Extension packed to dist/$UUID.shell-extension.zip"


# @category e2e
# Build the E2E test container locally
e2e-build:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Building E2E test container..."
    podman build -t voice-to-text-e2e -f e2e/Dockerfile .
    echo "Container built: voice-to-text-e2e"

# @category e2e
# Generate reference images for visual regression tests
e2e-references: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Generating reference images..."
    e2e/scripts/snapshot.sh --update
    echo "References generated. Review and commit tests/gnome-references/"

# @category e2e
# Run E2E visual regression tests
e2e-test: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Running E2E tests..."
    e2e/scripts/snapshot.sh

# @category e2e
# Update snapshot references with current state
e2e-update: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Capturing snapshot references..."
    e2e/scripts/snapshot.sh --update
    echo "Snapshots saved. Review and commit tests/gnome-references/snapshot-*.png"

# @category e2e
# Run E2E test with D-Bus service (requires DEEPGRAM_API_KEY)
e2e-full: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Running full E2E test with D-Bus service..."
    # Export DEEPGRAM_API_KEY so the container can use it
    if [ -z "${DEEPGRAM_API_KEY:-}" ]; then
      echo "Error: DEEPGRAM_API_KEY is not set. Export it first:"
      echo "  export DEEPGRAM_API_KEY=your_key_here"
      exit 1
    fi
    export DEEPGRAM_API_KEY
    e2e/scripts/snapshot.sh

# @category e2e
# Quick test: capture screenshot and check if microphone indicator is visible
e2e-screenshot-test:
    #!/usr/bin/env bash
    set -euo pipefail
    
    IMAGE="voice-to-text-e2e"
    if ! podman image exists "$IMAGE"; then
      echo "Building container..."
      podman build -t "$IMAGE" -f e2e/Dockerfile .
    fi
    
    echo "Starting container..."
    POD=$(podman run --rm -td "$IMAGE")
    trap "podman rm -f $POD >/dev/null 2>&1 || true" EXIT
    
    # Wait for user bus
    echo -n "Waiting for user bus..."
    for i in $(seq 1 30); do
      if podman exec --user gnomeshell "$POD" bash -c 'test -S /run/user/1000/bus' 2>/dev/null; then
        echo " ready"
        break
      fi
      sleep 1
    done
    
    EXT_UUID="voice-to-text@happytomatoe.com"
    EXT_ZIP="/app/e2e/expected/${EXT_UUID}.shell-extension.zip"
    
    do_in_pod() {
      podman exec -i --user gnomeshell --workdir /home/gnomeshell \
        -e XDG_RUNTIME_DIR=/run/user/1000 \
        -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        -e DISPLAY=:100 \
        "$POD" "$@"
    }
    
    # Install extension BEFORE starting GNOME Shell
    echo "Installing extension..."
    do_in_pod gnome-extensions install "$EXT_ZIP" --force 2>/dev/null
    do_in_pod dconf write /org/gnome/shell/enabled-extensions "['${EXT_UUID}']" 2>/dev/null
    
    # Start GNOME Shell
    echo "Starting GNOME Shell..."
    do_in_pod systemctl --user start "gnome-xsession@:100"
    
    # Wait for GNOME Shell to initialize
    echo -n "Waiting for GNOME Shell..."
    for i in $(seq 1 30); do
      if do_in_pod gnome-extensions list 2>/dev/null | grep -q "$EXT_UUID"; then
        echo " ready"
        break
      fi
      sleep 1
    done
    
    # Close overview if open (use dotool instead of xdotool - works on Wayland too)
    echo 'key super' | do_in_pod dotool
    sleep 2
    
    # Capture screenshot
    OUTPUT_DIR="tests/e2e-output"
    mkdir -p "$OUTPUT_DIR"
    FULL_SCREENSHOT="${OUTPUT_DIR}/screenshot-full.png"
    INDICATOR_SCREENSHOT="${OUTPUT_DIR}/screenshot-indicator.png"
    
    echo "Capturing screenshot..."
    podman cp "$POD":/opt/Xvfb_screen0 - | tar xf - --to-command "convert xwd:- ${FULL_SCREENSHOT}"
    
    # Crop right side of top bar where microphone indicator is (icon is left of volume)
    convert "$FULL_SCREENSHOT" -crop 80x30+650+0 +repage "$INDICATOR_SCREENSHOT"
    
    echo "Screenshots saved:"
    echo "  Full: $FULL_SCREENSHOT"
    echo "  Indicator: $INDICATOR_SCREENSHOT"
    
    # Check if indicator area has the microphone icon (non-uniform pixels)
    # The indicator should have non-uniform pixels (icon vs black background)
    INDICATOR_STATS=$(convert "$INDICATOR_SCREENSHOT" -colorspace Gray -format "%[fx:standard_deviation]" info: 2>/dev/null || echo "0")
    
    echo "Indicator area standard deviation: $INDICATOR_STATS"
    
    # A blank black area would have stddev ~0, an area with an icon will be >0.1
    if (( $(echo "$INDICATOR_STATS > 0.1" | bc -l 2>/dev/null || echo 0) )); then
      echo "✅ PASS: Microphone indicator detected"
      exit 0
    else
      echo "❌ FAIL: No microphone indicator detected (stddev: $INDICATOR_STATS)"
      exit 1
    fi

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
    pkill -9 -f "qemu-system-x86.*overlay.qcow2" 2>/dev/null || true
    rm -f e2e/qemu-images/overlay.qcow2 e2e/qemu-images/qemu-monitor.sock
    echo "Done"

# @category e2e-qemu
# Start QEMU E2E test VM (keeps running for SPICE connection)
qemu-e2e-vm:
    #!/usr/bin/env bash
    set -euo pipefail
    VM_DIR="e2e/qemu-images"
    VM_DIR_ABS="$(cd "$(dirname "${JUSTFILE}")" && pwd)/${VM_DIR}"
    
    # Kill any existing QEMU
    pkill -9 -f "qemu-system-x86.*overlay.qcow2" 2>/dev/null || true
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
        -spice port=5930,disable-ticketing=on \
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
    for i in $(seq 1 30); do
        if ssh -i id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -p 2222 testuser@localhost echo ok 2>/dev/null; then
            echo "SSH ready (${i}s)"
            break
        fi
        echo -n "."
        sleep 2
    done
    
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
# Open SPICE viewer to QEMU E2E test VM (port 5930)
e2e-test-view:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! ss -tlnp | grep -q ':5930 '; then
        echo "ERROR: QEMU VM not running (no SPICE on port 5930)"
        echo "Run 'just qemu-e2e-test-host' first."
        exit 1
    fi
    SSH_KEY="e2e/qemu-images/id_ed25519"
    SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 testuser@localhost"
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
    echo "Connecting to QEMU VM via SPICE (localhost:5930)..."
    if command -v remote-viewer &>/dev/null; then
        remote-viewer spice://localhost:5930
    elif command -v remmina &>/dev/null; then
        remmina spice://localhost:5930
    else
        echo "No SPICE client found. Install one:"
        echo "  sudo dnf install virt-viewer"
        exit 1
    fi
# @category e2e-qemu
# Create base QEMU VM image for E2E testing (run once, or after changes)
qemu-e2e-setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Setting up QEMU E2E test VM..."
    podman exec fedora-toolbox-44 bash -c "REPO_ROOT=/var/home/l/git/voice-to-text-test-pod /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-setup.sh"
    echo "Setup complete. Run 'just qemu-e2e-test' to test."

# @category e2e-qemu
# Run E2E visual regression tests using QEMU VM
qemu-e2e-test:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Running QEMU E2E tests..."
    podman exec -e DEEPGRAM_API_KEY fedora-toolbox-44 bash -c "REPO_ROOT=/var/home/l/git/voice-to-text-test-pod /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-snapshot.sh"

# @category e2e-qemu
# Update QEMU E2E reference images with current state
qemu-e2e-update:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Updating QEMU E2E reference images..."
    podman exec -e DEEPGRAM_API_KEY fedora-toolbox-44 bash -c "REPO_ROOT=/var/home/l/git/voice-to-text-test-pod /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-snapshot.sh --update"
    echo "References saved to e2e/expected-qemu/"

# @category e2e-qemu
# Install QEMU/KVM on host (Fedora Silverblue — requires reboot)
qemu-install:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Installing QEMU/KVM on host via rpm-ostree..."
    rpm-ostree install qemu-kvm libvirt virt-install qemu-img
    echo "Packages staged. Run 'systemctl reboot' to activate."

# @category e2e-qemu
# Create base QEMU VM image directly on host (no podman)
qemu-e2e-setup-host:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Setting up QEMU E2E test VM on host..."
    REPO_ROOT=/var/home/l/git/voice-to-text-test-pod \
        /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-setup.sh
    echo "Setup complete. Run 'just qemu-e2e-test-host' to test."

# @category e2e-qemu
# Run E2E tests directly on host (no podman)
qemu-e2e-test-host:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Running QEMU E2E tests on host..."
    REPO_ROOT=/var/home/l/git/voice-to-text-test-pod \
        /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-snapshot.sh

# @category e2e-qemu
# Update E2E reference images directly on host
qemu-e2e-update-host:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Updating QEMU E2E reference images on host..."
    REPO_ROOT=/var/home/l/git/voice-to-text-test-pod \
        /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-snapshot.sh --update
    echo "References saved to e2e/expected-qemu/"

# @category e2e-qemu
# Record E2E test flow as video directly on host
qemu-e2e-record-host:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Recording QEMU E2E test flow on host..."
    /var/home/l/git/voice-to-text-test-pod/e2e/scripts/qemu-e2e-record.sh

# @category e2e-qemu
# Run E2E tests via TypeScript (bun)
qemu-e2e-test-ts:
    cd tests/e2e && bun run qemu-snapshot.ts

# @category e2e-qemu
# Update E2E reference images via TypeScript (bun)
qemu-e2e-update-ts:
    cd tests/e2e && bun run qemu-snapshot.ts --update
