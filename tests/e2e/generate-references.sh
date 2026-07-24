#!/bin/bash
# Generates reference images for visual regression testing.
# Usage: ./generate-references.sh
#
# This script starts the container, enables the extension, and captures
# screenshots of various UI states as reference baselines.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
REFERENCES_DIR="${SCRIPT_DIR}/../gnome-references"
EXTENSION_UUID="voice-to-text@happytomatoe.com"
EXTENSION_ZIP="/app/tests/gnome-references/${EXTENSION_UUID}.shell-extension.zip"

cd "${PROJECT_ROOT}"

# Build container if needed
IMAGE="voice-to-text-gnome-test"
if ! podman image exists "${IMAGE}"; then
  echo "Building test container..."
  podman build -t "${IMAGE}" -f tests/gnome-tests/Containerfile .
fi

# Run container
echo "Starting container..."
POD=$(podman run --rm --cap-add=SYS_NICE --cap-add=IPC_LOCK -td "${IMAGE}")

cleanup() {
  podman kill "${POD}" 2>/dev/null || true
}
trap cleanup EXIT

# Helper to run commands in container as gnomeshell user
do_in_pod() {
  podman exec --user gnomeshell --workdir /home/gnomeshell "${POD}" set-env.sh "$@"
}

# Helper to capture screenshots from Xvfb framebuffer
capture() {
  local output_file="${REFERENCES_DIR}/${1}"
  local crop="${2:-}"
  
  podman cp "${POD}:/opt/Xvfb_screen0" - | tar xf - --to-command \
    "convert xwd:- ${crop:+-crop ${crop} +repage} ${output_file}"
}

# Wait for container to start
echo "Waiting for D-Bus..."
sleep 5

# Set up GSK_RENDERER for consistent rendering
do_in_pod 'echo "export GSK_RENDERER=cairo" >> .bash_profile'

# Disable welcome tour (GNOME 40+)
echo "Disabling welcome tour..."
do_in_pod gsettings set org.gnome.shell welcome-dialog-last-shown-version "999" || true
do_in_pod gsettings set org.gnome.mutter center-new-windows true

# Start GNOME Shell
echo "Starting GNOME Shell..."
do_in_pod systemctl --user start "gnome-xsession@:99"
sleep 10

# Install and enable extension
echo "Installing extension..."
do_in_pod gnome-extensions install "${EXTENSION_ZIP}" --force
do_in_pod gnome-extensions enable "${EXTENSION_UUID}"

# Close overview if open
echo "Closing Overview..."
do_in_pod xdotool keydown super
sleep 0.5
do_in_pod xdotool keyup super
sleep 3

# Create references directory
mkdir -p "${REFERENCES_DIR}"

echo "Capturing reference images..."

# 1. Indicator in top bar (default state)
echo "Capturing: indicator-default"
sleep 2
capture "indicator-default-gnome-rawhide.png"

# 2. Preferences dialog
echo "Capturing: preferences"
do_in_pod gnome-extensions prefs "${EXTENSION_UUID}"
sleep 5
capture "preferences-gnome-rawhide.png" "400x300+500+200"
do_in_pod xdotool keydown alt
do_in_pod xdotool key F4
sleep 1
do_in_pod xdotool keyup alt

echo "Reference images generated in ${REFERENCES_DIR}"
echo "Review and commit these images as baselines."
