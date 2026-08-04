---
name: atspi-nested-shell
description: "Use AT-SPI accessibility API to interact with nested GNOME Shell for testing GNOME extensions. Provides commands to start nested shell, query accessibility tree, find UI elements, and perform actions."
---

# AT-SPI Nested Shell Skill

Interact with nested GNOME Shell instances using the AT-SPI accessibility API for extension testing and development.

## Quick Start

```bash
# Start nested shell with AT-SPI support (visible window)
just gnome-ext-dev

# Or start headless (no window, no focus steal)
dbus-run-session -- gnome-shell --headless --virtual-monitor 1920x1080 &

# In another terminal, query the accessibility tree
just atspi-tree

# Find the Voice to Text extension indicator
just atspi-find-indicator
```

## Available Commands

### `atspi-tree`
Dump the full AT-SPI accessibility tree from the nested GNOME Shell.

```bash
just atspi-tree
```

Output shows the hierarchical tree of all accessible elements:
```
=== gnome-shell ===
[application] gnome-shell
  [window] Main stage
    [panel] 
      [label] Voice to Text
      [label] Settings
```

### `atspi-find-indicator`
Find the Voice to Text extension panel button with click coordinates.

```bash
just atspi-find-indicator
```

Output shows panel buttons and highlights the extension:
```
=== Scanning gnome-shell for panel buttons ===
  [panel-menu-button] name='Voice to Text'
    ^^^ FOUND YOUR EXTENSION! ^^^
    Click coordinates: (1850, 24)
```

## Architecture

### How AT-SPI Works

1. **AT-SPI Bus Launcher** (`/usr/libexec/at-spi-bus-launcher`) starts a dedicated D-Bus bus for accessibility
2. **AT-SPI Registry** (`/usr/libexec/at-spi2-registryd`) registers on that bus to provide the accessibility tree
3. **Applications** expose their UI elements via AT-SPI interfaces
4. **Clients** (like our scripts) query the tree via the D-Bus bus

### X11 Limitation (GNOME 50+)

GNOME Shell 50 **removed the X11 backend** from mutter. This means:

- `gnome-shell` can only run as a **Wayland compositor** (nested or standalone)
- There is no `--x11` flag — running without `--wayland` still defaults to Wayland
- **Xephyr, Xvfb, or any X11-based nested approach won't work**
- The nested shell creates an internal X11 display (e.g., `:2`) for Xwayland clients, but this is managed by the compositor and not accessible for external screenshots
- The `--devkit` flag (GNOME 49+) replaces the old `--nested` flag

**Impact for screenshots:** The `ffmpeg -f x11grab` method captures the Xwayland display only (often black). Use `xdg-desktop-portal` instead — it captures the Wayland compositor's view directly.
### Nested Shell Modes

GNOME Shell supports two nested modes:

#### Visible Mode (`--devkit`)

Opens a window on the host display. Use for interactive development.

```bash
dbus-run-session -- sh -c "
  /usr/libexec/at-spi-bus-launcher &
  sleep 0.5
  /usr/libexec/at-spi2-registryd --use-gnome-session &
  sleep 0.5
  voice-to-text-dbus &
  sleep 1
  gnome-shell --wayland --devkit
"
```

#### Headless Mode (`--headless --virtual-monitor`)

**No window on the host display** — runs entirely in the background with a virtual monitor. Ideal for:
- Automated E2E testing
- Not stealing focus from your current work
- Running multiple shells simultaneously

```bash
dbus-run-session -- sh -c "
  /usr/libexec/at-spi-bus-launcher &
  sleep 0.5
  /usr/libexec/at-spi2-registryd --use-gnome-session &
  sleep 0.5
  voice-to-text-dbus &
  sleep 1
  gnome-shell --headless --virtual-monitor 1920x1080
"
```

**Key differences:**
| Feature | `--devkit` | `--headless --virtual-monitor` |
|---------|-----------|-------------------------------|
| Window on host | ✅ Yes | ❌ No |
| Focus stealing | ⚠️ Yes | ✅ No |
| AT-SPI support | ✅ Yes | ✅ Yes |
| Portal screenshots | ✅ Yes | ✅ Yes |
| Interactive use | ✅ Yes | ❌ No |
| E2E testing | ⚠️ Possible | ✅ Recommended |

**Note:** The headless shell uses `--virtual-monitor WxH` to create a virtual output. Without it, the compositor has no output and nothing renders.

### Querying from Host

To query the nested shell's AT-SPI from another terminal:

```bash
# Find the nested shell PID (use tail -1 for most recent)
NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested|headless)" | tail -1)

# Get its D-Bus address
DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)

# Query AT-SPI
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" python3 -c "
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    print(f'{app.get_name()}')
"
```
### Querying from Host

To query the nested shell's AT-SPI from another terminal:

```bash
# Find the nested shell PID
NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | head -1)

# Get its D-Bus address
DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)

# Query AT-SPI
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" python3 -c "
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    print(f'{app.get_name()}')
"
```

## Python AT-SPI API Reference

### Core Objects

```python
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

# Get the desktop (root of the tree)
desktop = Atspi.get_desktop(0)

# Get number of applications
app_count = desktop.get_child_count()

# Get an application
app = desktop.get_child_at_index(i)
```

### Navigating the Tree

```python
# Get child count
node.get_child_count()

# Get child by index
child = node.get_child_at_index(i)

# Get parent (if available)
parent = node.get_parent()
```

### Getting Node Info

```python
# Role (widget type)
role = node.get_role_name()  # e.g., 'panel', 'label', 'button'

# Name (label text)
name = node.get_name()  # e.g., 'Voice to Text'

# Description
desc = node.get_description()
```

### Action Interface

```python
# Check if node has actions
action = node.get_action_iface()
if action:
    n_actions = node.get_n_actions()
    for i in range(n_actions):
        name = node.get_action_name(i)
        desc = node.get_action_description(i)
    
    # Perform an action
    node.do_action(0)  # Perform first action
```

### Component Interface (Bounds)

```python
# Get element bounds
comp = node.get_component_iface()
if comp:
    rect = comp.get_extents(Atspi.CoordType.SCREEN)
    print(f'Position: ({rect.x}, {rect.y})')
    print(f'Size: {rect.width}x{rect.height}')
    
    # Center point for clicking
    cx = rect.x + rect.width // 2
    cy = rect.y + rect.height // 2
```

### State Interface

```python
# Check element states
try:
    for s in [Atspi.StateType.FOCUSED, Atspi.StateType.CHECKED]:
        if node.get_state(s):
            print(f'State: {s}')
except AttributeError:
    pass  # Not all AT-SPI versions support get_state
```

## Scripts

All scripts are in the `scripts/` subdirectory:

```bash
cd skills/atspi-nested-shell/scripts
```

### AT-SPI Scripts

Query the AT-SPI accessibility tree:

```bash
# Dump the full AT-SPI tree
./atspi-query.sh

# Find the Voice to Text extension indicator
./atspi-find-indicator.sh

# Click on an element by name
./atspi-click-element.sh "Voice to Text"
```

### D-Bus Interaction Scripts

Interact with the nested shell's D-Bus session:

```bash
# Open the extension preferences dialog
./open-prefs.sh [extension-uuid]

# Call a D-Bus method
./dbus-call.sh <dest> <path> <interface> <method> [args...]

# List D-Bus services
./dbus-list.sh [filter]

# Take a screenshot (restricted — see Screenshots section below)
./screenshot.sh [output-file]

# Take screenshot via portal (recommended — works on GNOME 49+)
./portal-screenshot.sh [output-file]

### Screenshots

Taking screenshots of the nested GNOME Shell is **restricted in GNOME 49+** due to security changes. Here's what works and what doesn't:

| Method | Status | Notes |
|--------|--------|-------|
| `org.gnome.Shell.Screenshot` D-Bus | ❌ AccessDenied | Private API, restricted since GNOME 49 |
| `grim` | ❌ No protocol | Nested shell doesn't support `wlr-screencopy` |
| `gnome-screenshot` | ❌ Removed | Uninstalled upstream, uses restricted API |
| `ffmpeg -f x11grab` | ⚠️ Black image | Captures XWayland only, not Wayland compositor |
| **`xdg-desktop-portal`** | ✅ **Works** | **Recommended** — non-interactive, captures nested shell view |

**Recommended: Use xdg-desktop-portal** (the official Wayland screenshot API):

```bash
# Take screenshot via portal script (from host, against nested shell's D-Bus)
./portal-screenshot.sh /tmp/nested-shell.png

# Or use the justfile recipe
just atspi-screenshot
```

The portal works because it's the official Wayland screenshot API. On the first call, GNOME may ask for permission — after that, it remembers the choice.

**How it works:**
1. Calls `org.freedesktop.portal.Screenshot.Screenshot` with `interactive=false`
2. Subscribes to the `Response` signal on the request path
3. Copies the saved file from `~/Pictures/Screenshot-*.png` to your output path

**Portal script location:** `skills/atspi-nested-shell/scripts/portal-screenshot.sh`

### Taking Screenshots from Another Terminal

The portal screenshot needs the **nested shell's D-Bus session address** to capture what the nested compositor sees. Here's how to do it from another terminal:

```bash
# 1. Find the nested shell PID
NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | tail -1)

# 2. Get its D-Bus session address
DBUS_ADDR=$(tr '\0' '\n' < /proc/$NESTED_PID/environ | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-)

# 3. Take a screenshot using the nested shell's portal
DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" python3 << 'PYEOF'
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
import os, random, sys, shutil

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
screenshot_uri = None

def on_response(connection, sender_name, object_path, interface_name, signal_name, parameters, user_data):
    global screenshot_uri
    response_code = parameters[0]
    results = parameters[1]
    if response_code == 0:
        screenshot_uri = results.get('uri', '')
    else:
        print(f"Screenshot failed: {response_code}", file=sys.stderr)
    loop.quit()

token = f"screenshot_{random.randint(1000,9999)}"
unique_name = bus.get_unique_name().replace(':', '').replace('.', '_')
request_path = f"/org/freedesktop/portal/desktop/request/{unique_name}/{token}"

sub_id = bus.signal_subscribe(
    'org.freedesktop.portal.Desktop',
    'org.freedesktop.portal.Request',
    'Response',
    request_path, None,
    Gio.DBusSignalFlags.NONE, on_response, None
)

options = {
    'handle_token': GLib.Variant('s', token),
    'interactive': GLib.Variant('b', False),
    'modal': GLib.Variant('b', False),
}

result = bus.call_sync(
    'org.freedesktop.portal.Desktop',
    '/org/freedesktop/portal/desktop',
    'org.freedesktop.portal.Screenshot', 'Screenshot',
    GLib.Variant('(sa{sv})', ('', options)),
    GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, None
)

actual_path = result.unpack()[0]
GLib.timeout_add(10000, lambda: (print("Timeout", file=sys.stderr), loop.quit()))
loop.run()
bus.signal_unsubscribe(sub_id)

if screenshot_uri:
    path = screenshot_uri.replace('file://', '')
    if os.path.exists(path):
        dest = '/tmp/nested-shell-screenshot.png'
        shutil.copy2(path, dest)
        print(dest)
    else:
        print(f"File not found: {path}", file=sys.stderr)
else:
    print("No screenshot captured", file=sys.stderr)
PYEOF
```

**What the portal captures:** The portal screenshot captures what the **nested compositor sees** — its own desktop, panel, workspace, and any windows inside it. It does NOT capture the host's display. This is because the portal runs inside the nested shell's D-Bus session.

**Note:** For E2E testing, screenshots are optional — the core test flow uses D-Bus calls and log file verification, not visual assertions.

## Troubleshooting

### "No nested GNOME Shell running"

The nested shell isn't started. Run:
```bash
just gnome-ext-dev
```

### "Couldn't connect to accessibility bus"

The AT-SPI bus launcher isn't running. Check:
```bash
ps aux | grep at-spi-bus-launcher
```

If not running, restart the nested shell:
```bash
# Kill old shell
pkill -f "gnome-shell --wayland --devkit"

# Start fresh
just gnome-ext-dev
```

### "Permission denied" errors

The AT-SPI registry might not have started. Check logs:
```bash
tail -50 logs/gnome-ext-dev.log | grep -i at-spi
```

### Extension not found in AT-SPI tree

The extension's panel button might not expose its name. Try:
1. Check if extension is enabled: `gnome-extensions list --enabled`
2. Check extension logs: `tail -50 logs/gnome-ext-dev.log | grep -i VoiceToText`
3. Use `atspi-tree` to manually inspect the panel children

### Portal screenshot returns black or empty image

The portal may need permission. Run the screenshot interactively once:
```bash
# Use the portal-screenshot.sh script — first call may prompt for permission
./portal-screenshot.sh /tmp/test.png
```
After granting permission, subsequent calls with `interactive=false` will work.

### Multiple nested shells running

If you have multiple nested shells (e.g., from different users), use `tail -1` to get the most recent one:
```bash
NESTED_PID=$(pgrep -f "gnome-shell --.*--(devkit|nested)" | tail -1)
```
## Integration with E2E Tests

The AT-SPI scripts can be used in E2E tests to:

1. **Verify UI state** - Check that elements exist and have expected properties
2. **Perform actions** - Click buttons, type text via accessibility interfaces
3. **Assert conditions** - Verify element names, states, and positions

Example test usage:
```typescript
import { execSync } from 'child_process';

// Get AT-SPI tree
const tree = execSync('just atspi-tree', { encoding: 'utf-8' });

// Check extension is present
if (tree.includes('Voice to Text')) {
  console.log('Extension indicator found');
} else {
  throw new Error('Extension indicator not found');
}
```
