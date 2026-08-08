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

    async def set_preedit_text(self, text: str, cursor: int = 0, anchor: int = 0, commit: bool = False) -> bool:
        """Set preedit text via GNOME Shell's inputMethod.

        During streaming, use commit=False to show text as preedit (composing).
        When done, use commit=True to commit the preedit to the input field.
        """
        if not self._proxy or not self._usable:
            logger.debug("MutterVirtualPaster: set_preedit_text() called but proxy not available")
            return False

        try:
            logger.info("MutterVirtualPaster: set_preedit_text() called with %d chars, commit=%s", len(text), commit)
            await self._proxy.call_set_preedit_text(text, cursor, anchor, commit)  # type: ignore[reportAttributeAccessIssue]
            logger.info("MutterVirtualPaster: set_preedit_text completed")
            return True
        except Exception as e:
            logger.warning("MutterVirtualPaster: set_preedit_text failed: %s", e)
            return False

    async def stream_diff(self, new_text: str) -> None:
        """Diff new_text against previously typed text and only output the new part.

        During streaming, uses preedit text to show progress without committing.
        This avoids the issue where commit() would append text instead of replacing.
        """
        if not self._usable or not new_text:
            return

        old_text = self._typed_text

        # Skip if no change
        if new_text == old_text:
            return

        # Find common prefix length
        common_len = 0
        min_len = min(len(old_text), len(new_text))
        while common_len < min_len and old_text[common_len] == new_text[common_len]:
            common_len += 1

        new_suffix = new_text[common_len:]

        if new_suffix:
            # Use preedit text during streaming (commit=False)
            # This shows the text as composing/underline without committing
            success = await self.set_preedit_text(new_text, cursor=len(new_text), anchor=0, commit=False)
            if not success:
                logger.warning("MutterVirtualPaster: stream_diff: set_preedit_text failed, not advancing state")
                return

        self._typed_text = new_text

    async def commit_preedit(self) -> bool:
        """Commit the current preedit text to the input field."""
        if not self._usable or not self._typed_text:
            return False

        try:
            # Commit the preedit text
            success = await self.set_preedit_text(self._typed_text, cursor=len(self._typed_text), anchor=0, commit=True)
            if success:
                logger.info("MutterVirtualPaster: commit_preedit completed")
            return success
        except Exception as e:
            logger.warning("MutterVirtualPaster: commit_preedit failed: %s", e)
            return False
