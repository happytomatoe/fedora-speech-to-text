#!/usr/bin/env python3
"""Take a Wayland screenshot via xdg-desktop-portal."""

import sys

from gi.repository import Gio, GLib


def take_screenshot(output_path: str) -> bool:  # noqa: D103
    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    # Call portal Screenshot
    result = conn.call_sync(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
        "Screenshot",
        GLib.Variant("(sa{sv})", ("", {"interactive": GLib.Variant("b", False)})),
        GLib.VariantType.new("(o)"),
        Gio.DBusCallFlags.NONE,
        -1,
        None,
    )

    handle = result[0]

    # Collect response
    response_data = {"done": False, "success": False}

    def on_response(connection, sender, path, iface, signal, params):  # noqa: PLR0913, PLR0917
        response, results = params
        if response == 0:  # Success
            uri = results.get("uri")
            if uri:
                src = Gio.File.new_for_uri(uri)
                dst = Gio.File.new_for_path(output_path)
                src.copy(dst, Gio.FileCopyFlags.OVERWRITE, None, None)
                response_data["success"] = True
        response_data["done"] = True
        loop.quit()

    conn.signal_subscribe(
        None,
        "org.freedesktop.portal.Request",
        "Response",
        handle,
        None,
        Gio.DBusSignalFlags.NONE,
        on_response,
    )

    loop = GLib.MainLoop()
    GLib.timeout_add(5000, lambda: (loop.quit(), False))  # 5s timeout
    loop.run()

    return response_data["success"]


if __name__ == "__main__":
    output = sys.argv[1] if len(sys.argv) > 1 else "/tmp/screenshot.png"
    if take_screenshot(output):
        print(output)
        sys.exit(0)
    else:
        print("Screenshot failed", file=sys.stderr)
        sys.exit(1)
