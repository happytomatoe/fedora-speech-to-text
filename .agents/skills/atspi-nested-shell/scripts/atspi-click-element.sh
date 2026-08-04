#!/usr/bin/env bash
# Click on an element in the nested GNOME Shell via AT-SPI
# Usage: atspi-click-element.sh <element_name_pattern>
# Example: atspi-click-element.sh "Voice to Text"
set -euo pipefail

ELEMENT_PATTERN="${1:-}"

if [ -z "$ELEMENT_PATTERN" ]; then
  echo "Usage: $0 <element_name_pattern>" >&2
  echo "Example: $0 'Voice to Text'" >&2
  exit 1
fi

NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | head -1 || true)
if [ -z "$NESTED_PID" ]; then
  echo "No nested GNOME Shell running. Run 'just gnome-ext-dev' first." >&2
  exit 1
fi

DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)
if [ -z "$DBUS_ADDR" ]; then
  echo "Could not find D-Bus address in nested shell process." >&2
  exit 1
fi

echo "Searching for element matching '$ELEMENT_PATTERN'..."
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" ELEMENT_PATTERN="$ELEMENT_PATTERN" python3 << 'PYEOF'
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
import subprocess
import sys
import os

pattern = os.environ['ELEMENT_PATTERN'].lower()

def find_and_click(node, depth=0):
    if depth > 10:
        return False
    
    role = node.get_role_name()
    name = node.get_name() or ''
    
    # Check if this element matches the pattern
    if pattern in name.lower():
        print(f"Found: [{role}] '{name}'")
        
        # Try to get bounds
        try:
            comp = node.get_component_iface()
            if comp:
                rect = comp.get_extents(Atspi.CoordType.SCREEN)
                if rect.width > 0 and rect.height > 0 and rect.x >= 0:
                    cx = rect.x + rect.width // 2
                    cy = rect.y + rect.height // 2
                    print(f"  Bounds: x={rect.x} y={rect.y} w={rect.width} h={rect.height}")
                    print(f"  Click at: ({cx}, {cy})")
                    
                    # Try to perform action
                    try:
                        action = node.get_action_iface()
                        if action:
                            n_actions = node.get_n_actions()
                            if n_actions > 0:
                                print(f"  Performing action 0...")
                                node.do_action(0)
                                print("  Action performed!")
                                return True
                    except Exception as e:
                        print(f"  Could not perform action: {e}")
                    
                    # Fallback: use xdotool if available
                    try:
                        print(f"  Trying xdotool click at ({cx}, {cy})...")
                        subprocess.run(['xdotool', 'mousemove', str(cx), str(cy)], check=True)
                        subprocess.run(['xdotool', 'click', '1'], check=True)
                        print("  Click performed via xdotool!")
                        return True
                    except FileNotFoundError:
                        print("  xdotool not available")
                    except Exception as e:
                        print(f"  xdotool failed: {e}")
                else:
                    print(f"  Invalid bounds: {rect}")
        except Exception as e:
            print(f"  Could not get bounds: {e}")
    
    # Search children
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if child:
            if find_and_click(child, depth + 1):
                return True
    
    return False

desktop = Atspi.get_desktop(0)
found = False
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if 'shell' in (app.get_name() or '').lower():
        print(f"Searching in {app.get_name()}...")
        if find_and_click(app):
            found = True
            break

if not found:
    print(f"Element matching '$ELEMENT_PATTERN' not found")
    sys.exit(1)
PYEOF
