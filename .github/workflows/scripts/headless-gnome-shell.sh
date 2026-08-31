#!/usr/bin/env bash
# Headless GNOME Shell boot + screenshot on a bare CI runner.
#
# No VM, no container, no display server: gnome-shell --headless renders into
# a memory framebuffer via a virtual Wayland monitor.
#
# Screenshot strategy (POC-hardened):
#   GNOME 48+ gates Eval/Screenshot/Screencast behind
#   global.context.unsafe_mode, which is only settable from inside the shell
#   process — and Eval (the usual way in) is itself gated. A micro-extension
#   runs INSIDE the shell: enable() sets unsafe_mode, then captures via the
#   Screenshot D-Bus API.
#
# Constraints that shape this script (each cost a CI run to learn):
#   - NO literal single quotes anywhere in the code passed to
#     `dbus-run-session -- bash -c '...'` — they terminate the outer quoting.
#     (gsettings array values use \47 = octal apostrophe.)
#   - No heredocs in that block either (indentation must match exactly).
#     Files are written with echo/printf instead.
#
# Usage: headless-gnome-shell.sh <output-png> [width] [height]
set -euxo pipefail

SCREENSHOT="${1:?usage: headless-gnome-shell.sh <output-png> [width] [height]}"
WIDTH="${2:-1280}"
HEIGHT="${3:-720}"

# --- Isolated environment (CopyQ pattern) -----------------------------------
# Wipe HOME/XDG dirs so the shell cannot see host config; keep schema dirs.
ISOLATED=$(mktemp -d)
mkdir -p "$ISOLATED/.config" "$ISOLATED/.local/share" "$ISOLATED/.cache" "$ISOLATED/.runtime"
chmod 0700 "$ISOLATED/.runtime"

env --ignore-environment \
  HOME="$ISOLATED" \
  PATH="$PATH" \
  LANG=C.UTF-8 \
  SCREENSHOT="$SCREENSHOT" \
  WIDTH="$WIDTH" \
  HEIGHT="$HEIGHT" \
  XDG_CONFIG_HOME="$ISOLATED/.config" \
  XDG_DATA_HOME="$ISOLATED/.local/share" \
  XDG_DATA_DIRS="$ISOLATED/.local/share:/usr/local/share:/usr/share" \
  XDG_CACHE_HOME="$ISOLATED/.cache" \
  XDG_RUNTIME_DIR="$ISOLATED/.runtime" \
  dbus-run-session -- bash -cexu '
    # --- GSettings schemas ------------------------------------------------
    # GIO looks in glib-2.0/schemas under XDG_DATA_DIRS; compile system
    # schemas into the isolated XDG_DATA_HOME or gsettings fails wholesale.
    schema_dir="$XDG_DATA_HOME/glib-2.0/schemas"
    mkdir -p "$schema_dir"
    glib-compile-schemas --targetdir="$schema_dir" /usr/share/glib-2.0/schemas
    gsettings list-schemas | grep -q org.gnome.shell && echo "schemas OK"

    # --- Micro-extension: unsafe_mode + screenshot -------------------------
    # Runs inside the shell process; enable() is called by ExtensionSystem
    # at startup. See file header for why this is the only working path.
    EXT_DIR="$HOME/.local/share/gnome-shell/extensions/poc-screenshot@local"
    mkdir -p "$EXT_DIR"
    echo "{" > "$EXT_DIR/metadata.json"
    echo "  \"uuid\": \"poc-screenshot@local\"," >> "$EXT_DIR/metadata.json"
    echo "  \"name\": \"POC Screenshot\"," >> "$EXT_DIR/metadata.json"
    echo "  \"description\": \"POC: enable unsafe mode and capture screenshot\"," >> "$EXT_DIR/metadata.json"
    echo "  \"shell-version\": [\"45\", \"46\", \"47\", \"48\", \"49\"]" >> "$EXT_DIR/metadata.json"
    echo "}" >> "$EXT_DIR/metadata.json"
    {
      echo "import GLib from \"gi://GLib\";"
      echo "export default class PocScreenshot {"
      echo "    enable() {"
      echo "        global.context.unsafe_mode = true;"
      echo "        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {"
      echo "            try {"
      echo "                GLib.spawn_command_line_async("
      echo "                    \"gdbus call --session \" +"
      echo "                    \"--dest org.gnome.Shell.Screenshot \" +"
      echo "                    \"--object-path /org/gnome/Shell/Screenshot \" +"
      echo "                    \"--method org.gnome.Shell.Screenshot.Screenshot \" +"
      echo "                    \"true false $SCREENSHOT\");"
      echo "            } catch (e) {"
      echo "                log(\"POC ext error: \" + e);"
      echo "            }"
      echo "            return GLib.SOURCE_REMOVE;"
      echo "        });"
      echo "    }"
      echo ""
      echo "    disable() {"
      echo "        global.context.unsafe_mode = false;"
      echo "        if (this._timer) GLib.source_remove(this._timer);"
      echo "    }"
      echo "}"
    } > "$EXT_DIR/extension.js"

    gsettings set org.gnome.shell disable-user-extensions false
    ext_array=$(printf "[\47poc-screenshot@local\47]")
    gsettings set org.gnome.shell enabled-extensions "$ext_array"
    echo "micro-extension installed"

    # --- Boot --------------------------------------------------------------
    gnome-shell --headless --wayland --no-x11 \
      --virtual-monitor "${WIDTH}x${HEIGHT}" &
    SHELL_PID=$!
    echo "gnome-shell PID: $SHELL_PID"

    WAYLAND_SOCKET_PATH="$XDG_RUNTIME_DIR/wayland-0"
    for i in $(seq 1 60); do
      if ! kill -0 "$SHELL_PID" 2>/dev/null; then
        echo "FATAL: gnome-shell exited early"
        exit 1
      fi
      if [[ -S "$WAYLAND_SOCKET_PATH" ]]; then
        echo "Wayland socket available after ${i}s"
        break
      fi
      sleep 1
    done
    [[ -S "$WAYLAND_SOCKET_PATH" ]] || { echo "FATAL: no Wayland socket"; exit 1; }

    # Let the initial frame render; the extension screenshot fires at t+4s.
    sleep 6

    # --- Verify + teardown -------------------------------------------------
    gdbus call --session \
      --dest org.freedesktop.DBus \
      --object-path /org/freedesktop/DBus \
      --method org.freedesktop.DBus.ListNames | grep -q org.gnome.Shell

    if [[ ! -s "$SCREENSHOT" ]]; then
      echo "WARN: no screenshot; extension enable() may have failed"
      gdbus introspect --session --dest org.gnome.Shell \
        --object-path /org/gnome/Shell | head -40 || true
    fi

    kill "$SHELL_PID" 2>/dev/null || true
  '

ls -la "$SCREENSHOT" 2>/dev/null || { echo "FATAL: no screenshot produced"; exit 1; }
file "$SCREENSHOT"
