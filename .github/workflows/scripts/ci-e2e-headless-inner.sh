#!/usr/bin/env bash
# Inner harness for the CI headless E2E test. Runs INSIDE `dbus-run-session`
# (started by ci-e2e-headless.sh) with an isolated HOME/XDG environment.
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
gsettings set org.gnome.shell enabled-extensions "['$EXT_UUID', '$SHOT_UUID']"
echo "extensions deployed: $EXT_UUID + $SHOT_UUID"

# --- Service config ----------------------------------------------------------
mkdir -p "$HOME/.config/voice-to-text"
cat > "$HOME/.config/voice-to-text/config.yaml" <<YEOF
provider: parakeet
http_endpoint: http://localhost:5092
YEOF

# --- Install + start the Python service ---------------------------------------
# uv run resolves the project's own dependencies; no pip needed.
cd "$ASSETS/voice-to-text-python"
uv run --project . voice-to-text-dbus > "$HOME/service.log" 2>&1 &
SERVICE_PID=$!

# --- Boot headless gnome-shell -------------------------------------------------
gnome-shell --headless --wayland --no-x11 \
  --virtual-monitor "${WIDTH}x${HEIGHT}" > "$HOME/shell.log" 2>&1 &
SHELL_PID=$!
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
SHOT_BASE="${SCREENSHOT%.png}"
BEFORE_SHOT="$SHOT_BASE-before.png"
DURING_SHOT="$SHOT_BASE-during.png"
AFTER_SHOT="$SHOT_BASE-after.png"
export VOX_CI_E2E_SHOT_DURING="$DURING_SHOT"
export VOX_CI_E2E_SHOT_AFTER="$AFTER_SHOT"

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

# --- Run the test runner ----------------------------------------------------------
TEST_EXIT=0
cd "$ASSETS/ci-e2e"
bun run e2e.ts || TEST_EXIT=$?
echo "test runner exit: $TEST_EXIT"

# --- Screenshot (post-run state) ---------------------------------------------------
sleep 1
gdbus call --session \
  --dest org.gnome.Shell.Screenshot \
  --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot \
  true false "$AFTER_SHOT" || echo "WARN: after-screenshot failed"

# --- Tear down -----------------------------------------------------------------------
kill "$SERVICE_PID" 2>/dev/null || true
kill "$SHELL_PID" 2>/dev/null || true

exit "$TEST_EXIT"
