#!/bin/bash
# Check if source files changed
SOURCE_FILES=$(git diff --name-only @{upstream}..HEAD -- "gnome-ext/**/*.js" "src/**/*.py" 2>/dev/null)
if [ -z "$SOURCE_FILES" ]; then
  echo "Skipping E2E tests (no source files changed)"
  exit 0
fi

# Check if QEMU environment is set up
if [ ! -f e2e/qemu-images/base.qcow2 ] || [ ! -f e2e/qemu-images/cloud-init.iso ]; then
  echo "ERROR: E2E tests require QEMU images but they are not set up."
  echo "Run: just qemu-e2e-check"
  exit 1
fi

echo "Running E2E tests (source files changed: $(echo "$SOURCE_FILES" | wc -l) files)"
cd e2e && bun run e2e.ts --shutdown
