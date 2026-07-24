#!/bin/bash
# Build the custom test container locally for development.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."

echo "Building test container..."
podman build -t voice-to-text-gnome-test -f "${SCRIPT_DIR}/Containerfile" "${PROJECT_ROOT}"

echo "Container built successfully: voice-to-text-gnome-test"
