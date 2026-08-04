# AT-SPI Nested Shell Skill

Scripts for interacting with a nested GNOME Shell instance using the AT-SPI accessibility API.

## Structure

```
atspi-nested-shell/
├── SKILL.md           # Skill definition and documentation
├── README.md          # This file
└── scripts/
    ├── atspi-query.sh         # Dump AT-SPI accessibility tree
    ├── atspi-find-indicator.sh # Find extension indicator
    ├── atspi-click-element.sh  # Click on element by name
    ├── open-prefs.sh           # Open extension preferences
    ├── dbus-call.sh            # Call D-Bus methods
    ├── dbus-list.sh            # List D-Bus services
    ├── portal-screenshot.sh    # Take screenshot via xdg-desktop-portal
    └── screenshot.sh           # Take screenshot (legacy)
```

## Prerequisites

Start the nested shell first:
```bash
just gnome-ext-dev
```

## Quick Start

```bash
cd skills/atspi-nested-shell/scripts

# Query the accessibility tree
./atspi-query.sh

# Find the Voice to Text extension
./atspi-find-indicator.sh

# Open extension preferences
./open-prefs.sh
```

## How It Works

These scripts work by:

1. Finding the nested GNOME Shell process (via `pgrep`)
2. Reading its D-Bus session address from `/proc/<pid>/environ`
3. Running commands with that `DBUS_SESSION_BUS_ADDRESS`

This allows interaction with the nested shell's isolated D-Bus session, separate from the host's session.
