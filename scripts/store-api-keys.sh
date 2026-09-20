#!/usr/bin/env bash
set -euo pipefail

# Store API keys for voice-to-text providers (pure bash)

if ! command -v secret-tool &>/dev/null; then
  echo "Error: 'secret-tool' is required (usually in libsecret-tools package)."
  echo "  sudo apt install libsecret-tools   # Debian/Ubuntu"
  echo "  sudo dnf install libsecret        # Fedora"
  echo "  sudo pacman -S libsecret          # Arch"
  exit 1
fi

echo "voice-to-text — API Key Storage"

providers=("Deepgram" "Voxtral" "Groq" "ElevenLabs" "60db")

echo "Which provider's API key do you want to store?"
select provider in "${providers[@]}"; do
  [ -n "$provider" ] && break
  echo "Invalid selection. Try again."
done

# Map display name to keyring username + create-key URL
case "$provider" in
Deepgram)
  username="deepgram"
  url="https://console.deepgram.com/project/default/settings/api-keys"
  ;;
Voxtral)
  username="voxtral"
  url="https://console.mistral.ai/?profile_dialog=api-keys"
  ;;
Groq)
  username="groq"
  url="https://console.groq.com/keys"
  ;;
ElevenLabs)
  username="elevenlabs"
  url="https://elevenlabs.io/app/settings/api-keys"
  ;;
60db)
  username="60db"
  url="https://app.60db.ai/app/developers"
  ;;
*)
  echo "Invalid provider. Aborted."
  exit 1
  ;;
esac

echo
echo "Create a new API key here: $url"
echo

if secret-tool store --label="${provider} API Key" service voice-to-text username "$username"; then
  echo "✓ ${provider} API key stored (service=voice-to-text, username=${username})"

  # Update config.yaml with secret-tool lookup reference
  CONFIG="${HOME}/.config/voice-to-text/config.yaml"
  if command -v python3 &>/dev/null; then
    STORED_USERNAME="$username" python3 -c '
import os, re
cfg_path = os.path.expanduser(os.path.join(os.environ["HOME"], ".config", "voice-to-text", "config.yaml"))
username = os.environ["STORED_USERNAME"]
api_line = f'  api_key: "!secret-tool lookup service voice-to-text username {username}"'
if not os.path.exists(cfg_path):
    with open(cfg_path, "w") as f:
        f.write(f"{username}:\n{api_line}\n")
else:
    with open(cfg_path) as f:
        lines = f.readlines()
    section_idx = None
    for i, line in enumerate(lines):
        if re.match(rf'^{username}:', line, re.IGNORECASE):
            section_idx = i
            break
    if section_idx is not None:
        for j in range(section_idx + 1, len(lines)):
            if lines[j].startswith("  api_key:"):
                lines[j] = api_line + "\n"
                break
        else:
            lines.insert(section_idx + 1, api_line + "\n")
    else:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append(f"\n{username}:\n")
        lines.append(api_line + "\n")
    with open(cfg_path, "w") as f:
        f.writelines(lines)
'
    echo "✓ config.yaml updated (${CONFIG})"
  else
    echo "⚠ python3 not found — add this manually to ${CONFIG}:"
    echo "  ${username}:"
    echo "    api_key: \"!secret-tool lookup service voice-to-text username ${username}\""
  fi
fi
