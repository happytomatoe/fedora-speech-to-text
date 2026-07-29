default:
    @just --list

# @category setup
# Install npm deps (lefthook) and set up git hooks
setup:
    npm install
    lefthook install

run *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.__main__ {{args}}

test:
  uv run pytest -n auto

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
      voice-to-text-dbus >> "$LOG_FILE" 2>&1 &
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
    cp gnome-ext/*.js gnome-ext/*.mjs "$DEST/"
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
    for f in gnome-ext/*.js; do
        node --check "$f" || exit 1
    done
    echo "Checking GTK4 API compatibility..."
    gjs gnome-ext/tests/test-gtk4-api.js 2>&1 || exit 1
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
    # Copy other files from gnome-ext/
    cp "$SRC"/metadata.json "$SRC"/stylesheet.css "dist/$UUID/"
    cp "$SRC"/schemas/*.xml "dist/$UUID/schemas/"
    glib-compile-schemas "dist/$UUID/schemas/"
    cd dist && zip -r "$UUID.shell-extension.zip" "$UUID"
    echo "Extension packed to dist/$UUID.shell-extension.zip"
