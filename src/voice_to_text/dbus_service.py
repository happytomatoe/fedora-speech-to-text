"""D-Bus service definition for voice-to-text.

Uses dbus-next (pure Python, native asyncio, zero dependencies).

Interface: com.happytomatoe.VoiceToText
Object path: /com/happytomatoe/VoiceToText
Bus: session

In dbus-next, signals are emitted by calling the ``@signal()``-decorated method.
The return value of that method is sent as the signal payload.
"""

import asyncio
import json
import logging
from collections.abc import Coroutine
from typing import Any

import sounddevice as sd
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method, signal

from voice_to_text.engine import EngineState, RecordingEngine

logger = logging.getLogger(__name__)


SERVICE_NAME = "com.happytomatoe.VoiceToText"
OBJECT_PATH = "/com/happytomatoe/VoiceToText"


# ── Signal values (stashed by callbacks, read by signal getters) ──────
# dbus-next signals: the @signal() method's return value is emitted.
# We stash the current value on the interface and the signal method reads it.


def list_input_devices() -> list[list[str]]:
    """Return available input devices as (id, label) pairs.

    Only devices that support 16 kHz mono capture (what the recorder uses)
    are listed, to avoid "invalid sample rate" failures at record time. The
    first entry uses the id "__system_default__" which tells the engine to
    let PortAudio choose the input device.
    """
    devices: list[list[str]] = [["__system_default__", "System default"]]
    seen: set[str] = set()
    try:
        all_devices = sd.query_devices()
    except Exception:
        return devices
    for i, d in enumerate(all_devices):
        if d.get("max_input_channels", 0) <= 0:
            continue
        name = d["name"]
        if name in seen:
            continue
        try:
            sd.check_input_settings(device=i, samplerate=16000, channels=1)
        except Exception:
            continue
        seen.add(name)
        devices.append([name, name])
    return devices


class VoiceToTextInterface(ServiceInterface):
    """D-Bus interface for voice-to-text recording service.

    Exposes ``StartRecording``, ``StopRecording``, ``GetStatus`` methods
    and ``AudioLevel``, ``Error``, ``StateChanged`` signals.

    Signals are emitted by calling the ``@signal()`` method directly —
    e.g. ``self.StateChanged()`` — which dbus-next's decorator rewrites
    to call ``_handle_signal`` with the return value.
    """

    def __init__(self, engine: RecordingEngine | None = None):
        """Initialize the D-Bus service interface."""
        super().__init__("com.happytomatoe.VoiceToText")
        self._engine = engine or RecordingEngine()
        self._state = "idle"
        self._last_level: float = 0.0
        self._last_error: str = ""
        self._tasks: set[asyncio.Task] = set()
        self._connect_engine_signals()
        self._bus: MessageBus | None = None

    def _spawn(self, coro: Coroutine[Any, Any, None]) -> None:
        loop = asyncio.get_running_loop()
        task = loop.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def set_bus(self, bus: MessageBus) -> None:
        """Set the D-Bus message bus reference."""
        self._bus = bus

    def _connect_engine_signals(self):
        """Wire up engine callbacks to D-Bus signal emission."""

        def _on_level(level: float):
            self._last_level = level
            self.AudioLevel()  # calls @signal() method → emits via dbus-next

        def _on_error(msg: str):
            self._last_error = msg
            self.Error()

        def _on_state(state: EngineState):
            self._state = state.value
            self.StateChanged()

        self._engine.on_audio_level = _on_level
        self._engine.on_error = _on_error
        self._engine.on_state_change = _on_state

    # ── Methods ──────────────────────────────────────────────────────────

    @method()
    def StartRecording(self, config: "s") -> None:  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Start recording with JSON config string.

        Config keys:
          provider (str): transcription provider
          language (str): language code
          mode (str): "batch", "hybrid", or "streaming"
          streaming_provider (str): for hybrid/streaming modes
          batch_provider (str): for hybrid mode
          device (str|None): sounddevice device name (e.g. "pipewire"),
            or "__system_default__"/None to let PortAudio choose
          decrease_speaker_volume (int): 0-100
          output_method (str): "type", "mutter-virtual", or "mutter-commit"
        """
        if self._engine.state != EngineState.IDLE:
            raise DBusError(
                "com.happytomatoe.VoiceToText.Error.AlreadyRecording",
                f"Cannot start: engine is {self._engine.state.value}",
            )
        try:
            parsed_config = json.loads(config)
        except json.JSONDecodeError as err:
            raise DBusError(
                "com.happytomatoe.VoiceToText.Error.InvalidConfig",
                f"Invalid JSON config: {err}",
            ) from err
        if not isinstance(parsed_config, dict):
            raise DBusError(
                "com.happytomatoe.VoiceToText.Error.InvalidConfig",
                f"Expected JSON object, got {type(parsed_config).__name__}",
            )
        logger.info("D-Bus StartRecording received config: %s", parsed_config)
        self._spawn(self._engine.start(parsed_config))

    @method()
    def StopRecording(self) -> None:  # noqa: N802
        """Stop the current recording session."""
        self._spawn(self._engine.stop())

    @method()
    def CancelRecording(self) -> None:  # noqa: N802
        """Cancel recording and discard output."""
        self._spawn(self._engine.cancel())

    @method()
    def OpenPrefs(self) -> None:  # noqa: N802
        """Ask the shell extension to open its preferences dialog.

        The extension runs inside gnome-shell, so its openPreferences() path
        is immune to the D-Bus-activation environment problems that break the
        gnome-extensions CLI in headless CI sessions.
        """
        logger.info("D-Bus OpenPrefs received")
        self.OpenPrefsRequested()

    @method()
    def GetStatus(self) -> "s":  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Return current state: idle/recording/processing."""
        return self._state

    @method()
    def ListInputDevices(self) -> "a(ss)":  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Return available input devices as (id, label) pairs.

        Delegates to :func:`list_input_devices`; the first entry is the
        "__system_default__" id, which routes capture through PipeWire when
        no device is explicitly chosen (so GNOME's mic/privacy indicator
        appears).
        """
        return list_input_devices()

    # ── Signals ──────────────────────────────────────────────────────────

    @signal()
    def AudioLevel(self) -> "d":  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Emit current audio level during recording (0.0-1.0)."""
        return self._last_level

    @signal()
    def Error(self) -> "s":  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Emit error during recording or transcription."""
        return self._last_error

    @signal()
    def StateChanged(self) -> "s":  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Emit state change (idle/recording/processing)."""
        return self._state

    @signal()
    def OpenPrefsRequested(self) -> "s":  # noqa: N802, F821  # pyright: ignore[reportUndefinedVariable]
        """Signal the extension to open its preferences dialog."""
        return "prefs"
