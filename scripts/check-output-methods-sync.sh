#!/usr/bin/env bash
# Check that output methods are in sync across all files.
# Run: just check-output-methods-sync

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

# 1. Extract methods from engine.py
# - Explicit checks: output_method == "..."
# - The use_typing check includes "type" and "mutter-virtual"
ENGINE_METHODS=$(grep -oP 'output_method\s*==\s*"\K[^"]+' src/voice_to_text/engine.py | sort -u)
# Add 'type' if it's in the use_typing check
grep -q '"type"' src/voice_to_text/engine.py && ENGINE_METHODS=$(echo -e "$ENGINE_METHODS\ntype" | sort -u)

# 2. Extract methods from prefs/provider-row.js (combo.append('...', ...))
PREFS_METHODS=$(grep -oP "combo\.append\('\K[^']+" gnome-ext/prefs/provider-row.js | sort -u)

# 3. Extract methods from GSchema (allowed values in comment or default)
SCHEMA_METHODS=$(grep -oP 'output-method.*default.*"\K[^"]+' gnome-ext/schemas/*.xml 2>/dev/null | sort -u || echo "")

echo "=== Output Method Sync Check ==="
echo ""
echo "engine.py methods:      $ENGINE_METHODS"
echo "prefs.js methods:       $PREFS_METHODS"
echo "GSchema default:        ${SCHEMA_METHODS:-<none>}"
echo ""

# Compare engine vs prefs
ENGINE_ONLY=$(comm -23 <(echo "$ENGINE_METHODS") <(echo "$PREFS_METHODS") || true)
PREFS_ONLY=$(comm -13 <(echo "$ENGINE_METHODS") <(echo "$PREFS_METHODS") || true)

if [ -n "$ENGINE_ONLY" ]; then
    echo -e "${RED}✗ In engine.py but NOT in GNOME prefs:${NC}"
    echo "  $ENGINE_ONLY"
    ERRORS=$((ERRORS + 1))
fi

if [ -n "$PREFS_ONLY" ]; then
    echo -e "${RED}✗ In GNOME prefs but NOT in engine.py:${NC}"
    echo "  $PREFS_ONLY"
    ERRORS=$((ERRORS + 1))
fi

if [ -z "$ENGINE_ONLY" ] && [ -z "$PREFS_ONLY" ]; then
    echo -e "${GREEN}✓ Engine and prefs are in sync${NC}"
fi

# Check GSchema default matches one of the methods
if [ -n "$SCHEMA_METHODS" ]; then
    if echo "$ENGINE_METHODS" | grep -q "^${SCHEMA_METHODS}$"; then
        echo -e "${GREEN}✓ GSchema default '$SCHEMA_METHODS' is a valid method${NC}"
    else
        echo -e "${YELLOW}⚠ GSchema default '$SCHEMA_METHODS' not found in engine.py${NC}"
        ERRORS=$((ERRORS + 1))
    fi
fi

echo ""
if [ $ERRORS -gt 0 ]; then
    echo -e "${RED}Found $ERRORS sync issue(s). Files to update:${NC}"
    echo "  - src/voice_to_text/engine.py"
    echo "  - gnome-ext/prefs/provider-row.js"
    echo "  - gnome-ext/schemas/*.xml (if adding new method)"
    exit 1
else
    echo -e "${GREEN}All output methods are in sync!${NC}"
    exit 0
fi
