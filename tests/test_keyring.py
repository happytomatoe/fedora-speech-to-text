"""Tests for API key resolution."""

import os
from types import SimpleNamespace
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


class TestKeyringFallback:
    """Tests for the OS keyring fallback."""

    def test_keyring_fallback(self):
        """Read the key from secret-tool when env and config are empty."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("voice_to_text.providers.base.shutil.which", return_value="/usr/bin/secret-tool"),
            patch(
                "voice_to_text.providers.base.subprocess.run",
                return_value=SimpleNamespace(stdout="keyring-key\n", returncode=0),
            ) as run,
        ):
            result = resolve_api_key({}, "DEEPGRAM_API_KEY", provider_name="deepgram")

        assert result == "keyring-key"
        assert run.call_args.args[0] == [
            "secret-tool",
            "lookup",
            "service",
            "voice-to-text",
            "username",
            "deepgram",
        ]

    def test_keyring_ignored_without_provider_name(self):
        """Do not consult the keyring when the caller gives no provider name."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("voice_to_text.providers.base.shutil.which", return_value="/usr/bin/secret-tool"),
            patch("voice_to_text.providers.base.subprocess.run") as run,
            pytest.raises(ValueError, match="No API key found"),
        ):
            resolve_api_key({}, "DEEPGRAM_API_KEY")

        run.assert_not_called()

    def test_env_var_takes_precedence_over_keyring(self):
        """Env var wins over the keyring, so secret-tool is not called."""
        with (
            patch.dict(os.environ, {"DEEPGRAM_API_KEY": "env-key"}),
            patch("voice_to_text.providers.base.shutil.which", return_value="/usr/bin/secret-tool"),
            patch("voice_to_text.providers.base.subprocess.run") as run,
        ):
            result = resolve_api_key({}, "DEEPGRAM_API_KEY", provider_name="deepgram")

        assert result == "env-key"
        run.assert_not_called()

    def test_missing_secret_tool_raises(self):
        """Skip the keyring when secret-tool is not installed."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("voice_to_text.providers.base.shutil.which", return_value=None),
            patch("voice_to_text.providers.base.subprocess.run") as run,
            pytest.raises(ValueError, match="No API key found"),
        ):
            resolve_api_key({}, "DEEPGRAM_API_KEY", provider_name="deepgram")

        run.assert_not_called()

    def test_empty_keyring_value_raises(self):
        """An empty secret-tool result counts as no key."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("voice_to_text.providers.base.shutil.which", return_value="/usr/bin/secret-tool"),
            patch(
                "voice_to_text.providers.base.subprocess.run",
                return_value=SimpleNamespace(stdout="\n", returncode=0),
            ),
            pytest.raises(ValueError, match="No API key found"),
        ):
            resolve_api_key({}, "DEEPGRAM_API_KEY", provider_name="deepgram")

    def test_config_takes_precedence_over_keyring(self):
        """A config api_key wins without consulting secret-tool."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("voice_to_text.providers.base.shutil.which", return_value="/usr/bin/secret-tool"),
            patch("voice_to_text.providers.base.subprocess.run") as run,
        ):
            result = resolve_api_key({"api_key": "config-key"}, "DEEPGRAM_API_KEY", provider_name="deepgram")

        assert result == "config-key"
        run.assert_not_called()

    def test_keyring_value_is_opaque(self):
        """A keyring value starting with ! is a key, not a shell command."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("voice_to_text.providers.base.shutil.which", return_value="/usr/bin/secret-tool"),
            patch(
                "voice_to_text.providers.base.subprocess.run",
                return_value=SimpleNamespace(stdout="!touch /tmp/keyring-pwned\n", returncode=0),
            ),
            patch("voice_to_text.providers.base._execute_command_for_key") as execute,
        ):
            result = resolve_api_key({}, "DEEPGRAM_API_KEY", provider_name="deepgram")

        assert result == "!touch /tmp/keyring-pwned"
        execute.assert_not_called()

    def test_config_command_substitution_still_runs(self):
        """Command substitution remains available for config.yaml keys."""
        with (
            patch.dict(os.environ, {}, clear=True),
            patch(
                "voice_to_text.providers.base._execute_command_for_key",
                return_value="from-command",
            ) as execute,
        ):
            result = resolve_api_key({"api_key": "!echo key"}, "DEEPGRAM_API_KEY")

        assert result == "from-command"
        execute.assert_called_once_with("echo key")


def test_keyring_block_keeps_other_which_lookups():
    """The hermetic fixture only hides secret-tool, not every executable."""
    import shutil

    assert shutil.which("secret-tool") is None
    assert shutil.which("sh")
