"""Tests for transcription providers."""

import os

import pytest

from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.providers.base import resolve_api_key
from voice_to_text.providers.elevenlabs import ElevenLabsProvider
from voice_to_text.providers.groq import GroqProvider
from voice_to_text.providers.sixty import SixtyProvider


class TestProviderFactory:
    def test_get_groq_provider(self):
        config = {"api_key": "test_key", "model": "whisper-large-v3-turbo"}
        provider = get_batch_provider("groq", config)
        assert isinstance(provider, GroqProvider)
        assert provider.name == "groq"

    def test_invalid_provider(self):
        with pytest.raises(ValueError, match="invalid"):
            get_batch_provider("invalid", {})


class TestGroqProvider:
    def test_initialization(self):
        config = {"api_key": "test_key"}
        provider = GroqProvider(config)
        assert provider.model == "whisper-large-v3-turbo"

    def test_missing_api_key(self):
        old_key = os.environ.pop("GROQ_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="API key"):
                GroqProvider({})
        finally:
            if old_key is not None:
                os.environ["GROQ_API_KEY"] = old_key


class TestSixtyProvider:
    def test_get_sixty_provider(self):
        config = {"api_key": "test_key"}
        provider = get_batch_provider("60db", config)
        assert isinstance(provider, SixtyProvider)
        assert provider.name == "60db"

    def test_get_streaming_provider(self):
        config = {"api_key": "test_key"}
        provider = get_streaming_provider("60db", config)
        assert isinstance(provider, SixtyProvider)
        assert provider.name == "60db"

    def test_initialization(self):
        config = {"api_key": "test_key"}
        provider = SixtyProvider(config)
        assert provider.model == "60db-stt-v01"
        assert provider.api_url == "https://api.60db.ai"

    def test_missing_api_key(self):
        import os

        old_key = os.environ.pop("SIXTYDB_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="API key"):
                SixtyProvider({"api_key_source": "env"})
        finally:
            if old_key is not None:
                os.environ["SIXTYDB_API_KEY"] = old_key


class TestElevenLabsProvider:
    def test_initialization(self):
        config = {"api_key": "test_key"}
        provider = ElevenLabsProvider(config)
        assert provider.model == "scribe_v2"
        assert provider.api_url == "https://api.elevenlabs.io"
        assert provider.tag_audio_events is False

    def test_missing_api_key(self):
        old_key = os.environ.pop("ELEVENLABS_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="API key"):
                ElevenLabsProvider({"api_key_source": "env"})
        finally:
            if old_key is not None:
                os.environ["ELEVENLABS_API_KEY"] = old_key


class TestResolveApiKeyCommandSubstitution:
    def test_command_substitution_success(self):
        config = {"api_key": "!echo test-key-123"}
        key = resolve_api_key(config, "DUMMY_ENV", provider_name="test")
        assert key == "test-key-123"

    def test_command_substitution_failure(self):
        config = {"api_key": "!false"}
        with pytest.raises(ValueError, match="API key command failed"):
            resolve_api_key(config, "DUMMY_ENV", provider_name="test")

    def test_command_substitution_empty_output(self):
        config = {"api_key": "!printf ''"}
        with pytest.raises(ValueError, match="empty output"):
            resolve_api_key(config, "DUMMY_ENV", provider_name="test")

    def test_command_substitution_timeout(self):
        from voice_to_text.providers.base import _execute_command_for_key

        with pytest.raises(ValueError, match="timed out"):
            _execute_command_for_key("sleep 20", timeout=1)

    def test_env_var_priority_over_command(self, monkeypatch):
        config = {"api_key": "!echo from-command", "api_key_env": "TEST_API_KEY"}
        monkeypatch.setenv("TEST_API_KEY", "from-env")
        key = resolve_api_key(config, "TEST_API_KEY", provider_name="test")
        assert key == "from-env"

    def test_command_shell_supports_pipes(self):
        config = {"api_key": "!echo 'hello world' | tr ' ' '-'"}
        key = resolve_api_key(config, "DUMMY_ENV", provider_name="test")
        assert key == "hello-world"
