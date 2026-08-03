"""Paste text via GNOME Shell extension's PasteText D-Bus method.

Sets clipboard via St.Clipboard and sends Shift+Insert via dotool.
Falls back to dotool for Shift+Insert in nested shells where virtual keyboard fails.
"""

import asyncio
import logging
import os

from dbus_next.aio import MessageBus
from dbus_next.constants import BusType

logger = logging.getLogger(__name__)


class MutterVirtualPaster:
    """Paste text via GNOME Shell extension's PasteText D-Bus method.

    Sets clipboard via St.Clipboard and sends Shift+Insert via dotool.
    The virtual keyboard's Shift+Insert doesn't work in nested shells,
    so we use dotool as a fallback.
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
        self._dotoolc_process: asyncio.subprocess.Process | None = None
        self._dotoolc_path: str | None = None

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
            # Find dotoolc for sending Shift+Insert
            import shutil

            self._dotoolc_path = shutil.which("dotoolc")
            if not self._dotoolc_path:
                local_bin = os.path.expanduser("~/.local/bin/dotoolc")
                if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
                    self._dotoolc_path = local_bin
            if self._dotoolc_path:
                logger.info("MutterVirtualPaster: dotoolc found at %s", self._dotoolc_path)
            else:
                logger.warning("MutterVirtualPaster: dotoolc not found, Shift+Insert may not work")
            return
        except Exception as e:
            logger.debug("MutterVirtualPaster: D-Bus check failed: %s", e)
            if bus is not None:
                bus.disconnect()
            self._usable = False

    async def _send_shift_insert(self) -> None:
        """Send Shift+Insert via dotoolc to paste from clipboard."""
        if not self._dotoolc_path:
            logger.debug("MutterVirtualPaster: dotoolc not available, skipping Shift+Insert")
            return
        try:
            # Find dotool pipe path
            pipe_path = None
            env_pipe = os.environ.get("DOTOOL_PIPE")
            if env_pipe and os.path.exists(env_pipe):
                pipe_path = env_pipe
            else:
                xdg_runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
                xdg_pipe = os.path.join(xdg_runtime, "dotool-pipe")
                if os.path.exists(xdg_pipe):
                    pipe_path = xdg_pipe
            if not pipe_path:
                logger.warning("MutterVirtualPaster: dotool pipe not found")
                return
            # Write Shift+Insert command to dotool pipe
            cmd = b"key shift+insert\n"
            proc = await asyncio.create_subprocess_exec(
                "sh",
                "-c",
                f"echo '{cmd.decode().strip()}' > {pipe_path}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()
            if proc.returncode == 0:
                logger.info("MutterVirtualPaster: Sent Shift+Insert via dotool")
            else:
                logger.warning("MutterVirtualPaster: dotool command failed")
        except Exception as e:
            logger.warning("MutterVirtualPaster: Failed to send Shift+Insert: %s", e)

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

            # Set clipboard to new text (PasteText also tries virtual keyboard Shift+Insert, which may fail)
            logger.debug("MutterVirtualPaster: calling PasteText with %d chars...", len(text))
            await self._proxy.call_paste_text(text)  # type: ignore[reportAttributeAccessIssue]
            logger.info("MutterVirtualPaster: PasteText completed")

            # Send Shift+Insert via dotool (works in nested shells where virtual keyboard fails)
            await self._send_shift_insert()

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
