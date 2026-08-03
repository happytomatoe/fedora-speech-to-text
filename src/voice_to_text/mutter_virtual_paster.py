"""Paste text via GNOME Shell extension's PasteText D-Bus method.

Sets clipboard via St.Clipboard and sends Shift+Insert via virtual keyboard,
all inside the compositor. Avoids the timing issues of wl-copy + dotool paste.
"""

import asyncio
import logging

from dbus_next.aio import MessageBus
from dbus_next.constants import BusType

logger = logging.getLogger(__name__)


class MutterVirtualPaster:
    """Paste text via GNOME Shell extension's PasteText D-Bus method.

    Sets clipboard via St.Clipboard and sends Shift+Insert via virtual keyboard,
    all inside the compositor. Avoids the timing issues of wl-copy + dotool paste.
    """

    DBUS_NAME = "com.happytomatoe.TypeText"
    DBUS_PATH = "/com/happytomatoe/TypeText"
    DBUS_INTERFACE = "com.happytomatoe.TypeText"

    def __init__(self):
        self._usable: bool = True
        self._proxy = None
        self._bus: MessageBus | None = None
        self._current_text: str = ""
        self._is_running: bool = False

    async def start(self) -> None:
        """Check if the PasteText D-Bus service is available."""
        bus = None
        try:
            bus = await MessageBus(bus_type=BusType.SESSION).connect()
            introspection = await bus.introspect(self.DBUS_NAME, self.DBUS_PATH)
            proxy = bus.get_proxy_object(self.DBUS_NAME, self.DBUS_PATH, introspection)
            self._proxy = proxy.get_interface(self.DBUS_INTERFACE)
            self._bus = bus
            self._is_running = True
            logger.info("MutterVirtualPaster: PasteText D-Bus service available")
            return
        except Exception as e:
            logger.debug("MutterVirtualPaster: D-Bus check failed: %s", e)
            if bus is not None:
                bus.disconnect()
            self._usable = False

    async def paste(self, text: str) -> bool:
        """Paste text via PasteText D-Bus method with clipboard save/restore."""
        if not self._proxy or not self._usable:
            logger.debug("MutterVirtualPaster: paste() called but proxy not available")
            return False

        try:
            logger.info("MutterVirtualPaster: paste() called with %d chars: %.80r...", len(text), text)

            # Save current clipboard
            logger.debug("MutterVirtualPaster: calling SaveClipboard...")
            saved = await self._proxy.call_save_clipboard()  # type: ignore[reportAttributeAccessIssue]
            logger.info("MutterVirtualPaster: SaveClipboard returned: %.100r", saved)

            # Paste the new text
            logger.debug("MutterVirtualPaster: calling PasteText with %d chars...", len(text))
            await self._proxy.call_paste_text(text)  # type: ignore[reportAttributeAccessIssue]
            logger.info("MutterVirtualPaster: PasteText completed")

            # Delay to let paste happen before restoring clipboard
            await asyncio.sleep(0.5)

            # Restore previous clipboard
            logger.debug("MutterVirtualPaster: calling RestoreClipboard...")
            await self._proxy.call_restore_clipboard()  # type: ignore[reportAttributeAccessIssue]
            logger.info("MutterVirtualPaster: RestoreClipboard completed")

            return True
        except Exception as e:
            logger.warning("MutterVirtualPaster: D-Bus call failed: %s", e)
            self._usable = False
            return False

    async def stop(self) -> None:
        """Cleanup."""
        if self._bus:
            self._bus.disconnect()
            self._bus = None
        self._proxy = None
        self._is_running = False

    @property
    def is_running(self) -> bool:
        return self._usable and self._proxy is not None

    async def stream_diff(self, text: str) -> None:
        """Paste text via clipboard (for compatibility with engine interface)."""
        if text and self._usable:
            await self.paste(text)
