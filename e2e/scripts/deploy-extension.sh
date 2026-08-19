#!/bin/bash
# E2E: Deploy GNOME extension via rsync + dconf (bypasses gnome-extensions install)
# Args: $1 = extension UUID
# No set -e: grep returns 1 when no match, which is normal during deploy

EXT_UUID="${1:-voice-to-text@happytomatoe.com}"
DEPLOY_DIR="$HOME/tmp-deploy"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "--- Deploying extension via rsync ---"
echo "Source dir contents: $(ls -la $DEPLOY_DIR/gnome-ext/ 2>&1)"
mkdir -p "$EXT_DIR"
rsync -a --delete "$DEPLOY_DIR/gnome-ext/" "$EXT_DIR/"

echo "--- Compiling schemas ---"
if [ -d "$EXT_DIR/schemas" ]; then
  glib-compile-schemas "$EXT_DIR/schemas/" 2>&1 || true
fi

echo "--- Debugging extension install ---"
echo "Extension dir exists: $(ls -la $EXT_DIR 2>&1)"
echo "Extension metadata: $(cat $EXT_DIR/metadata.json 2>&1 | head -5)"

echo "--- Configuring dconf ---"
dconf write /org/gnome/shell/enabled-extensions "['$EXT_UUID']"
dconf write /org/gnome/shell/disable-user-extensions false
dconf write /org/gnome/shell/extensions/voice-to-text/provider "'parakeet'"
dconf write /org/gnome/shell/extensions/voice-to-text/custom-words "['herdr', 'command', 'PR']"

echo "--- Setting up dotoold ---"
mkdir -p "$HOME/.local/bin"
sudo chmod 660 /dev/uinput && sudo chown root:input /dev/uinput 2>/dev/null || true

if [ ! -f "$HOME/.local/bin/dotoold-wrapper" ]; then
  cat > "$HOME/.local/bin/dotoold-wrapper" << 'WRAPPER'
#!/bin/bash
exec /usr/bin/dotoold "$@"
WRAPPER
  chmod +x "$HOME/.local/bin/dotoold-wrapper"
fi

export DOTOOL_PIPE=/run/user/$(id -u)/dotool-pipe
setsid nohup dotoold </dev/null &>/tmp/dotoold.log &
for i in $(seq 1 5); do
  sleep 1
  if test -p /run/user/$(id -u)/dotool-pipe; then
    echo "  dotoold ready"
    break
  fi
done

# GDM restart + extension enable is handled by deploy-steps.ts (separate SSH calls)
# because sudo systemctl restart gdm drops the SSH connection.
echo "--- deploy-extension.sh complete (files deployed, schemas compiled, dconf set) ---"
echo "  gnome-shell PID: $(pgrep -x gnome-shell || echo 'not running')"
