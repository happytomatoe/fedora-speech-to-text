---
name: atspi-nested-shell
description: "Use AT-SPI accessibility API to interact with nested GNOME Shell for testing GNOME extensions. Provides commands to start nested shell, query accessibility tree, find UI elements, and perform actions."
---

# AT-SPI Nested Shell Skill

Interact with nested GNOME Shell instances using the AT-SPI accessibility API for extension testing and development.

## Quick Start

```bash
# Start nested shell with AT-SPI support
just gnome-ext-dev

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

### Nested Shell Setup

The `gnome-ext-dev` recipe starts:

```bash
dbus-run-session -- sh -c "
  # Start AT-SPI accessibility bus
  /usr/libexec/at-spi-bus-launcher &
  sleep 0.5
  
  # Start AT-SPI registry daemon
  /usr/libexec/at-spi2-registryd --use-gnome-session &
  sleep 0.5
  
  # Start D-Bus service
  voice-to-text-dbus &
  sleep 1
  
  # Start GNOME Shell
  gnome-shell --wayland --devkit
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

# Take a screenshot (may be restricted — see Screenshots section below)
./screenshot.sh [output-file]
```

### Screenshots

Taking screenshots of the nested GNOME Shell is **restricted in GNOME 49+** due to security changes. Here's what works and what doesn't:

| Method | Status | Notes |
|--------|--------|-------|
| `org.gnome.Shell.Screenshot` D-Bus | ❌ AccessDenied | Private API, restricted since GNOME 49 |
| `grim` | ❌ No protocol | Nested shell doesn't support `wlr-screencopy` |
| `gnome-screenshot` | ❌ Removed | Uninstalled upstream, uses restricted API |
| `ffmpeg -f x11grab` | ⚠️ Black image | Captures XWayland only, not Wayland compositor |
| **`xdg-desktop-portal`** | ✅ **Works** | **Recommended** — non-interactive, saves to `~/Pictures/` |

**Recommended: Use xdg-desktop-portal** (the official Wayland screenshot API):

```bash
# Take screenshot via portal script
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

For E2E testing, screenshots are optional — the core test flow uses D-Bus calls and log file verification, not visual assertions.

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
