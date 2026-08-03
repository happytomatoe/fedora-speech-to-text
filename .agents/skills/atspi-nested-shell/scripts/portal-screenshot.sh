#!/usr/bin/env bash
# Take a screenshot using xdg-desktop-portal (works on GNOME 49+)
# This is the only reliable method for nested GNOME Shell screenshots
#
# Usage: portal-screenshot.sh [output-file]
# Default output: /tmp/portal-screenshot.png
set -euo pipefail

OUTPUT_FILE="${1:-/tmp/portal-screenshot.png}"
export SCREENSHOT_OUTPUT="$OUTPUT_FILE"

echo "Taking screenshot via xdg-desktop-portal..."

python3 << 'PYEOF'
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
import os
import random
import sys
import shutil

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
screenshot_uri = None

def on_response(connection, sender_name, object_path, interface_name, signal_name, parameters, user_data):
    global screenshot_uri
    response_code = parameters[0]
    results = parameters[1]
    
    if response_code == 0:
        screenshot_uri = results.get('uri', '')
    elif response_code == 1:
        print("User cancelled the screenshot", file=sys.stderr)
    else:
        print(f"Screenshot failed with code: {response_code}", file=sys.stderr)
    loop.quit()

# Generate unique token
token = f"screenshot_{random.randint(1000,9999)}"
unique_name = bus.get_unique_name().replace(':', '').replace('.', '_')
request_path = f"/org/freedesktop/portal/desktop/request/{unique_name}/{token}"

# Subscribe to Response signal
sub_id = bus.signal_subscribe(
    'org.freedesktop.portal.Desktop',
    'org.freedesktop.portal.Request',
    'Response',
    request_path,
    None,
    Gio.DBusSignalFlags.NONE,
    on_response,
    None
)

# Call Screenshot (non-interactive)
options = {
    'handle_token': GLib.Variant('s', token),
    'interactive': GLib.Variant('b', False),
    'modal': GLib.Variant('b', False),
}

result = bus.call_sync(
    'org.freedesktop.portal.Desktop',
    '/org/freedesktop/portal/desktop',
    'org.freedesktop.portal.Screenshot',
    'Screenshot',
    GLib.Variant('(sa{sv})', ('', options)),
    GLib.VariantType('(o)'),
    Gio.DBusCallFlags.NONE,
    -1,
    None
)

actual_path = result.unpack()[0]

# Wait for response (up to 10 seconds)
GLib.timeout_add(10000, lambda: (print("Timeout waiting for portal response", file=sys.stderr), loop.quit()))
loop.run()

bus.signal_unsubscribe(sub_id)

if screenshot_uri:
    path = screenshot_uri.replace('file://', '')
    if os.path.exists(path):
        dest = os.environ.get('SCREENSHOT_OUTPUT', '/tmp/portal-screenshot.png')
        shutil.copy2(path, dest)
        print(dest)
    else:
        print(f"File not found: {path}", file=sys.stderr)
        sys.exit(1)
else:
    print("No screenshot captured", file=sys.stderr)
    sys.exit(1)
PYEOF
