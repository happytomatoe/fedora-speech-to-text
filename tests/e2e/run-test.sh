#!/bin/bash
# Runs visual regression tests against reference images.
# Usage: ./run-test.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
REFERENCES_DIR="${SCRIPT_DIR}/../gnome-references"
OUTPUT_DIR="${SCRIPT_DIR}/../gnome-output"
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

mkdir -p "${OUTPUT_DIR}"

cleanup() {
  podman kill "${POD}" 2>/dev/null || true
}
trap cleanup EXIT

# Helper to run commands in container
do_in_pod() {
  podman exec --user gnomeshell --workdir /home/gnomeshell "${POD}" set-env.sh "$@"
}

# Helper to capture screenshots
capture() {
  local output_file="${OUTPUT_DIR}/${1}"
  podman cp "${POD}:/opt/Xvfb_screen0" - | tar xf - --to-command "convert xwd:- ${output_file}"
}

# Wait for container to start
echo "Waiting for D-Bus..."
sleep 5

# Set up GSK_RENDERER for consistent rendering
do_in_pod 'echo "export GSK_RENDERER=cairo" >> .bash_profile'

# Disable welcome tour
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

# Close overview
do_in_pod xdotool keydown super
sleep 0.5
do_in_pod xdotool keyup super
sleep 3

echo "Running visual tests..."

TESTS_FAILED=0
TESTS_RUN=0

# Test function: compares actual screenshot against reference
run_test() {
  local test_name="${1}"
  local reference="${REFERENCES_DIR}/${test_name}.png"
  local actual="${OUTPUT_DIR}/${test_name}.png"
  local diff="${OUTPUT_DIR}/${test_name}-diff.png"
  
  TESTS_RUN=$((TESTS_RUN + 1))
  echo -n "  ${test_name}... "
  
  if [[ ! -f "${reference}" ]]; then
    echo "SKIP (no reference)"
    return
  fi
  
  # Capture current state
  capture "${test_name}.png"
  
  # Compare with reference using ImageMagick
  # Use compare with MSE metric — if it returns 0, images are identical
  METRIC=$(compare -metric MSE "${reference}" "${actual}" "${diff}" 2>&1 || true)
  
  # Check if comparison succeeded (MSE of 0 = identical, small value = close match)
  # Threshold: MSE < 100 is considered a pass (allows minor rendering differences)
  if [[ -z "${METRIC}" ]] || [[ "${METRIC}" == "0" ]]; then
    echo "PASS (exact match)"
    rm -f "${diff}"
  else
    # Extract numeric value from compare output
    MSE=$(echo "${METRIC}" | grep -oP '[\d.]+')
    if (( $(echo "${MSE} < 100" | bc -l 2>/dev/null || echo 0) )); then
      echo "PASS (MSE: ${MSE})"
      rm -f "${diff}"
    else
      echo "FAIL (MSE: ${MSE})"
      TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
  fi
}

# Run tests
sleep 2
echo "1. Testing indicator-default..."
run_test "indicator-default-gnome-rawhide"

# Test preferences
echo "2. Testing preferences..."
do_in_pod gnome-extensions prefs "${EXTENSION_UUID}"
sleep 5
run_test "preferences-gnome-rawhide"
do_in_pod xdotool keydown alt
do_in_pod xdotool key F4
sleep 1
do_in_pod xdotool keyup alt

echo ""
echo "========================================="
echo "Results: $((TESTS_RUN - TESTS_FAILED))/${TESTS_RUN} passed"
if [[ ${TESTS_FAILED} -eq 0 ]]; then
  echo "All tests passed!"
  exit 0
else
  echo "${TESTS_FAILED} test(s) failed."
  echo "Diff images saved to: ${OUTPUT_DIR}"
  exit 1
fi
