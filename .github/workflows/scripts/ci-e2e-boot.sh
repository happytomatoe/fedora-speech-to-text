#!/usr/bin/env bash
# Boot phase of the CI headless E2E: schemas, extension deploy, service config,
# then service + PipeWire + headless gnome-shell; waits until both are ready.
# Runs in workflow step 2 with env from ci-e2e-stage.sh (GITHUB_ENV).
set -euo pipefail

ASSETS="${CI_E2E_ASSETS:?CI_E2E_ASSETS not set}"
DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:?bus not staged}"
export DBUS_SESSION_BUS_ADDRESS
GSETTINGS_BACKEND=keyfile
export GSETTINGS_BACKEND

#!/usr/bin/env bash
# Inner harness for the CI headless E2E test. Runs INSIDE `dbus-run-session`
# Runs as its own workflow step with env from ci-e2e-stage.sh (GITHUB_ENV).
#
# Responsibilities:
#   1. Compile GSettings schemas (system + extension) into isolated tree
#   2. Deploy the real voice-to-text extension, enable it
#   3. Write service config (parakeet provider, localhost:5092)
#   4. Start the Python D-Bus service + headless gnome-shell
#   5. Wait for Wayland socket + service bus name
#   6. Run the TypeScript test runner (bun ci-e2e/e2e.ts)
#   7. Tear down; exit with the test runner's exit code
#
# Environment expected (set by outer script):
#   HOME, XDG_*          — isolated temp tree
#   CI_E2E_ASSETS        — dir containing gnome-ext/, voice-to-text-python/, ci-e2e/
#   SCREENSHOT           — absolute output path for the screenshot
#   WIDTH / HEIGHT       — virtual monitor size
set -euo pipefail

ASSETS="${CI_E2E_ASSETS:?CI_E2E_ASSETS not set}"
REPO_ROOT="${GITHUB_WORKSPACE:-$PWD}"
HOME="${CI_E2E_ISOLATED:?}"
export HOME
XDG_CONFIG_HOME="$HOME/.config"
XDG_DATA_HOME="$HOME/.local/share"
XDG_DATA_DIRS="$HOME/.local/share:/usr/local/share:/usr/share"
XDG_CACHE_HOME="$HOME/.cache"
XDG_RUNTIME_DIR="$HOME/.runtime"
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_DATA_DIRS XDG_CACHE_HOME XDG_RUNTIME_DIR
WIDTH="${CI_E2E_WIDTH:-960}"
HEIGHT="${CI_E2E_HEIGHT:-540}"
export WIDTH HEIGHT
PULSE_SERVER="unix:/run/user/$(id -u)/pulse/native"
export PULSE_SERVER
PATH="$ASSETS/e2e/bin:$PATH"
export PATH
VOICE_TO_TEXT_DEBUG_FILE="$HOME/current-fixture.wav"
VOX_CI_E2E_TEXT_FILE="$HOME/typed-text.txt"
DOTOOL_PIPE="$HOME/.runtime/dotool-pipe"
export VOICE_TO_TEXT_DEBUG_FILE VOX_CI_E2E_TEXT_FILE DOTOOL_PIPE
# Fixed-path model cache (workflow-cached); the service runs with an isolated
# HOME whose cache would be re-downloaded (~90s) every run otherwise.
MOONSHINE_VOICE_CACHE=/home/runner/moonshine-model
export MOONSHINE_VOICE_CACHE
mkdir -p "$MOONSHINE_VOICE_CACHE"
cd "$ASSETS/voice-to-text-python"
uv run --project . python -c "import asyncio; from voice_to_text.providers.moonshine import MoonshineProvider; p = MoonshineProvider({'provider': 'moonshine', 'model': 'medium', 'language': 'en'}); print(asyncio.run(p.transcribe_file('/dev/null', 'en')))" > "$HOME/moonshine-prewarm.log" 2>&1 || echo "WARN: moonshine prewarm failed — first transcription may download the model"

# --- GSettings schemas ------------------------------------------------------
schema_dir="$XDG_DATA_HOME/glib-2.0/schemas"
mkdir -p "$schema_dir"
glib-compile-schemas --targetdir="$schema_dir" /usr/share/glib-2.0/schemas
gsettings list-schemas | grep -q org.gnome.shell

# --- Deploy the real extension ----------------------------------------------
EXT_UUID="voice-to-text@happytomatoe.com"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
mkdir -p "$EXT_DIR"
cp -r "$ASSETS/gnome-ext/." "$EXT_DIR/"
if [ -d "$EXT_DIR/schemas" ]; then
  glib-compile-schemas --strict "$EXT_DIR/schemas"
fi
gsettings set org.gnome.shell disable-user-extensions false
# Suppress notification banners (unsafe-mode warning pollutes screenshots)
gsettings set org.gnome.desktop.notifications show-banners false

# Bridge apps onto the accessibility bus so AT-SPI assertions can see prefs
# windows (org.a11y.Bus service comes from at-spi2-core).
gsettings set org.gnome.desktop.interface toolkit-accessibility true

# Screenshot enabler: tiny second extension sets unsafe_mode from inside the
# shell (POC trick), so the harness's outside-shell gdbus Screenshot call is
# permitted. Real extension stays enabled alongside.
SHOT_UUID="poc-screenshot@local"
SHOT_DIR="$HOME/.local/share/gnome-shell/extensions/$SHOT_UUID"
mkdir -p "$SHOT_DIR"
cat > "$SHOT_DIR/metadata.json" <<MEOF
{
  "uuid": "poc-screenshot@local",
  "name": "POC Screenshot",
  "description": "POC: enable unsafe mode",
  "shell-version": ["45", "46", "47", "48", "49", "50"]
}
MEOF
cat > "$SHOT_DIR/extension.js" <<JEOF
export default class PocScreenshot {
    enable() {
        global.context.unsafe_mode = true;
    }
    disable() {
        global.context.unsafe_mode = false;
    }
}
JEOF
# Input injector: test-only second extension exposes TypeText/TypeKey over
# D-Bus using the compositor's own Clutter virtual keyboard — uinput (dotool)
# events never reach GTK windows in the nested headless shell, but virtual-
# keyboard events do. Keeps test scaffolding out of the real extension.
INPUT_UUID="e2e-input@local"
INPUT_DIR="$HOME/.local/share/gnome-shell/extensions/$INPUT_UUID"
mkdir -p "$INPUT_DIR"
cat > "$INPUT_DIR/metadata.json" <<MEOF
{
  "uuid": "e2e-input@local",
  "name": "E2E Input Injector",
  "description": "Test-only: virtual keyboard injection over D-Bus",
  "shell-version": ["45", "46", "47", "48", "49", "50"]
}
MEOF
cat > "$INPUT_DIR/extension.js" <<'JEOF'
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const Iface = `
<node>
  <interface name="com.happytomatoe.E2EInput">
    <method name="TypeText">
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="TypeKey">
      <arg type="s" name="key" direction="in"/>
    </method>
  </interface>
</node>`;

export default class E2EInput {
    enable() {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._kbd = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE
            );
        } catch (e) {
            console.error('E2EInput: virtual keyboard failed:', e);
            return;
        }
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'com.happytomatoe.E2EInput',
            Gio.BusNameOwnerFlags.NONE,
            (connection) => {
                this._impl = Gio.DBusExportedObject.wrapJSObject(Iface, this);
                this._impl.export(connection, '/com/happytomatoe/E2EInput');
            },
            null,
            null
        );
    }

    disable() {
        if (this._ownerId !== null) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }
        this._kbd = null;
    }

    _key(keyval) {
        let t = Clutter.get_current_event_time() * 1000;
        this._kbd.notify_keyval(t++, keyval, Clutter.KeyState.PRESSED);
        this._kbd.notify_keyval(t++, keyval, Clutter.KeyState.RELEASED);
    }

    TypeText(text) {
        if (!this._kbd) return;
        for (const ch of text) {
            const kv = Clutter.unicode_to_keysym(ch.codePointAt(0));
            if (kv !== 0) this._key(kv);
        }
    }

    TypeKey(keyvalStr) {
        if (!this._kbd) return;
        // Takes a numeric keysym (e.g. '0xff56' = Page_Down) — GJS Clutter
        // has no keyval_from_name.
        const kv = Number(keyvalStr);
        if (!Number.isFinite(kv) || kv <= 0) {
            console.error(`E2EInput: bad keysym '${keyvalStr}'`);
            return;
        }
        this._key(kv);
    }
}
JEOF
gsettings set org.gnome.shell enabled-extensions "['$EXT_UUID', '$SHOT_UUID', '$INPUT_UUID']"
echo "extensions deployed: $EXT_UUID + $SHOT_UUID + $INPUT_UUID"

# --- Service config ----------------------------------------------------------
mkdir -p "$HOME/.config/voice-to-text"
# 0600: the product requires user-only-readable config (E2E C08 asserts it).
touch "$HOME/.config/voice-to-text/config.yaml" && chmod 600 "$HOME/.config/voice-to-text/config.yaml"
cat > "$HOME/.config/voice-to-text/config.yaml" <<YEOF
provider: moonshine
model: medium
YEOF
echo "config perms after write: $(stat -c '%a' "$HOME/.config/voice-to-text/config.yaml")"

# --- Install + start the Python service ---------------------------------------
# uv run resolves the project's own dependencies; no pip needed.
cd "$ASSETS/voice-to-text-python"
uv run --project . voice-to-text-dbus > "$HOME/service.log" 2>&1 &
SERVICE_PID=$!
echo "$SERVICE_PID" > "$HOME/service.pid"

# --- PipeWire + WirePlumber (required for shell screencast) -------------------
# gnome-shell's screencast needs a PipeWire connection. The isolated
# dbus-run-session has no session manager, so start pipewire + wireplumber
# inside it, pointing at the isolated XDG_RUNTIME_DIR.
mkdir -p "$XDG_RUNTIME_DIR"
pipewire &
PIPEWIRE_PID=$!
echo "$PIPEWIRE_PID" > "$HOME/pipewire.pid"
wireplumber &
WIREPLUMBER_PID=$!
echo "$WIREPLUMBER_PID" > "$HOME/wireplumber.pid"
for i in $(seq 1 15); do
  [[ -S "$XDG_RUNTIME_DIR/pipewire-0" ]] && { echo "pipewire socket up after ${i}s"; break; }
  sleep 1
done
[[ -S "$XDG_RUNTIME_DIR/pipewire-0" ]] || echo "WARN: pipewire socket not found — screencast may fail"

# --- Boot headless gnome-shell -------------------------------------------------
gnome-shell --headless --wayland --no-x11 \
  --virtual-monitor "${CI_E2E_WIDTH:-960}x${CI_E2E_HEIGHT:-540}" > "$HOME/shell.log" 2>&1 &
SHELL_PID=$!
echo "$SHELL_PID" > "$HOME/shell.pid"
echo "shell PID: $SHELL_PID  service PID: $SERVICE_PID"

# --- Wait for Wayland socket ----------------------------------------------------
WAYLAND_SOCKET_PATH="$XDG_RUNTIME_DIR/wayland-0"
for i in $(seq 1 60); do
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    echo "FATAL: gnome-shell exited early"
    cat "$HOME/shell.log"
    exit 1
  fi
  if [[ -S "$WAYLAND_SOCKET_PATH" ]]; then
    echo "Wayland socket available after ${i}s"
    break
  fi
  sleep 1
done
[[ -S "$WAYLAND_SOCKET_PATH" ]] || { echo "FATAL: no Wayland socket"; exit 1; }

# --- Wait for the service bus name -----------------------------------------------
for i in $(seq 1 30); do
  if gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.ListNames | grep -q com.happytomatoe.VoiceToText; then
    echo "service ready after ${i}s"
    break
  fi
  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo "FATAL: service exited early"
    cat "$HOME/service.log"
    exit 1
  fi
  sleep 1
done

# Grace period: let the shell render the initial frame / load the extension.
sleep 6

# --- Terminal for visible typed text -----------------------------------------------
# Launch ghostty + tmux so the committed transcription is visibly typed into a
# window on the virtual monitor (the after-screenshot shows it on screen).
# Focused input context also makes CommitText go through the real IM commit
# path instead of the headless capture-file fallback.
if command -v ghostty >/dev/null 2>&1; then
  tmux kill-server 2>/dev/null || true   # stale session from a previous run
  nohup ghostty -e tmux new-session -s ci-e2e -x 120 -y 20 > /dev/null 2>&1 &
  for i in $(seq 1 10); do
    TMUX_RUNNING=1 tmux has-session -t ci-e2e 2>/dev/null && { echo "tmux session up after ${i}s"; break; }
    sleep 1
  done
  # Click the terminal so it has keyboard focus (center of the 960x540 monitor)
  export WAYLAND_DISPLAY=wayland-0
  if command -v dotool >/dev/null 2>&1; then
    printf 'mouseto 0.5 0.5\nclick left\n' | dotool 2>/dev/null || true
  fi
  sleep 1
fi

# --- Screenshots: before/during/after the recording -------------------------------
# before: taken here (desktop, pre-recording). during/after: taken by the test
# runner via VOX_CI_E2E_SHOT_* (it knows the recording state and typed text).
SHOT_BASE="${CI_E2E_SCREENSHOT%.png}"
BEFORE_SHOT="$SHOT_BASE-before.png"
DURING_SHOT="$SHOT_BASE-during.png"
AFTER_SHOT="$SHOT_BASE-after.png"
export VOX_CI_E2E_SHOT_DURING="$DURING_SHOT"
export VOX_CI_E2E_SHOT_AFTER="$AFTER_SHOT"
export VOX_CI_E2E_CELLS_DIR="$REPO_ROOT/output/cells"
export VOX_CI_E2E_SCREENCAST="$HOME/recording.webm"

# PipeWire bridge for the screencast: gnome-shell resolves pipewire-0 under
# XDG_RUNTIME_DIR, but the sockets live in the real user runtime dir. Symlink
# them in (best-effort; screencast degrades gracefully if this fails).
for s in /run/user/$(id -u)/pipewire-0 /run/user/$(id -u)/pipewire-0.manager; do
  [ -S "$s" ] && ln -sfn "$s" "$XDG_RUNTIME_DIR/$(basename "$s")" 2>/dev/null || true
done

# Exit the Activities overview (headless shell boots into it) so the
# screenshots show the desktop with the panel indicators visible.
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/gnome/Shell \
  --method org.gnome.Shell.Eval 'Main.overview.hide();' > /dev/null 2>&1 || true
sleep 1

gdbus call --session \
  --dest org.gnome.Shell.Screenshot \
  --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot \
  true false "$BEFORE_SHOT" || echo "WARN: before-screenshot failed"

# --- Risk check: /dev/uinput (dotool viability for later phases) ----------------
if [[ -w /dev/uinput || -c /dev/uinput ]]; then
  echo "uinput check: PRESENT $(ls -l /dev/uinput 2>/dev/null || echo '(no perms info)')"
else
  echo "uinput check: ABSENT — dotool input injection SKIPped for this run (later phases needing synthetic input will be limited)"
fi

# Service log path for the ported suite's transcription poll
export VOX_CI_E2E_HEADLESS=1
export VOX_CI_E2E_SERVICE_LOG="$HOME/service.log"
export VOX_CI_E2E_SHELL_LOG="$HOME/shell.log"

# --- Screencast (one per run) -------------------------------------------------------
# GNOME Shell aborts a screencast with "Sender has vanished" when the D-Bus
# caller disconnects, so a one-shot `gdbus call` produces only a file header.
# The holder keeps the bus connection open until SIGTERM.
SCREENCAST_TEMPLATE="$HOME/recording%d.webm"
SCREENCAST_HOLDER_PID=""
SCREENCAST_START_EPOCH=$(date -u +%s)
echo "SCREENCAST_START_EPOCH=$SCREENCAST_START_EPOCH" >> "${GITHUB_ENV:-/dev/null}"
python3 "$REPO_ROOT/e2e/lib/screencast-holder.py" "$SCREENCAST_TEMPLATE" > "$HOME/screencast.log" 2>&1 &
SCREENCAST_HOLDER_PID=$!
echo "$SCREENCAST_HOLDER_PID" > "$HOME/screencast-holder.pid"
if sleep 1 && kill -0 "$SCREENCAST_HOLDER_PID" 2>/dev/null; then
  echo "screencast holder started (pid $SCREENCAST_HOLDER_PID)"
else
  echo "WARN: screencast holder exited: $(cat "$HOME/screencast.log" 2>/dev/null)"
fi

mkdir -p "$REPO_ROOT/output/cells"

