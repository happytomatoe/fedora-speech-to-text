#!/usr/bin/env bash
# Query AT-SPI accessibility tree in the nested GNOME Shell
set -euo pipefail

NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | head -1 || true)
if [ -z "$NESTED_PID" ]; then
  echo "No nested GNOME Shell running. Run 'just dev' first." >&2
  exit 1
fi

DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)
if [ -z "$DBUS_ADDR" ]; then
  echo "Could not find D-Bus address in nested shell process." >&2
  exit 1
fi

echo "Querying AT-SPI in nested shell (PID=$NESTED_PID)..."
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" python3 << 'PYEOF'
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

def dump(node, depth=0):
    if depth > 6:
        return
    role = node.get_role_name()
    name = node.get_name() or ''
    states = []
    try:
        for s in [Atspi.StateType.FOCUSED, Atspi.StateType.CHECKED, Atspi.StateType.SELECTED]:
            if node.get_state(s):
                states.append(str(s).split('.')[-1])
    except AttributeError:
        pass  # get_state may not be available in all AT-SPI versions
    state_str = f' [{", ".join(states)}]' if states else ''
    print('  ' * depth + f'[{role}] {name}{state_str}')
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if child:
            dump(child, depth + 1)

desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    print(f'\n=== {app.get_name()} ===')
    dump(app)
PYEOF
