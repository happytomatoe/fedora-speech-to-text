#!/usr/bin/env python3
"""Input injection into headless mutter via org.gnome.Mutter.RemoteDesktop.

Mutter's RemoteDesktop Notify* methods must come from the D-Bus peer that
created the session, so each invocation runs the full lifecycle here:
create RD session + paired ScreenCast stream (absolute motion coordinates are
transformed through the stream), Start, inject, Stop.

Usage:
  remote_input.py click <x> <y>
  remote_input.py wheel <ticks>   (positive = scroll down)
  remote_input.py keysym <keyval> (press+release, e.g. 0xff09 Tab)
  remote_input.py move <x> <y>
"""

import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

RD_NAME = "org.gnome.Mutter.RemoteDesktop"
RD_PATH = "/org/gnome/Mutter/RemoteDesktop"
RD_IFACE = "org.gnome.Mutter.RemoteDesktop"
RD_SESS_IFACE = "org.gnome.Mutter.RemoteDesktop.Session"
SC_NAME = "org.gnome.Mutter.ScreenCast"
SC_PATH = "/org/gnome/Mutter/ScreenCast"
SC_IFACE = "org.gnome.Mutter.ScreenCast"
SC_SESS_IFACE = "org.gnome.Mutter.ScreenCast.Session"

AXIS_VERTICAL = 1
BTN_LEFT = 0x110


def call(bus, dest, path, iface, method, args_type, *args):  # noqa: PLR0913, PLR0917
    """Send a synchronous D-Bus method call and unpack the reply."""
    res = bus.call_sync(
        dest, path, iface, method, GLib.Variant(args_type, list(args)), None, Gio.DBusCallFlags.NONE, -1, None
    )
    return res.unpack()


def main() -> int:
    """Parse the CLI command (move/click/wheel/keysym) and inject it."""
    cmd, *rest = sys.argv[1:]
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    # call_sync unpacks single-value replies as 1-tuples: ('/path',), not
    # nested — [0][0] would slice the first character ('/') off the path.
    rd_path = call(bus, RD_NAME, RD_PATH, RD_IFACE, "CreateSession", "()")[0]
    session_id = call(
        bus, RD_NAME, rd_path, "org.freedesktop.DBus.Properties", "Get", "(ss)", RD_SESS_IFACE, "SessionId"
    )[0]

    sc_path = call(
        bus,
        SC_NAME,
        SC_PATH,
        SC_IFACE,
        "CreateSession",
        "(a{sv})",
        {"remote-desktop-session-id": GLib.Variant("s", session_id)},
    )[0]
    # RecordMonitor(""): mutter selects the primary monitor — the nested
    # headless virtual monitor's connector name varies, empty string is
    # canonical (meta_monitor_manager_get_primary_monitor).
    stream_path = call(bus, SC_NAME, sc_path, SC_SESS_IFACE, "RecordMonitor", "(sa{sv})", "", {})[0]

    call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "Start", "()")

    def pointer_move(x, y):
        call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "NotifyPointerMotionAbsolute", "(sdd)", stream_path, x, y)

    try:
        if cmd == "move":
            pointer_move(float(rest[0]), float(rest[1]))
        elif cmd == "click":
            x, y = float(rest[0]), float(rest[1])
            pointer_move(x, y)
            call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "NotifyPointerButton", "(ib)", BTN_LEFT, True)
            call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "NotifyPointerButton", "(ib)", BTN_LEFT, False)
        elif cmd == "wheel":
            # positive = scroll down
            call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "NotifyPointerAxisDiscrete", "(ui)", AXIS_VERTICAL, int(rest[0]))
        elif cmd == "keysym":
            kv = int(rest[0], 0)
            call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "NotifyKeyboardKeysym", "(ub)", kv, True)
            call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "NotifyKeyboardKeysym", "(ub)", kv, False)
        else:
            raise ValueError(f"unknown command {cmd!r}")
    finally:
        call(bus, RD_NAME, rd_path, RD_SESS_IFACE, "Stop", "()")

    return 0


if __name__ == "__main__":
    sys.exit(main())
