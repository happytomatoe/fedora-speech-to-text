"""Persistent screencast caller for the CI E2E harness.

gnome-shell aborts a screencast with "Sender has vanished" when the D-Bus
caller disconnects — a one-shot `gdbus call` exits right after the call, so
the recording dies. This helper keeps the bus connection open (GLib.MainLoop)
until SIGTERM/SIGINT, then stops the screencast gracefully on the same
connection. Exit codes: 0 = started+stopped ok, 1 = start failed.
"""

import os
import signal
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

if len(sys.argv) != 2:  # noqa: PLR2004 -- argv arity check, not a magic threshold
    sys.exit("usage: screencast-holder.py <file-template>")

template = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

result = bus.call_sync(
    "org.gnome.Shell.Screencast",
    "/org/gnome/Shell/Screencast",
    "org.gnome.Shell.Screencast",
    "Screencast",
    GLib.Variant("(sa{sv})", (template, {})),
    GLib.VariantType("(bs)"),
    Gio.DBusCallFlags.NONE,
    -1,
    None,
)
started, path = result.unpack()
print(f"screencast-start {'ok' if started else 'failed'} {path}", flush=True)
if not started:
    sys.exit(1)


def stop_and_exit(_signum: int, _frame: object) -> None:
    """Stop the screencast session on signal, then exit cleanly."""
    try:
        bus.call_sync(
            "org.gnome.Shell.Screencast",
            "/org/gnome/Shell/Screencast",
            "org.gnome.Shell.Screencast",
            "StopScreencast",
            None,
            None,
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
        print("screencast-stop ok", flush=True)
    finally:
        os._exit(0)


signal.signal(signal.SIGTERM, stop_and_exit)
signal.signal(signal.SIGINT, stop_and_exit)

GLib.MainLoop().run()
