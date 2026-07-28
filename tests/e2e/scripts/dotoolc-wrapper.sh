#!/bin/bash
# dotool daemon shim for E2E testing
# Mimics dotoold by reading from dotool-pipe and translating to xdotool
# Used when dotoold can't run (no /dev/uinput access in QEMU VM)

PIPE_PATH="${DOTOOL_PIPE:-/run/user/$(id -u)/dotool-pipe}"

# Create the pipe if it doesn't exist
mkdir -p "$(dirname "$PIPE_PATH")"
if [[ ! -p "$PIPE_PATH" ]]; then
    rm -f "$PIPE_PATH"
    mkfifo "$PIPE_PATH"
fi

# Redirect stderr to log file for debugging
exec 2>/tmp/dotool-shim.log

echo "[$(date)] dotool-shim: Starting, pipe=$PIPE_PATH" >&2

# Read from pipe and translate to xdotool (like dotoold would)
while IFS= read -r line; do
    echo "[$(date)] dotool-shim: Got: $line" >&2
    
    # Parse dotool commands
    if [[ "$line" =~ ^type\ (.+)$ ]]; then
        text="${BASH_REMATCH[1]}"
        # Unescape backslashes (dotool uses \\ for literal backslash)
        text="${text//\\\\/\\}"
        echo "[$(date)] dotool-shim: Typing: $text" >&2
        xdotool type --delay 0 "$text" 2>/dev/null
    elif [[ "$line" =~ ^key\ (.+)$ ]]; then
        key="${BASH_REMATCH[1]}"
        echo "[$(date)] dotool-shim: Key: $key" >&2
        xdotool key "$key" 2>/dev/null
    elif [[ "$line" =~ ^keydelay\ (.+)$ ]]; then
        : # Ignore keydelay command
    elif [[ "$line" =~ ^typedelay\ (.+)$ ]]; then
        : # Ignore typedelay command
    fi
done < "$PIPE_PATH"
