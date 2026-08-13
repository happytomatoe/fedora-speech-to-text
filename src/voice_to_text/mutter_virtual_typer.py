"""Types text via the GNOME Shell extension's D-Bus TypeText method.

Uses Clutter's virtual keyboard API through the extension's
``com.happytomatoe.TypeText`` D-Bus service. Falls back to dotool
if the D-Bus service is unavailable.

Usage::

    typer = MutterVirtualTyper()
    await typer.start()              # check D-Bus availability
    await typer.stream_diff(text)    # incremental typing
    await typer.stop()               # cleanup
"""

import logging

from dbus_next import BusType
from dbus_next.aio import MessageBus

logger = logging.getLogger(__name__)


class MutterVirtualTyper:
    """Types text via the GNOME Shell extension's D-Bus TypeText method."""

    DBUS_NAME = "com.happytomatoe.TypeText"
    DBUS_PATH = "/com/happytomatoe/TypeText"
    DBUS_INTERFACE = "com.happytomatoe.TypeText"

    def __init__(self):
        """Initialize the Mutter virtual typer."""
        self._typed_text: str = ""
        self._usable: bool = True
        self._proxy = None
        self._bus: MessageBus | None = None

    async def start(self) -> None:
        """Check if the TypeText D-Bus service is available."""
        bus = None
        try:
            bus = await MessageBus(bus_type=BusType.SESSION).connect()
            introspection = await bus.introspect(self.DBUS_NAME, self.DBUS_PATH)
            proxy = bus.get_proxy_object(self.DBUS_NAME, self.DBUS_PATH, introspection)
            self._proxy = proxy.get_interface(self.DBUS_INTERFACE)
            self._bus = bus
            logger.info("MutterVirtualTyper: TypeText D-Bus service available")
            return
        except Exception as e:
            logger.debug("MutterVirtualTyper: D-Bus check failed: %s", e)
            if bus is not None:
                bus.disconnect()

        # D-Bus service not available
        logger.warning("MutterVirtualTyper: TypeText D-Bus service not available")
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

        logger.debug(
            "MutterVirtualTyper: stream_diff: backspaces=%d, new_suffix=%d chars, old=%d, new=%d",
            backspace_count,
            len(new_suffix),
            len(old_text),
            len(new_text),
        )
        try:
            # Send backspaces if needed
            if backspace_count > 0:
                bs_text = "\x08" * backspace_count
                await self._proxy.call_type_text(bs_text)  # type: ignore[reportAttributeAccessIssue]

            # Send new text
            if new_suffix:
                await self._proxy.call_type_text(new_suffix)  # type: ignore[reportAttributeAccessIssue]
                logger.debug("MutterVirtualTyper: Sending %d chars via D-Bus", len(new_suffix))

            self._typed_text = new_text
        except Exception as e:
            logger.warning("MutterVirtualTyper: D-Bus call failed: %s", e)
            self._usable = False

    async def stop(self) -> None:
        """Cleanup."""
        if self._bus:
            self._bus.disconnect()
            self._bus = None
        self._proxy = None
        self._typed_text = ""

    @property
    def is_running(self) -> bool:
        """Return True if connected to the D-Bus service."""
        return self._usable and self._proxy is not None

    @property
    def typed_text(self) -> str:
        """Return the text that has been typed so far."""
        return self._typed_text
