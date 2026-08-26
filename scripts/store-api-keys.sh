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
$GUM style --foreground 212 "Create a new API key here:" "$url"
echo

echo
secret-tool store --label="${provider} API Key" service voice-to-text username "$username" &&
  $GUM style --foreground 10 "✓ ${provider} API key stored (service=voice-to-text, username=${username})"
