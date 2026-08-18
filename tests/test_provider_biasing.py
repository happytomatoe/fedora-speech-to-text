"""Tests for provider-side terminology biasing (custom_words -> provider API params)."""

from __future__ import annotations

import struct
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from voice_to_text.providers.deepgram import DeepgramProvider
from voice_to_text.providers.elevenlabs import ElevenLabsProvider
from voice_to_text.providers.groq import GroqProvider
from voice_to_text.providers.parakeet import ParakeetProvider
from voice_to_text.providers.sixty import SixtyProvider
from voice_to_text.providers.voxtral import VoxtralProvider

# -- Helpers -------------------------------------------------------------------


def _make_wav(tmp_path: Path) -> Path:
    """Create a minimal WAV file for testing."""
    wav = tmp_path / "test.wav"
    with open(wav, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", 16))
        f.write(struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", 0))
    return wav


# -- Deepgram ------------------------------------------------------------------


class TestDeepgramBiasing:
    """Verify that custom_words are sent as keyterm query params."""

    @pytest.mark.asyncio
    async def test_sends_keyterm_params(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = DeepgramProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["params"] = kwargs.get("params", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"results": {"channels": [{"alternatives": [{"transcript": "hello"}]}]}}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["Kubernetes", "D-Bus"])

        assert result == "hello"
        assert captured["params"]["keyterm"] == ["Kubernetes", "D-Bus"]

    @pytest.mark.asyncio
    async def test_no_keyterm_when_empty(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = DeepgramProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["params"] = kwargs.get("params", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"results": {"channels": [{"alternatives": [{"transcript": "hello"}]}]}}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        await provider.transcribe_file(str(wav))

        assert "keyterm" not in captured["params"]


# -- Voxtral -------------------------------------------------------------------


class TestVoxtralBiasing:
    """Verify that custom_words are sent as context_bias form fields."""

    @pytest.mark.asyncio
    async def test_sends_context_bias(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = VoxtralProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["Prometheus", "Grafana"])

        assert result == "hello"
        assert captured["data"]["context_bias"] == ["Prometheus", "Grafana"]

    @pytest.mark.asyncio
    async def test_no_context_bias_when_empty(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = VoxtralProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        await provider.transcribe_file(str(wav))

        assert "context_bias" not in captured["data"]


# -- Groq ----------------------------------------------------------------------


class TestGroqBiasing:
    """Verify that custom_words are sent as a comma-joined prompt string."""

    @pytest.mark.asyncio
    async def test_sends_prompt(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = GroqProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_create(**kwargs: object) -> str:
            captured.update(kwargs)
            return "hello"

        provider.client.audio.transcriptions.create = _fake_create  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["systemd", "D-Bus", "Wayland"])

        assert result == "hello"
        assert captured["prompt"] == "systemd, D-Bus, Wayland"

    @pytest.mark.asyncio
    async def test_no_prompt_when_empty(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = GroqProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_create(**kwargs: object) -> str:
            captured.update(kwargs)
            return "hello"

        provider.client.audio.transcriptions.create = _fake_create  # type: ignore[assignment]

        await provider.transcribe_file(str(wav))

        assert "prompt" not in captured


# -- ElevenLabs ----------------------------------------------------------------


class TestElevenLabsBiasing:
    """Verify that custom_words are sent as a comma-joined keyterms field."""

    @pytest.mark.asyncio
    async def test_sends_keyterms(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = ElevenLabsProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["ChatGPT", "OpenAI"])

        assert result == "hello"
        assert captured["data"]["keyterms"] == ["ChatGPT", "OpenAI"]

    @pytest.mark.asyncio
    async def test_no_keyterms_when_empty(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = ElevenLabsProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        await provider.transcribe_file(str(wav))

        assert "keyterms" not in captured["data"]


# -- 60db ----------------------------------------------------------------------


class TestSixtyBiasing:
    """Verify that custom_words are sent as a comma-joined context field."""

    @pytest.mark.asyncio
    async def test_sends_context(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = SixtyProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"data": {"text": "hello"}}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["Rust", "Cargo"])

        assert result == "hello"
        assert captured["data"]["context"] == "Rust, Cargo"

    @pytest.mark.asyncio
    async def test_no_context_when_empty(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = SixtyProvider({"api_key": "test-key"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"data": {"text": "hello"}}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        await provider.transcribe_file(str(wav))

        assert "context" not in captured["data"]


# -- Parakeet ------------------------------------------------------------------


class TestParakeetBiasing:
    """Verify that custom_words are sent as initial_prompt form field."""

    @pytest.mark.asyncio
    async def test_sends_initial_prompt(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = ParakeetProvider({"http_endpoint": "http://localhost:5092"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["Kubernetes", "Docker"])

        assert result == "hello"
        assert captured["data"]["initial_prompt"] == "Kubernetes, Docker"

    @pytest.mark.asyncio
    async def test_no_initial_prompt_when_empty(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        provider = ParakeetProvider({"http_endpoint": "http://localhost:5092"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        await provider.transcribe_file(str(wav))

        assert "initial_prompt" not in captured["data"]

    @pytest.mark.asyncio
    async def test_file_words_merge_with_inline(self, tmp_path: Path) -> None:
        wav = _make_wav(tmp_path)
        words_file = tmp_path / "words.txt"
        words_file.write_text("Prometheus\nGrafana\n")

        provider = ParakeetProvider(
            {
                "http_endpoint": "http://localhost:5092",
                "custom_words_file": str(words_file),
            }
        )

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["data"] = kwargs.get("data", {})
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            resp.json.return_value = {"text": "hello"}
            return resp

        provider._client.post = _fake_post  # type: ignore[assignment]

        result = await provider.transcribe_file(str(wav), custom_words=["Argus"])

        assert result == "hello"
        # File words come first, then inline words
        assert captured["data"]["initial_prompt"] == "Prometheus, Grafana, Argus"
