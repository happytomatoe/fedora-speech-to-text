#!/bin/bash
# Upload base image to Filen for CI fallback
# Run once after building the image: ./e2e/upload-to-filen.sh
#
# Requires: filen CLI installed (npm install -g @filen/cli)
# Requires: FILEN_EMAIL and FILEN_PASSWORD env vars or filen credentials configured

set -euo pipefail

IMAGE="e2e/qemu-images/golden-gnome-deps.qcow2"

if [ ! -f "$IMAGE" ]; then
  echo "Base image not found: $IMAGE"
  echo "Run 'just qemu-e2e-setup' first"
  exit 1
fi

SIZE=$(du -h "$IMAGE" | cut -f1)
echo "Uploading $IMAGE ($SIZE) to Filen..."
filen upload "$IMAGE" /
echo "Done. Image available at /golden-gnome-deps.qcow2"
