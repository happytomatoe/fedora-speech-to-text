#!/bin/bash
# E2E: Start voice-to-text service
# Args: $1 = output method (type|mutter-commit|mutter-virtual)
set -euo pipefail

OUTPUT_METHOD="${1:-mutter-commit}"

echo "--- Killing existing service ---"
systemctl --user disable com.happytomatoe.VoiceToText.user.service 2>/dev/null || true
systemctl --user stop com.happytomatoe.VoiceToText.user.service 2>/dev/null || true
killall -9 voice-to-text-dbus python3 2>/dev/null || true
pkill -9 -f voice-to-text 2>/dev/null || true
sleep 1

echo "--- Config ---"
mkdir -p ~/.config/voice-to-text
# Config should already be uploaded by deploy-steps

echo "--- Pre-downloading SileroVAD ---"
if [ ! -f ~/.cache/voice-to-text/silero_vad.onnx ]; then
  mkdir -p ~/.cache/voice-to-text
  curl -sL -o ~/.cache/voice-to-text/silero_vad.onnx 'https://github.com/snakers4/silero-vad/raw/v5.0/files/silero_vad.onnx' &
fi

echo "--- Starting voice service (output: $OUTPUT_METHOD) ---"
echo "--- Installing Python dependencies ---"
pip install onnxruntime sounddevice numpy 2>&1 | tail -3

export PATH=$HOME/.local/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export VOICE_TO_TEXT_PROVIDER=parakeet
export VOICE_TO_TEXT_DEBUG_FILE=/tmp/test-audio.wav
export VOICE_TO_TEXT_OUTPUT_METHOD=$OUTPUT_METHOD
export PYTHONPATH=~/voice_to_text/src
cd ~
setsid nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 </dev/null &
echo "  PID: $!"

echo "--- Waiting for D-Bus service ---"
for i in $(seq 1 15); do
  sleep 1
  if busctl --user list 2>/dev/null | grep -q com.happytomatoe.VoiceToText; then
    echo "  Voice service ready after ${i}s"
    break
  fi
  if [ "$i" = "15" ]; then
    echo "  WARNING: D-Bus service not found after 15s"
    cat /tmp/voice-service.log | tail -10 || true
  fi
done

# SileroVAD download runs in background — don't wait for it
echo "--- Voice service started ---"
