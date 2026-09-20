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
  SCRIPT="$(dirname "$0")/update-config-yaml.py"
  if command -v python3 &>/dev/null && [ -f "$SCRIPT" ]; then
    python3 "$SCRIPT" "$username"
    echo "✓ config.yaml updated"
  else
    CONFIG="${HOME}/.config/voice-to-text/config.yaml"
    echo "⚠ python3 not found — add this manually to ${CONFIG}:"
    echo "  ${username}:"
    echo "    api_key: \"!secret-tool lookup service voice-to-text username ${username}\""
  fi
fi
