#!/usr/bin/env bash
# CI headless E2E test — outer harness. Boots a real GNOME Shell headless on a
# bare GitHub Actions runner, with the voice-to-text extension, Python service,
# and a Parakeet container; then runs the D-Bus-driving test suite.
#
# Architecture:
#   outer (this file): isolation env, asset staging, Parakeet container,
#                      dbus-run-session → ci-e2e-headless-inner.sh
#   inner:             schemas, extension deploy, service start, boot wait,
#                      test runner, screenshot, teardown
#
# See poc-headless-shell.yml history for the quoting constraints that led to
# splitting inner/outer (each cost a CI run to learn).
#
# Usage: ci-e2e-headless.sh <output-png> [width] [height]
set -euo pipefail

REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCREENSHOT="$(realpath "${1:?usage: ci-e2e-headless.sh <output-png> [width] [height]}")"
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

# --- Parakeet container --------------------------------------------------------
# NOTE: no volume mount — the achetronic/parakeet image bakes the models into
# /models at build time (see its Dockerfile). Mounting an empty host dir HIDES
# the baked models and the server fails with "open /models/config.json: no such file".
CONTAINER_NAME="parakeet-ci-e2e"
# Local dev: an already-healthy Parakeet on :5092 is reused instead of
# starting a second one (port conflict). CI runners have none, so they boot one.
if curl -sf http://localhost:5092/health > /dev/null 2>&1; then
  echo "Parakeet already healthy on :5092 — reusing it"
  RUNTIME=skip
elif command -v docker > /dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman > /dev/null 2>&1; then
  RUNTIME=podman
else
  echo "FATAL: neither docker nor podman found" >&2
  exit 1
fi

if [ "$RUNTIME" != "skip" ]; then
  echo "Starting Parakeet container ($RUNTIME)..."
  # GHCR blob pulls are flaky on CI (connection reset mid-pull); retry a few
  # times before giving up — run 33726716165 died on a transient reset.
  # Pin by digest + use the fp32 (non-quantized) model image: the int8 models
  # in :latest produce empty/corrupt transcriptions on some CPUs — ONNX Runtime
  # int8 results differ across AVX2/AVX-512 (onnxruntime #6004, #14642), and
  # GH runners don't guarantee CPU features (runner-images #3390). Verified
  # locally: :latest int8 mangles 3/5 fixtures, :latest-fp32 transcribes all 5
  # perfectly. Digest = amd64 platform manifest of latest-fp32.
  PARAKEET_IMAGE="ghcr.io/achetronic/parakeet@sha256:46bf3ccb62dcc5d997edb20ed812125e19a33ab2774b2c59ba639bbfeb9d548b"
  pulled=0
  for attempt in 1 2 3; do
    $RUNTIME pull "$PARAKEET_IMAGE" && pulled=1 && break
    echo "WARN: image pull attempt $attempt failed, retrying in 5s..." >&2
    sleep 5
  done
  [ "$pulled" = 1 ] || { echo "FATAL: could not pull Parakeet image" >&2; exit 1; }
  $RUNTIME run -d --name "$CONTAINER_NAME" -p 5092:5092 "$PARAKEET_IMAGE"
fi

PARAKEET_READY=0
for i in $(seq 1 150); do
  if curl -sf http://localhost:5092/health > /dev/null 2>&1; then
    echo "Parakeet ready after ~$((i * 2))s"
    PARAKEET_READY=1
    break
  fi
  sleep 2
done
if [ "$PARAKEET_READY" -ne 1 ]; then
  echo "FATAL: Parakeet not ready after 300s" >&2
  $RUNTIME logs "$CONTAINER_NAME" | tail -50
  $RUNTIME rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
  exit 1
fi

# dotoold must be running before the service tries dotool type output
# (only possible when /dev/uinput exists — CI runners usually lack it).
# dotoold shell wrapper execs `dotool` by name — needs the bin dir on PATH.
if [[ -w /dev/uinput ]] && [[ -x "$ASSETS/e2e/bin/dotoold" ]]; then
  PATH="$ASSETS/e2e/bin:$PATH" DOTOOL_PIPE="$ISOLATED/.runtime/dotool-pipe" \
  nohup "$ASSETS/e2e/bin/dotoold" >/dev/null 2>&1 &
fi

# --- Run the inner harness inside a private session bus -------------------------
# env --ignore-environment: nothing leaks except what we pass explicitly.
set +e
env --ignore-environment \
  HOME="$ISOLATED" \
  PATH="$ASSETS/e2e/bin:$PATH" \
  LANG=C.UTF-8 \
  CI_E2E_ASSETS="$ASSETS" \
  SCREENSHOT="$SCREENSHOT" \
  VOX_CI_E2E_TEXT_FILE="$ISOLATED/typed-text.txt" \
  VOICE_TO_TEXT_DEBUG_FILE="$ISOLATED/current-fixture.wav" \
  WIDTH="$WIDTH" \
  HEIGHT="$HEIGHT" \
  HEIGHT="$HEIGHT" \
  XDG_CONFIG_HOME="$ISOLATED/.config" \
  XDG_DATA_HOME="$ISOLATED/.local/share" \
  XDG_DATA_DIRS="$ISOLATED/.local/share:/usr/local/share:/usr/share" \
  XDG_CACHE_HOME="$ISOLATED/.cache" \
  XDG_RUNTIME_DIR="$ISOLATED/.runtime" \
  PULSE_SERVER="unix:${XDG_RUNTIME_DIR_RUNNER:-/run/user/$(id -u)}/pulse/native" \
  DOTOOL_PIPE="$ISOLATED/.runtime/dotool-pipe" \
  dbus-run-session -- bash "$REPO_ROOT/.github/workflows/scripts/ci-e2e-headless-inner.sh"
TEST_EXIT=$?
set -e

# --- Teardown + result -----------------------------------------------------------
if [ "$RUNTIME" != "skip" ]; then
  echo "Stopping Parakeet container..."
  $RUNTIME rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
fi

# Always surface logs for triage, then exit with the test's code.
echo "--- service.log ---";  cat "$ISOLATED/service.log"  2>/dev/null || true
echo "--- shell.log ---";    cat "$ISOLATED/shell.log"    2>/dev/null || true

if [ ! -s "$SCREENSHOT" ]; then
  echo "WARN: no screenshot produced"
fi

exit "$TEST_EXIT"
