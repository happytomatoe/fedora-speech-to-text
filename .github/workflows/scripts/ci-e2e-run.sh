#!/usr/bin/env bash
# Run phase: execute the TypeScript suite; record exit code for teardown.
set -euo pipefail
ASSETS="${CI_E2E_ASSETS:?}"
REPO_ROOT="${GITHUB_WORKSPACE:-$PWD}"
HOME="${CI_E2E_ISOLATED:?}"
export HOME
XDG_CONFIG_HOME="$HOME/.config"
XDG_DATA_HOME="$HOME/.local/share"
XDG_DATA_DIRS="$HOME/.local/share:/usr/local/share:/usr/share"
XDG_CACHE_HOME="$HOME/.cache"
XDG_RUNTIME_DIR="$HOME/.runtime"
export XDG_CONFIG_HOME XDG_DATA_HOME XDG_DATA_DIRS XDG_CACHE_HOME XDG_RUNTIME_DIR
PATH="$ASSETS/e2e/bin:$PATH"
export PATH
VOICE_TO_TEXT_DEBUG_FILE="$HOME/current-fixture.wav"
VOX_CI_E2E_TEXT_FILE="$HOME/typed-text.txt"
DOTOOL_PIPE="$HOME/.runtime/dotool-pipe"
PULSE_SERVER="unix:/run/user/$(id -u)/pulse/native"
SCREENSHOT="${CI_E2E_SCREENSHOT:?}"
AFTER_SHOT="${SCREENSHOT%.png}-after.png"
VOX_CI_E2E_CELLS_DIR="$REPO_ROOT/output/cells"
VOX_CI_E2E_SHOT_AFTER="$AFTER_SHOT"
VOX_CI_E2E_SHOT_DURING="${SCREENSHOT%.png}-during.png"
VOX_CI_E2E_SCREENCAST="$HOME/recording.webm"
VOX_CI_E2E_SERVICE_LOG="$HOME/service.log"
export VOX_CI_E2E_CELLS_DIR VOX_CI_E2E_SHOT_AFTER VOX_CI_E2E_SHOT_DURING VOX_CI_E2E_SCREENCAST VOX_CI_E2E_SERVICE_LOG
E2E_CASES="${E2E_CASES:-}"
E2E_SKIP_PREFS="${E2E_SKIP_PREFS:-}"
export VOICE_TO_TEXT_DEBUG_FILE VOX_CI_E2E_TEXT_FILE DOTOOL_PIPE PULSE_SERVER E2E_CASES E2E_SKIP_PREFS
DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:?}"
export DBUS_SESSION_BUS_ADDRESS
GSETTINGS_BACKEND=keyfile
export GSETTINGS_BACKEND

# --- Run the test runner ----------------------------------------------------------
# Ported suite (e2e/e2e.ts --env ubuntu-bare): local D-Bus flow, no SSH.
# The suite dir is staged into the isolated tree; run it with the project
# root's e2e/ sources.
TEST_EXIT=0
echo "running ported suite: e2e/e2e.ts --env ubuntu-bare"
SUITE_ARGS=(--env ubuntu-bare)
if [ -n "${E2E_CASES:-}" ]; then
  # comma-separated substrings → repeated --case flags
  IFS=',' read -ra CASES <<< "$E2E_CASES"
  for c in "${CASES[@]}"; do SUITE_ARGS+=(--case "$c"); done
fi
if [ "${E2E_SKIP_PREFS:-}" = "true" ]; then
  SUITE_ARGS+=(--no-prefs)
fi
echo "suite args: ${SUITE_ARGS[*]}"
(cd "$ASSETS/e2e" && bun run e2e.ts "${SUITE_ARGS[@]}") || TEST_EXIT=$?
echo "test runner exit: $TEST_EXIT"

# --- Screenshot (post-run state) ---------------------------------------------------
sleep 1
gdbus call --session \
  --dest org.gnome.Shell.Screenshot \
  --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot \
  true false "$AFTER_SHOT" || echo "WARN: after-screenshot failed"


echo "$TEST_EXIT" > "$HOME/test-exit-code"
