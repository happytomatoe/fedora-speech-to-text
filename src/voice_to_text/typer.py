"""
Mutter virtual typing engine for voice-to-text.

Types text via the GNOME Shell extension's D-Bus TypeText method.
Uses Clutter's virtual keyboard API through the extension's
``com.happytomatoe.TypeText`` D-Bus service.

References:
  - dotool docs: https://git.sr.ht/~geb/dotool
  - nerd-dictation diff algorithm: https://github.com/ideasman42/nerd-dictation
"""

import logging

try:
    from gi.repository import Gio, GLib  # type: ignore[import-untyped]
except ImportError:
    Gio = None  # type: ignore[assignment,misc]
    GLib = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)


class MutterVirtualTyper:
    """Types text via the GNOME Shell extension's D-Bus TypeText method.

    Uses Clutter's virtual keyboard API through the extension's
    ``com.happytomatoe.TypeText`` D-Bus service.

    Usage::

        typer = MutterVirtualTyper()
        await typer.start()              # check D-Bus availability
        await typer.stream_diff(text)    # incremental typing
        await typer.stop()               # cleanup
    """

    DBUS_NAME = "com.happytomatoe.TypeText"
    DBUS_PATH = "/com/happytomatoe/TypeText"
    DBUS_INTERFACE = "com.happytomatoe.TypeText"

    def __init__(self):
        self._typed_text: str = ""
        self._usable: bool = True
        self._proxy = None

    async def start(self) -> None:
        """Check if the TypeText D-Bus service is available."""
        if Gio is None or GLib is None:
            logger.error("MutterVirtualTyper: gi.repository not available")
            self._usable = False
            return
        try:
            bus = await Gio.DBusConnection.get(Gio.BusType.SESSION, None)
            result = await bus.call_sync(
                self.DBUS_NAME,
                self.DBUS_PATH,
                "org.freedesktop.DBus",
                "ListNames",
                GLib.Variant("()", ()),
                GLib.VariantType("(as)"),
                Gio.DBusCallFlags.NONE,
                -1,
                None,
            )
            names = result.get_child_value(0).unpack()
            if self.DBUS_NAME in names:
                logger.info("MutterVirtualTyper: TypeText D-Bus service available")
                self._proxy = True
                return
        except Exception as e:
            logger.debug("MutterVirtualTyper: D-Bus check failed: %s", e)

        logger.error("MutterVirtualTyper: TypeText not available")
        self._usable = False

    async def stream_diff(self, new_text: str) -> None:
        """Diff new_text against typed text and send corrections."""
        if new_text == self._typed_text:
            return

        if not self._proxy or not self._usable:
            return

        # Find common prefix
        old_text = self._typed_text
        common_len = 0
        min_len = min(len(old_text), len(new_text))
        while common_len < min_len and old_text[common_len] == new_text[common_len]:
            common_len += 1

        backspace_count = len(old_text) - common_len
        new_suffix = new_text[common_len:]

        try:
            bus = await Gio.DBusConnection.get(Gio.BusType.SESSION, None)

            # Send backspaces if needed
            if backspace_count > 0:
                bs_text = "\x08" * backspace_count  # backspace character
                await bus.call_sync(
                    self.DBUS_NAME,
                    self.DBUS_PATH,
                    self.DBUS_INTERFACE,
                    "TypeText",
                    GLib.Variant("(s,)", (bs_text,)),
                    None,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                )

            # Send new text
            if new_suffix:
                await bus.call_sync(
                    self.DBUS_NAME,
                    self.DBUS_PATH,
                    self.DBUS_INTERFACE,
                    "TypeText",
                    GLib.Variant("(s,)", (new_suffix,)),
                    None,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                )

            self._typed_text = new_text
        except Exception as e:
            logger.warning("MutterVirtualTyper: D-Bus call failed: %s", e)
            self._usable = False

    async def stop(self) -> None:
        """Cleanup."""
        self._proxy = None
        self._typed_text = ""

    @property
    def is_running(self) -> bool:
        return self._usable and self._proxy is not None

    @property
    def typed_text(self) -> str:
        return self._typed_text
