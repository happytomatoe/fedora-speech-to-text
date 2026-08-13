#!/usr/bin/env bash
# Find the Voice to Text indicator in the panel via AT-SPI
set -euo pipefail

NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | head -1 || true)
if [ -z "$NESTED_PID" ]; then
  echo "No nested GNOME Shell running. Run 'just dev' first." >&2
  exit 1
fi

DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)

DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" python3 << 'PYEOF'
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

def find_indicator(node, depth=0, path=''):
    role = node.get_role_name()
    name = node.get_name() or ''
    
    # Look for panel buttons (extension indicators are typically panel-menu-button)
    if role in ('panel-menu-button', 'toggle-button', 'button'):
        has_name = bool(name)
        # Print all panel buttons to help identify the extension
        if depth < 6:  # Only print top-level items
            print(f'{"  " * depth}[{role}] name="{name}"')
        
        # Check if this is the Voice to Text indicator
        if 'voice' in name.lower() or 'text' in name.lower():
            print(f'{"  " * depth}  ^^^ FOUND YOUR EXTENSION! ^^^')
            try:
                comp = node.get_component_iface()
                if comp:
                    rect = comp.get_extents(Atspi.CoordType.SCREEN)
                    cx = rect.x + rect.width // 2
                    cy = rect.y + rect.height // 2
                    print(f'{"  " * depth}  Click coordinates: ({cx}, {cy})')
            except Exception as e:
                print(f'{"  " * depth}  Could not get bounds: {e}')
    
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if child:
            find_indicator(child, depth + 1, f'{path}/{role}')

desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if 'shell' in (app.get_name() or '').lower():
        print(f'\n=== Scanning {app.get_name()} for panel buttons ===')
        find_indicator(app)
PYEOF
