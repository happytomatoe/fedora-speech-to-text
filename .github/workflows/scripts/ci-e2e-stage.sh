#!/usr/bin/env bash
# CI headless E2E test — outer harness. Boots a real GNOME Shell headless on a
# bare GitHub Actions runner, with the voice-to-text extension, Python service,
# and a Parakeet container; then runs the D-Bus-driving test suite.
#
# Architecture:
#   outer (this file): isolation env, asset staging, Parakeet container,
Isolated env + private dbus session, exported to later steps via GITHUB_ENV.
#   inner:             schemas, extension deploy, service start, boot wait,
#                      test runner, screenshot, teardown
#
# See poc-headless-shell.yml history for the quoting constraints that led to
# splitting inner/outer (each cost a CI run to learn).
#

set -euo pipefail

REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WIDTH="${2:-1280}"
HEIGHT="${3:-720}"

# --- Isolated environment (CopyQ pattern) ------------------------------------
ISOLATED=$(mktemp -d)
mkdir -p "$ISOLATED/.config" "$ISOLATED/.local/share" "$ISOLATED/.cache" "$ISOLATED/.runtime"
chmod 0700 "$ISOLATED/.runtime"

# --- Stage assets into the isolated tree --------------------------------------
ASSETS="$ISOLATED/assets"
mkdir -p "$ASSETS"
cp -r "$REPO_ROOT/gnome-ext" "$ASSETS/gnome-ext"
mkdir -p "$ASSETS/voice-to-text-python"
cp -r "$REPO_ROOT/src" "$REPO_ROOT/pyproject.toml" "$REPO_ROOT/uv.lock" "$ASSETS/voice-to-text-python/"
# e2e/ contains multi-GB qcow2 golden images and node_modules the bare runner
# never uses — /tmp is a small tmpfs and a full copy blows the quota.
mkdir -p "$ASSETS/e2e"
find "$REPO_ROOT/e2e" -maxdepth 1 ! -name e2e ! -name '*.qcow2' ! -name node_modules \
  ! -name output ! -name vm-run ! -name qemu-images \
  -exec cp -r {} "$ASSETS/e2e/" \;
# Fixture WAVs: the suite (e2e/e2e.ts) copies each case's WAV from the staged
# e2e/fixtures/ dir into VOICE_TO_TEXT_DEBUG_FILE before each StartRecording.
# The debug file must live inside the isolated tree: the service runs with HOME
# pointed at $ISOLATED.

# --- Parakeet container removed — CI uses in-process Moonshine provider (src/voice_to_text/providers/moonshine.py) ---


# dotoold must be running before the service tries dotool type output
# (only possible when /dev/uinput exists — CI runners usually lack it).
# dotoold shell wrapper execs `dotool` by name — needs the bin dir on PATH.
if [[ -w /dev/uinput ]] && [[ -x "$ASSETS/e2e/bin/dotoold" ]]; then
  PATH="$ASSETS/e2e/bin:$PATH" DOTOOL_PIPE="$ISOLATED/.runtime/dotool-pipe" \
  nohup "$ASSETS/e2e/bin/dotoold" >/dev/null 2>&1 &
fi

# dotoold must be running before the service tries dotool type output
if [[ -w /dev/uinput ]] && [[ -x "$ASSETS/e2e/bin/dotoold" ]]; then
  PATH="$ASSETS/e2e/bin:$PATH" DOTOOL_PIPE="$ISOLATED/.runtime/dotool-pipe" \
  nohup "$ASSETS/e2e/bin/dotoold" >/dev/null 2>&1 &
fi

# Persist a session bus across workflow steps: steps cannot inherit
# dbus-run-session, so run the daemon directly and export its address.
DBUS_SESSION_BUS_ADDRESS="unix:path=$ISOLATED/.runtime/session-bus"
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS" --print-pid > "$ISOLATED/.runtime/dbus.pid"

mkdir -p "$ISOLATED/.runtime"
{
  echo "CI_E2E_ISOLATED=$ISOLATED"
  echo "CI_E2E_ASSETS=$ASSETS"
  echo "CI_E2E_SCREENSHOT=$REPO_ROOT/ci-e2e-screenshot-2604.png"
  echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
  echo "CI_E2E_WIDTH=${WIDTH:-960}"
  echo "CI_E2E_HEIGHT=${HEIGHT:-540}"
} >> "${GITHUB_ENV:-/dev/null}"
echo "staged: isolated=$ISOLATED bus=$DBUS_SESSION_BUS_ADDRESS"
