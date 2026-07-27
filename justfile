default:
    @just --list

run *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.__main__ {{args}}

test:
  uv run pytest -n auto

# @category test
test-e2e:
  uv run pytest tests/e2e/ -v --tb=short -x

# @category test  
test-all: test test-e2e

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
    podman build -t voice-to-text-e2e -f tests/e2e/Dockerfile .
    echo "Container built: voice-to-text-e2e"

# @category e2e
# Generate reference images for visual regression tests
e2e-references: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Generating reference images..."
    tests/e2e/scripts/snapshot.sh --update
    echo "References generated. Review and commit tests/gnome-references/"

# @category e2e
# Run E2E visual regression tests
e2e-test: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Running E2E tests..."
    tests/e2e/scripts/snapshot.sh

# @category e2e
# Update snapshot references with current state
e2e-update: e2e-build
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Capturing snapshot references..."
    tests/e2e/scripts/snapshot.sh --update
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
    tests/e2e/scripts/snapshot.sh

# @category e2e
# Quick test: capture screenshot and check if microphone indicator is visible
e2e-screenshot-test:
    #!/usr/bin/env bash
    set -euo pipefail
    
    IMAGE="voice-to-text-e2e"
    if ! podman image exists "$IMAGE"; then
      echo "Building container..."
      podman build -t "$IMAGE" -f tests/e2e/Dockerfile .
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
    EXT_ZIP="/app/tests/e2e/expected/${EXT_UUID}.shell-extension.zip"
    
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
