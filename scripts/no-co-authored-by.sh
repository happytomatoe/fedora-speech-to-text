#!/usr/bin/env bash
set -euo pipefail

msg_file="${1:?commit message file required}"

if grep -iqE '^[[:space:]]*Co-Authored-By:' "$msg_file"; then
    echo "ERROR: commit message contains a 'Co-Authored-By' trailer." >&2
    echo "Remove it — the pi git-commit skill forbids Co-Authored-By lines." >&2
    exit 1
fi
