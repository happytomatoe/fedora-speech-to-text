#!/usr/bin/env bash
set -euo pipefail

# Store API keys for voice-to-text providers using gum

if ! command -v gum &>/dev/null; then
  echo "Error: 'gum' is required. Install it from https://github.com/charmbracelet/gum"
  echo "  go install github.com/charmbracelet/gum@latest"
  echo "  brew install gum      # macOS"
  echo "  sudo dnf install gum  # Fedora"
  exit 1
fi

if ! command -v secret-tool &>/dev/null; then
  echo "Error: 'secret-tool' is required (usually in libsecret-tools package)."
  echo "  sudo apt install libsecret-tools   # Debian/Ubuntu"
  echo "  sudo dnf install libsecret        # Fedora"
  echo "  sudo pacman -S libsecret          # Arch"
  exit 1
fi

# Patch ~/.config/voice-to-text/config.yaml so the provider reads the key from
# the keyring via the project's !command substitution (mirrors Voxtral's entry).
update_config_yaml() {
  local section="$1" username="$2"
  local cfg="$HOME/.config/voice-to-text/config.yaml"
  local cmd="!secret-tool lookup service voice-to-text username $username"
  [ -f "$cfg" ] || return 0
  python3 - "$cfg" "$section" "$cmd" <<'PY'
import sys, re
cfg, section, cmd = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    lines = open(cfg, encoding="utf-8").read().splitlines(keepends=True)
except FileNotFoundError:
    sys.exit(0)
hdr = re.compile(r'^([A-Za-z0-9_-]+):(\s.*)?$')
out, i, n, updated = [], 0, len(lines), False
while i < n:
    line = lines[i]
    m = hdr.match(line)
    if m and not line[0].isspace() and m.group(1) == section:
        out.append(line); i += 1
        block = []
        while i < n:
            nxt = lines[i]
            mm = hdr.match(nxt)
            if nxt.strip() and not nxt[0].isspace() and mm:
                break
            block.append(nxt); i += 1
        replaced = False
        for bl in block:
            if re.match(r'^\s*api_key_env\s*:', bl):
                continue  # drop env-var form in favor of keyring command
            if re.match(r'^\s*api_key\s*:', bl):
                out.append(f'  api_key: "{cmd}"\n'); replaced = True; continue
            out.append(bl)
        if not replaced:
            out.append(f'  api_key: "{cmd}"\n')
        updated = True
        continue
    out.append(line); i += 1
if not updated:
    if out and not out[-1].endswith('\n'):
        out.append('\n')
    out.append(f'{section}:\n  api_key: "{cmd}"\n')
open(cfg, 'w', encoding='utf-8').writelines(out)
PY
  $GUM style --foreground 10 "✓ config updated: [$section] api_key -> keyring (username=$username)"
}

GUM=$(command -v gum)

$GUM style --border normal --padding "0 2" --margin "0 0 1" "voice-to-text — API Key Storage"

provider=$($GUM choose \
  --header "Which provider's API key do you want to store?" \
  "Deepgram" \
  "Voxtral" \
  "Groq" \
  "ElevenLabs" \
  "60db")

if [ -z "$provider" ]; then
  echo "No provider selected. Aborted."
  exit 0
fi

# Map display name to keyring username + create-key URL
case "$provider" in
Deepgram)
  username="deepgram"
  config_section="deepgram"
  url="https://console.deepgram.com/project/default/settings/api-keys"
  ;;
Voxtral)
  username="voxtral"
  config_section="voxtral"
  url="https://console.mistral.ai/?profile_dialog=api-keys"
  ;;
Groq)
  username="groq"
  config_section="groq"
  url="https://console.groq.com/keys"
  ;;
ElevenLabs)
  username="elevenlabs"
  config_section="elevenlabs"
  url="https://elevenlabs.io/app/settings/api-keys"
  ;;
60db)
  username="60db"
  config_section="sixty"
  url="https://app.60db.ai/app/developers"
  ;;
*)
  echo "Invalid provider. Aborted."
  exit 1
  ;;
esac

echo
$GUM style --foreground 212 "Create a new API key here:" "$url"
echo

echo
if secret-tool store --label="${provider} API Key" service voice-to-text username "$username"; then
  $GUM style --foreground 10 "✓ ${provider} API key stored (service=voice-to-text, username=${username})"
  update_config_yaml "$config_section" "$username"
else
  echo "Failed to store secret." >&2
  exit 1
fi
