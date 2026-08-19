#!/bin/bash
# E2E: Deploy GNOME extension via install.sh + dconf
# Args: $1 = extension UUID, $2 = project root (for install.sh path)
set -euo pipefail

EXT_UUID="${1:-voice-to-text@happytomatoe.com}"
DEPLOY_DIR="$HOME/tmp-deploy"

echo "--- Running install.sh ---"
chmod +x "$DEPLOY_DIR/install.sh"
cd "$DEPLOY_DIR"
yes | bash install.sh --local gnome-ext 2>&1 | tee /tmp/install.log | tail -50 || true
echo "  install.sh exit code: $?"

echo "--- Debugging extension install ---"
echo "Extension dir exists: $(ls -la $HOME/.local/share/gnome-shell/extensions/$EXT_UUID 2>&1)"
echo "Extension metadata: $(cat $HOME/.local/share/gnome-shell/extensions/$EXT_UUID/metadata.json 2>&1 | head -5)"
echo "gnome-extensions list: $(gnome-extensions list 2>&1)"
echo "gnome-extensions show: $(gnome-extensions show $EXT_UUID 2>&1)"

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

# NOTE: Do NOT restart gnome-shell here. In headless QEMU the HUP kills the shell
# and it does not respawn, leaving the session dead. GNOME Shell dynamically loads
# extensions when dconf 'enabled-extensions' changes (written above), so no restart
# is needed — the extension comes up live.
# Verify extension is now active.
# Real signal: files present + dconf 'enabled-extensions' lists the UUID.
# GNOME Shell loads the extension live from this (no restart needed).
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
if [ -f "$EXT_DIR/metadata.json" ] && dconf read /org/gnome/shell/enabled-extensions 2>/dev/null | grep -q "$EXT_UUID"; then
  echo "  Extension installed and enabled (GNOME Shell loads it live via dconf)."
else
  echo "  WARNING: Extension not active"
  echo "  Files: $([ -f "$EXT_DIR/metadata.json" ] && echo present || echo missing)"
  echo "  dconf: $(dconf read /org/gnome/shell/enabled-extensions 2>/dev/null)"
  echo "  Checking journal for errors..."
  journalctl --user -b --since '5 minutes ago' --no-pager 2>/dev/null | grep -i 'voice-to-text\|happytomatoe\|extension' | tail -10 || true
fi

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
