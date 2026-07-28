"""Tests for input-device selection (PipeWire preference) and device listing.

These back the fix for "the GNOME privacy/recording mic icon doesn't appear
when starting a recording". The recorder must route capture through the
`pipewire` ALSA PCM (which makes GNOME show the indicator) when no device is
explicitly chosen, and fall back to PortAudio's default only if `pipewire`
is unavailable.
"""

import asyncio
import os
import tempfile
from unittest.mock import MagicMock, patch

from voice_to_text.engine import AsyncAudioRecorder


def _start_with_mock(device, fail_first=False):
    """Start AsyncAudioRecorder with sd.InputStream mocked.

    Returns the list of ``device`` values passed to ``sd.InputStream`` across
    the candidate attempts.
    """
    captured = []
    calls = {"n": 0}

    def fake_input_stream(*args, **kwargs):
        captured.append(kwargs.get("device"))
        if fail_first:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("pipewire unavailable")
        return MagicMock()

    with patch("voice_to_text.engine.sd.InputStream", side_effect=fake_input_stream):
        rec = AsyncAudioRecorder(device=device, sample_rate=16000)
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        asyncio.run(rec.start(path))
        rec.stop()
        os.unlink(path)
    return captured


def test_default_device_prefers_pipewire():
    """With no device chosen, the recorder opens `pipewire` first."""
    devices = _start_with_mock(None)
    assert devices[0] == "pipewire"


def test_explicit_device_is_used_verbatim():
    """An explicitly selected device is used as-is (no silent fallback)."""
    devices = _start_with_mock("sysdefault")
    assert devices == ["sysdefault"]


def test_pipewire_failure_falls_back_to_default():
    """If `pipewire` can't be opened, fall back to PortAudio's default."""
    devices = _start_with_mock(None, fail_first=True)
    assert devices == ["pipewire", None]


def test_list_input_devices_exposes_pipewire(monkeypatch):
    """ListInputDevices surfaces pipewire plus a system-default entry."""
    from voice_to_text.dbus_service import list_input_devices

    fake_devices = [
        {"max_input_channels": 0, "name": "HDMI output"},
        {"max_input_channels": 2, "name": "pipewire"},
        {"max_input_channels": 2, "name": "sysdefault"},
    ]
    monkeypatch.setattr("voice_to_text.dbus_service.sd.query_devices", lambda: fake_devices)
    monkeypatch.setattr("voice_to_text.dbus_service.sd.check_input_settings", lambda **_: True)

    result = list_input_devices()
    ids = [entry[0] for entry in result]

    assert "__system_default__" in ids
    assert "pipewire" in ids
    assert "sysdefault" in ids
    # The system-default sentinel must come first.
    assert ids[0] == "__system_default__"
