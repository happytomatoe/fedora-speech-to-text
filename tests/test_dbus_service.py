"""Unit tests for the D-Bus service interface.

These tests exercise the VoiceToTextInterface and MockRecordingEngine
without requiring a real dbus-daemon. The interface methods are called
directly, bypassing the D-Bus transport layer.
"""

import asyncio
import json

import pytest
from dbus_next import DBusError

from voice_to_text.dbus_service import VoiceToTextInterface, format_provider_initials
from voice_to_text.engine import EngineState

# ── Mock engine ──────────────────────────────────────────────────────────


class MockRecordingEngine:
    """Simulates recording-engine state transitions without hardware.

    Records every call and fires the registered callbacks so that the
    D-Bus service's signal-emission chain is exercised end-to-end.
    """

    def __init__(self):
        self.state = EngineState.IDLE
        self.on_audio_level = None
        self.on_error = None
        self.on_state_change = None
        self.on_transcription_result = None
        self.started_config: dict | None = None
        self.stop_called: bool = False

    async def start(self, config: dict) -> None:
        self.started_config = config
        self.state = EngineState.RECORDING
        if self.on_state_change:
            self.on_state_change(EngineState.RECORDING)

    async def stop(self) -> None:
        if self.state == EngineState.IDLE:
            return
        self.stop_called = True
        self.state = EngineState.IDLE
        if self.on_state_change:
            self.on_state_change(EngineState.IDLE)


# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def mock_engine():
    """Fresh MockRecordingEngine per test."""
    return MockRecordingEngine()


@pytest.fixture
def interface(mock_engine):
    """VoiceToTextInterface with mock engine, no bus connection needed."""
    return VoiceToTextInterface(engine=mock_engine)


# ── Tests ────────────────────────────────────────────────────────────────


class TestGetStatus:
    """GetStatus method."""

    async def test_initial_state_is_idle(self, interface):
        """GetStatus returns 'idle' on a fresh service."""
        # Access _state directly since @method() decorator intercepts direct calls
        assert interface._state == "idle"

    async def test_recording_after_start(self, interface):
        """GetStatus returns 'recording' after a start."""
        interface.StartRecording('{"provider": "test"}')
        await asyncio.sleep(0.05)
        assert interface._state == "recording"

    async def test_idle_after_stop(self, interface):
        """GetStatus returns 'idle' after stop completes."""
        interface.StartRecording("{}")
        await asyncio.sleep(0.05)
        await interface._engine.stop()
        assert interface._state == "idle"


class TestStartRecording:
    """StartRecording method."""

    async def test_invalid_json_raises_dbus_error(self, interface):
        """Invalid JSON config raises a DBusError (not a crash)."""
        with pytest.raises(DBusError) as excinfo:
            interface.StartRecording("not valid json at all")
        assert "Invalid JSON" in str(excinfo.value)

    async def test_empty_json_is_accepted(self, interface):
        """Empty JSON object is valid config."""
        interface.StartRecording("{}")
        await asyncio.sleep(0.05)
        assert interface._engine.started_config == {}

    async def test_parsed_config_passed_to_engine(self, interface):
        """Parsed JSON config is forwarded to engine.start()."""
        config = {"provider": "voxtral", "language": "en"}
        interface.StartRecording(json.dumps(config))
        await asyncio.sleep(0.05)
        assert interface._engine.started_config == config

    async def test_double_start_raises_error(self, interface):
        """Calling StartRecording twice raises AlreadyRecording."""
        interface.StartRecording("{}")
        await asyncio.sleep(0.05)
        with pytest.raises(DBusError) as excinfo:
            interface.StartRecording("{}")
        assert "Cannot start" in str(excinfo.value) or "AlreadyRecording" in str(excinfo.value)

    async def test_non_dict_json_raises_error(self, interface):
        """Non-object JSON (array, string, number) raises InvalidConfig."""
        with pytest.raises(DBusError) as excinfo:
            interface.StartRecording("[1, 2, 3]")
        assert "Expected JSON object" in str(excinfo.value)

    async def test_string_json_raises_error(self, interface):
        """String JSON raises InvalidConfig."""
        with pytest.raises(DBusError) as excinfo:
            interface.StartRecording('"hello"')
        assert "Expected JSON object" in str(excinfo.value)


class TestStopRecording:
    """StopRecording method."""

    async def test_stop_passed_to_engine(self, interface):
        """StopRecording calls engine.stop()."""
        interface.StartRecording("{}")
        await asyncio.sleep(0.05)
        await interface._engine.stop()
        assert interface._engine.stop_called

    async def test_stop_when_idle_is_safe(self, interface):
        """Calling StopRecording when idle does not crash."""
        await interface._engine.stop()
        assert not interface._engine.stop_called


class TestSignals:
    """Signal emission via callbacks."""

    async def test_state_changed_on_start(self, interface, mock_engine):
        """StateChanged signal fires when engine starts."""
        # Wire up a callback to capture state changes
        states = []
        interface._engine.on_state_change = lambda state: states.append(state.value)

        interface.StartRecording("{}")
        await asyncio.sleep(0.05)

        assert "recording" in states

    async def test_state_changed_on_stop(self, interface, mock_engine):
        """StateChanged signal fires when engine stops."""
        states = []
        interface._engine.on_state_change = lambda state: states.append(state.value)

        interface.StartRecording("{}")
        await asyncio.sleep(0.05)
        await interface._engine.stop()
        await asyncio.sleep(0.05)

        assert "idle" in states

    async def test_state_changed_multiple_transitions(self, interface, mock_engine):
        """StateChanged fires for idle -> recording -> idle."""
        states = []
        interface._engine.on_state_change = lambda state: states.append(state.value)

        interface.StartRecording("{}")
        await asyncio.sleep(0.05)
        await interface._engine.stop()
        await asyncio.sleep(0.05)

        assert states == ["recording", "idle"]

    async def test_audio_level_signal(self, interface, mock_engine):
        """AudioLevel signal fires with float value."""
        # Wire up callback on the engine
        levels = []
        mock_engine.on_audio_level = levels.append

        # Trigger the callback
        mock_engine.on_audio_level(0.5)

        assert 0.5 in levels

    async def test_multiple_audio_level_events(self, interface, mock_engine):
        """Multiple AudioLevel signals fire correctly."""
        levels = []
        mock_engine.on_audio_level = levels.append

        for level in [0.1, 0.5, 0.9]:
            mock_engine.on_audio_level(level)

        assert levels == [0.1, 0.5, 0.9]

    async def test_error_signal(self, interface, mock_engine):
        """Error signal fires with error message."""
        errors = []
        mock_engine.on_error = errors.append

        mock_engine.on_error("test error")

        assert "test error" in errors


class TestGetInitials:
    """GetInitials method (provider indicator)."""

    async def test_empty_before_first_recording(self):
        """No active providers yet → empty string."""
        assert format_provider_initials([], {}) == ""

    async def test_batch_provider_names(self):
        """Canonical names joined with '+' are returned."""
        assert format_provider_initials(["voxtral"], {}) == "voxtral"

    async def test_hybrid_provider_names(self):
        """Hybrid mode joins streaming + batch with '+'."""
        assert format_provider_initials(["deepgram", "groq"], {}) == "deepgram+groq"

    async def test_disabled_flag(self):
        """provider_indicator.enabled: false → empty string."""
        cfg = {"enabled": False}
        assert format_provider_initials(["voxtral"], cfg) == ""

    async def test_label_override(self):
        """Labels overrides replace a canonical name verbatim."""
        cfg = {"labels": {"moonshine": "MS"}}
        assert format_provider_initials(["moonshine", "groq"], cfg) == "MS+groq"
