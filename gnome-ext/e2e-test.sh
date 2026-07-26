#!/usr/bin/env bash
# Simple E2E test for GNOME Shell extension
# Tests that the extension loads without errors

set -euo pipefail

UUID="voice-to-text@happytomatoe.com"
LOG_FILE="/tmp/gnome-shell-e2e-test.log"
TIMEOUT=10

echo "=== GNOME Shell Extension E2E Test ==="
echo "Extension: $UUID"
echo ""

# Clean up previous logs
> "$LOG_FILE"

# Install extension
echo "1. Installing extension..."
just gnome-ext-install 2>&1 | tail -1

# Enable extension
echo "2. Enabling extension..."
gnome-extensions enable "$UUID" 2>/dev/null || true

# Start nested GNOME Shell and capture logs
echo "3. Starting nested GNOME Shell (timeout: ${TIMEOUT}s)..."

# Run in background and capture output
timeout "$TIMEOUT" gnome-shell --nested --wayland 2>&1 | tee "$LOG_FILE" &
SHELL_PID=$!

# Wait for shell to start
sleep 3

# Check for errors
echo "4. Checking for errors..."
if grep -q "JS ERROR" "$LOG_FILE" 2>/dev/null; then
    echo "❌ Found JavaScript errors:"
    grep "JS ERROR" "$LOG_FILE"
    ERROR_COUNT=$(grep -c "JS ERROR" "$LOG_FILE")
else
    echo "✅ No JavaScript errors found"
    ERROR_COUNT=0
fi

# Check for critical errors
if grep -q "Gjs-CRITICAL" "$LOG_FILE" 2>/dev/null; then
    echo "❌ Found critical errors:"
    grep "Gjs-CRITICAL" "$LOG_FILE"
    ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# Check extension loaded
if grep -q "VoiceToText: D-Bus proxy connected" "$LOG_FILE" 2>/dev/null; then
    echo "✅ Extension loaded and connected to D-Bus"
else
    echo "⚠️  Extension may not have loaded (D-Bus service not running?)"
fi

# Kill the nested shell
kill "$SHELL_PID" 2>/dev/null || true
wait "$SHELL_PID" 2>/dev/null || true

echo ""
echo "=== Test Results ==="
if [ "$ERROR_COUNT" -eq 0 ]; then
    echo "✅ PASSED - No errors detected"
    exit 0
else
    echo "❌ FAILED - Found $ERROR_COUNT error(s)"
    echo "Full log: $LOG_FILE"
    exit 1
fi
