# GNOME Shell Extension Reference

## Monitor/Display API

```typescript
// ✅ Correct - Get primary monitor dimensions
const monitor = Main.layoutManager.primaryMonitor;
const width = monitor.width;
const height = monitor.height;
const x = monitor.x;
const y = monitor.y;

// ❌ Deprecated/Removed - Don't use
// global.display.get_monitor_width(0)
// global.display.get_monitor_height(0)
// global.screen_width
// global.screen_height
```

## OSD Popup Pattern

```typescript
// Create OSD widget
const widget = new St.Widget({
    style: 'background-color: rgba(0, 0, 0, 0.8); border-radius: 12px;',
    x: (monitor.width - width) / 2,
    y: monitor.height - height - 50,
    width: width,
    height: height,
});

// Add to chrome (above panel)
Main.layoutManager.addTopChrome(widget);

// Remove when done
Main.layoutManager.removeChrome(widget);
widget.destroy();
```

## GObject + TypeScript Rules

```typescript
// ❌ DON'T - causes initialization issues
private _icon!: St.Icon;

// ✅ DO - matches JavaScript pattern
_icon: any = null;
```

## Key Imports

```typescript
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
```

## Common Patterns

### Panel Indicator
```typescript
export const MyIndicator = GObject.registerClass(
    class MyIndicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, 'My Extension');
            // Initialize properties here, NOT as class fields
            this._myProperty = null;
            this._buildUI();
        }
        
        _buildUI() {
            // Create widgets here
        }
    }
);
```

### Keybinding
```typescript
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

Main.wm.addKeybinding(
    'my-keybinding',
    settings,
    Meta.KeyBindingFlags.NONE,
    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
    callback
);
```

## GNOME Shell Version Compatibility

| Version | Key Changes |
|---------|-------------|
| 45 | ES modules required |
| 46-48 | Minor API changes |
| 49 | `Meta.LogicalMonitor` added |
| 50 | `global.display.get_monitor_*` removed |

## Resources

- [GNOME Shell Source](https://gitlab.gnome.org/GNOME/gnome-shell/-/tree/main/js)
- [GJS Guide](https://gjs.guide/extensions/)
- [API Docs](https://gjs-docs.gnome.org/)
- [Porting Guides](https://gjs.guide/extensions/upgrading/)
