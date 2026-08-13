"""Tests for API key resolution."""

import os
from unittest.mock import patch

import pytest

from voice_to_text.providers.base import resolve_api_key


class TestResolveApiKey:
    """Tests for resolve_api_key function."""

    def test_env_var_default(self):
        """Default behavior: resolve from environment variable."""
        with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "env-key"}):
            result = resolve_api_key({}, "DEEPGRAM_API_KEY")
            assert result == "env-key"

    def test_env_var_configured(self):
        """Resolve from custom env var name via config."""
        with patch.dict(os.environ, {"CUSTOM_KEY": "custom-key"}):
            result = resolve_api_key({"api_key_env": "CUSTOM_KEY"}, "DEEPGRAM_API_KEY")
            assert result == "custom-key"

    def test_env_var_extra(self):
        """Resolve from extra env vars."""
        with patch.dict(os.environ, {"MISTRAL_API_KEY": "mistral-key"}, clear=True):
            result = resolve_api_key({}, "VOXTRAL_API_KEY", extra_envs=("MISTRAL_API_KEY",))
            assert result == "mistral-key"

    def test_config_fallback(self):
        """Fall back to config file when no env var."""
        with patch.dict(os.environ, {}, clear=True):
            result = resolve_api_key({"api_key": "config-key"}, "DEEPGRAM_API_KEY")
            assert result == "config-key"

    def test_raises_when_missing(self):
        """Raise ValueError when no key found anywhere."""
        with patch.dict(os.environ, {}, clear=True), pytest.raises(ValueError, match="No API key found"):
            resolve_api_key({}, "NONEXISTENT_KEY")

    def test_env_var_takes_precedence_over_config(self):
        """Env var takes precedence over config file."""
        with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "env-key"}):
            result = resolve_api_key({"api_key": "config-key"}, "DEEPGRAM_API_KEY")
            assert result == "env-key"
