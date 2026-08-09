"""Commit text via GNOME Shell extension's D-Bus method.

Uses Main.inputMethod.commit() to bypass clipboard and keystroke simulation entirely.
"""

import logging

from dbus_next import DBusError
from dbus_next.aio import MessageBus
from dbus_next.constants import BusType

logger = logging.getLogger(__name__)


class MutterVirtualPaster:
    """Commit text via GNOME Shell extension's D-Bus method.

    Uses Main.inputMethod.commit() to bypass clipboard and keystroke simulation.
    """

    DBUS_NAME = "com.happytomatoe.TypeText"
    DBUS_PATH = "/com/happytomatoe/TypeText"
    DBUS_INTERFACE = "com.happytomatoe.TypeText"

    def __init__(self):
        """Initialize the Mutter virtual paster."""
        self._usable: bool = True
        self._proxy = None
        self._bus: MessageBus | None = None
        self._typed_text: str = ""
        self._is_running: bool = False

    async def start(self) -> None:
        """Check if the TypeText D-Bus service is available."""
        bus = None
        try:
            bus = await MessageBus(bus_type=BusType.SESSION).connect()
            introspection = await bus.introspect(self.DBUS_NAME, self.DBUS_PATH)
            proxy = bus.get_proxy_object(self.DBUS_NAME, self.DBUS_PATH, introspection)
            self._proxy = proxy.get_interface(self.DBUS_INTERFACE)
            self._bus = bus
            self._is_running = True
            logger.info("MutterVirtualPaster: TypeText D-Bus service available")
            return
        except (ConnectionError, OSError, DBusError) as e:
            logger.debug("MutterVirtualPaster: D-Bus check failed: %s", e)
            if bus is not None:
                bus.disconnect()
            self._usable = False

    async def stop(self) -> None:
        """Disconnect from D-Bus."""
        if self._bus:
            self._bus.disconnect()
            self._bus = None
        self._proxy = None
        self._is_running = False

    @property
    def is_running(self) -> bool:
        """Return True if connected to the D-Bus service."""
        return self._usable and self._proxy is not None

    async def commit_text(self, text: str) -> bool:
        """Commit text directly via GNOME Shell's inputMethod."""
        if not self._proxy or not self._usable:
            logger.debug("MutterVirtualPaster: commit_text() called but proxy not available")
            return False

        try:
            logger.info("MutterVirtualPaster: commit_text() called with %d chars", len(text))
            await self._proxy.call_commit_text(text)  # type: ignore[reportAttributeAccessIssue]
            logger.info("MutterVirtualPaster: commit_text completed")
            return True
        except Exception as e:
            logger.warning("MutterVirtualPaster: commit_text failed: %s", e)
            return False

    async def stream_diff(self, new_text: str) -> None:
        """Store streaming text. Actual commit happens via commit_text() at the end.

        During streaming, we only track the text without making D-Bus calls.
        This avoids issues with preedit rendering and commit appending.
        """
        if not self._usable:
            return

        # Just store the text - no D-Bus calls during streaming
        self._typed_text = new_text

    async def flush(self) -> bool:
        """Commit the accumulated text to the input field."""
        if not self._usable or not self._typed_text:
            return False

        try:
            success = await self.commit_text(self._typed_text)
            if success:
                self._typed_text = ""
                logger.info("MutterVirtualPaster: flush completed")
            return success
        except Exception as e:
            logger.warning("MutterVirtualPaster: flush failed: %s", e)
            return False
