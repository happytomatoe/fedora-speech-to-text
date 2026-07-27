#!/bin/bash
# dotoolc wrapper that translates dotool commands to xdotool
# Used for E2E testing when dotool is not installed
# Reads commands from stdin (type ..., key ...) and executes via xdotool

while IFS= read -r line; do
    # Parse dotool commands
    if [[ "$line" =~ ^type\ (.+)$ ]]; then
        text="${BASH_REMATCH[1]}"
        # Unescape backslashes (dotool uses \\ for literal backslash)
        text="${text//\\\\/\\}"
        xdotool type --delay 0 "$text" 2>/dev/null
    elif [[ "$line" =~ ^key\ (.+)$ ]]; then
        key="${BASH_REMATCH[1]}"
        xdotool key "$key" 2>/dev/null
    elif [[ "$line" =~ ^keydelay\ (.+)$ ]]; then
        : # Ignore keydelay command (xdotool uses --delay flag)
    elif [[ "$line" =~ ^typedelay\ (.+)$ ]]; then
        : # Ignore typedelay command (xdotool uses --delay flag)
    fi
done
