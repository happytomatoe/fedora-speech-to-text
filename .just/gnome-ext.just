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
    rm -f "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"
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
    export LOG_FILE
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
        gnome-shell --wayland --headless $DEVKIT_FLAG
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
gnome-ext-reload: gnome-ext-install
    gnome-extensions disable voice-to-text@happytomatoe.com 2>/dev/null || true
    gnome-extensions reset voice-to-text@happytomatoe.com 2>/dev/null || true
    gnome-extensions enable voice-to-text@happytomatoe.com 2>/dev/null || true

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
atspi-tree:
    ./.agents/skills/atspi-nested-shell/scripts/atspi-query.sh

# Find the Voice to Text indicator in the panel via AT-SPI
atspi-find-indicator:
    ./.agents/skills/atspi-nested-shell/scripts/atspi-find-indicator.sh

# Take a screenshot of the nested shell via xdg-desktop-portal
atspi-screenshot output="/tmp/nested-shell-screenshot.png":
    ./.agents/skills/atspi-nested-shell/scripts/portal-screenshot.sh "{{ output }}"

# @category gnome-ext
# Install extension, then start a nested GNOME Shell for interactive development
# Usage: just gnome-ext-dev
