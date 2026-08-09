"""Tests for Moonshine transcription provider."""

import pytest

from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.providers.moonshine import MoonshineProvider


class TestMoonshineProviderFactory:
    """Test factory registration."""

    def test_get_batch_provider(self):
        provider = get_batch_provider("moonshine", {})
        assert isinstance(provider, MoonshineProvider)
        assert provider.name == "moonshine"

    def test_get_streaming_provider(self):
        provider = get_streaming_provider("moonshine", {})
        assert isinstance(provider, MoonshineProvider)
        assert provider.name == "moonshine"


class TestMoonshineProviderInit:
    """Test provider initialization."""

    def test_default_config(self):
        provider = MoonshineProvider({})
        assert provider.model_name == "medium"
        assert provider.language == "en"
        assert provider.name == "moonshine"

    def test_custom_config(self):
        config = {"model": "small", "language": "es"}
        provider = MoonshineProvider(config)
        assert provider.model_name == "small"
        assert provider.language == "es"

    def test_model_not_loaded_initially(self):
        provider = MoonshineProvider({})
        assert provider._transcriber is None
        assert provider._moonshine is None


class TestMoonshineProviderStreaming:
    """Test streaming interface."""

    def test_finalize_without_start(self):
        """finalize_stream should return empty string when no stream was started."""
        import asyncio

        provider = MoonshineProvider({})
        result = asyncio.run(provider.finalize_stream())
        assert result == ""

    def test_get_partial_result_without_start(self):
        """get_partial_result should return None when no stream was started."""
        import asyncio

        provider = MoonshineProvider({})
        result = asyncio.run(provider.get_partial_result())
        assert result is None

    def test_send_audio_without_start_raises(self):
        """send_audio should raise RuntimeError if stream not started."""
        import asyncio

        provider = MoonshineProvider({})
        with pytest.raises(RuntimeError, match="Stream not started"):
            asyncio.run(provider.send_audio(b"\x00" * 1024))


class TestMoonshineProviderClose:
    """Test cleanup."""

    def test_close_without_model(self):
        """close should not raise when no model loaded."""
        import asyncio

        provider = MoonshineProvider({})
        asyncio.run(provider.close())
        assert provider._transcriber is None

    def test_implements_batch_provider(self):
        """MoonshineProvider should implement BatchProvider interface."""
        from voice_to_text.providers.base import BatchProvider

        provider = MoonshineProvider({})
        assert isinstance(provider, BatchProvider)

    def test_implements_streaming_provider(self):
        """MoonshineProvider should implement StreamingProvider interface."""
        from voice_to_text.providers.base import StreamingProvider

        provider = MoonshineProvider({})
        assert isinstance(provider, StreamingProvider)
