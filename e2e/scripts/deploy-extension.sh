#!/bin/bash
# E2E: Deploy GNOME extension via rsync + dconf (bypasses gnome-extensions install)
# Args: $1 = extension UUID
set -euo pipefail

EXT_UUID="${1:-voice-to-text@happytomatoe.com}"
DEPLOY_DIR="$HOME/tmp-deploy"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "--- Deploying extension via rsync ---"
mkdir -p "$EXT_DIR"
rsync -a --delete "$DEPLOY_DIR/gnome-ext/" "$EXT_DIR/"

echo "--- Compiling schemas ---"
if [ -d "$EXT_DIR/schemas" ]; then
  glib-compile-schemas "$EXT_DIR/schemas/" 2>&1 || true
fi

echo "--- Debugging extension install ---"
echo "Extension dir exists: $(ls -la $EXT_DIR 2>&1)"
echo "Extension metadata: $(cat $EXT_DIR/metadata.json 2>&1 | head -5)"
echo "gnome-extensions list: $(gnome-extensions list 2>&1)"

echo "--- Configuring dconf ---"
dconf write /org/gnome/shell/enabled-extensions "['$EXT_UUID']"
dconf write /org/gnome/shell/disable-user-extensions false
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
dconf write /org/gnome/shell/extensions/voice-to-text/custom-words "['herdr', 'command', 'PR']"

echo "--- Enabling extension ---"
# Wait for gnome-shell
for i in $(seq 1 6); do
  if pgrep -x gnome-shell >/dev/null 2>&1; then break; fi
  sleep 2
done

DBUS=$(cat /proc/$(pgrep -x gnome-shell | head -1)/environ 2>/dev/null | tr '\0' '\n' | grep ^DBUS_SESSION_BUS_ADDRESS= | cut -d= -f2-)
export DBUS_SESSION_BUS_ADDRESS="$DBUS"
gnome-extensions enable "$EXT_UUID" 2>&1 || true


echo "--- Setting up dotoold ---"
# Fix uinput permissions
sudo chmod 660 /dev/uinput && sudo chown root:input /dev/uinput 2>/dev/null || true

# Create dotoold-wrapper if needed
if [ ! -f "$HOME/.local/bin/dotoold-wrapper" ]; then
  cat > "$HOME/.local/bin/dotoold-wrapper" << 'WRAPPER'
#!/bin/bash
exec /usr/bin/dotoold "$@"
WRAPPER
  chmod +x "$HOME/.local/bin/dotoold-wrapper"
fi

# Start dotoold
export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe
setsid nohup dotoold </dev/null &>/tmp/dotoold.log &
for i in $(seq 1 5); do
  sleep 1
  if test -p /run/user/$(id -u)/dotool-pipe; then
    echo "  dotoold ready"
    break
  fi
done

echo "--- Extension deploy complete ---"

# Reload GNOME Shell so it picks up the newly installed extension
# Don't restart GDM — that kills the SSH session. Killing gnome-shell
# lets GDM auto-respawn it while SSH stays alive.
echo "--- Reloading GNOME Shell ---"
killall -9 gnome-shell 2>/dev/null || true

# Wait for gnome-shell to respawn
for i in $(seq 1 30); do
  if pgrep -x gnome-shell >/dev/null 2>&1; then
    echo "  gnome-shell respawned (${i}s)"
    sleep 2
    break
  fi
  sleep 1
done

# Re-get D-Bus address (gnome-shell has new PID)
DBUS=$(cat /proc/$(pgrep -x gnome-shell | head -1)/environ 2>/dev/null | tr '\0' '\n' | grep ^DBUS_SESSION_BUS_ADDRESS= | cut -d= -f2-)
export DBUS_SESSION_BUS_ADDRESS="$DBUS"

# Re-enable extension after gnome-shell respawn
gnome-extensions enable "$EXT_UUID" 2>&1 || true
dconf write /org/gnome/shell/enabled-extensions "['$EXT_UUID']" 2>/dev/null || true

# Verify extension is active
for i in $(seq 1 10); do
  STATE=$(gnome-extensions show "$EXT_UUID" 2>/dev/null | grep State: || true)
  if echo "$STATE" | grep -qi "active"; then
    echo "  Extension is ACTIVE after reload"
    break
  fi
  sleep 1
done

echo "--- Post-reload status ---"
echo "  gnome-shell PID: $(pgrep -x gnome-shell || echo 'not running')"
echo "  Extension state: $(gnome-extensions show "$EXT_UUID" 2>/dev/null | grep State: || echo 'unknown')"
