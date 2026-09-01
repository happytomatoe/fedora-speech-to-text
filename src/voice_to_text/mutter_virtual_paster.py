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
        await self._try_connect()

    async def _try_connect(self) -> bool:
        """(Re)connect to the TypeText D-Bus service.

        The extension may register its service after this process starts
        (e.g. in headless E2E where gnome-shell boots later), so this can be
        called lazily at commit time rather than only during startup.
        """
        bus = None
        try:
            bus = await MessageBus(bus_type=BusType.SESSION).connect()
            introspection = await bus.introspect(self.DBUS_NAME, self.DBUS_PATH)
            proxy = bus.get_proxy_object(self.DBUS_NAME, self.DBUS_PATH, introspection)
            self._proxy = proxy.get_interface(self.DBUS_INTERFACE)
            if self._bus is not None:
                self._bus.disconnect()
            self._bus = bus
            self._usable = True
            self._is_running = True
            logger.info("MutterVirtualPaster: TypeText D-Bus service available")
            return True
        except (ConnectionError, OSError, DBusError) as e:
            logger.debug("MutterVirtualPaster: D-Bus check failed: %s", e)
            if bus is not None:
                bus.disconnect()
            self._usable = False
            return False

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
        # The extension's TypeText service may come up after this process
        # (e.g. in headless E2E where gnome-shell boots later), so retry the
        # connection lazily instead of relying only on the startup check.
        if (not self._proxy or not self._usable) and not await self._try_connect():
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
        # Just store the text - no D-Bus calls during streaming. Store even if
        # not currently usable: the TypeText service may come up later, and
        # flush() retries the connection before committing.
        self._typed_text = new_text

    async def flush(self) -> bool:
        """Commit the accumulated text to the input field."""
        if not self._typed_text:
            return False
        if not self._proxy or not self._usable:
            await self._try_connect()
            if not self._proxy or not self._usable:
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
