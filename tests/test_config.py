"""Tests for configuration management."""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from voice_to_text.config import ConfigManager
from voice_to_text.providers import get_batch_provider


@pytest.fixture
def groq_config():
    config_content = """
transcription:
  provider: groq
groq:
  api_key_env: GROQ_API_KEY
  model: whisper-large-v3-turbo
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(config_content)
        config_path = f.name
    yield config_path
    os.unlink(config_path)


def test_config_management(groq_config):
    config_mgr = ConfigManager(groq_config)
    provider = config_mgr.get_selected_provider()
    assert provider == "groq"

    provider_config = config_mgr.get_provider_config(provider)
    assert "api_key_env" in provider_config


def test_provider_instantiation(groq_config):
    config_mgr = ConfigManager(groq_config)
    provider_name = config_mgr.get_selected_provider()
    provider_config = config_mgr.get_provider_config(provider_name)

    try:
        provider = get_batch_provider(provider_name, provider_config)
        assert provider.name == provider_name
    except ValueError as e:
        assert "GROQ_API_KEY" in str(e)  # noqa: PT017 — testing error message content


def test_speaker_config_defaults(groq_config):
    config_mgr = ConfigManager(groq_config)
    speaker_config = config_mgr.get_speaker_config()
    assert speaker_config == {}


def test_speaker_config_with_values():
    config_content = """
audio:
  speaker:
    decrease_volume: 50
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(config_content)
        config_path = f.name

    try:
        config_mgr = ConfigManager(config_path)
        speaker_config = config_mgr.get_speaker_config()
        assert speaker_config.get("decrease_volume") == 50
    finally:
        os.unlink(config_path)


class TestSaveErrorHandling:
    """Issue #5: save() must return False (not raise) on directory-creation failure."""

    def test_save_returns_false_when_mkdir_fails(self, tmp_path):
        # Pick a non-existent target (so __init__'s _load_config() returns
        # an empty dict via the FileNotFoundError branch) and then make mkdir
        # fail at save-time.
        target = tmp_path / "subdir" / "config.yaml"
        cfg = ConfigManager(config_path=str(target))
        cfg.config = {"transcription": {"provider": "groq"}}

        with patch.object(Path, "mkdir", side_effect=PermissionError("nope")):
            assert cfg.save() is False
        # And the target must not have been created
        assert not target.exists()

    def test_save_returns_false_when_target_is_unwritable(self, tmp_path):
        cfg = ConfigManager(config_path=str(tmp_path / "config.yaml"))
        cfg.config = {"transcription": {"provider": "groq"}}

        # Make write() raise; mkdir should already have succeeded.
        with patch("builtins.open", side_effect=PermissionError("nope")):
            assert cfg.save() is False


class TestSaveMigration:
    """Issue #4: save() must not write to an auto-discovered non-user path."""

    def test_save_redirects_auto_discovered_non_user_path_to_user_config(self, tmp_path, monkeypatch):
        # The repo's config.yaml is auto-discovered as the first existing
        # default path; save() must redirect writes to the user config and
        # leave the repo file untouched.
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        user_config = tmp_path / ".config" / "voice-to-text" / "config.yaml"
        repo_config = Path(__file__).resolve().parent.parent / "config.yaml"
        repo_contents_before = repo_config.read_text() if repo_config.exists() else None

        cfg = ConfigManager()
        # The constructor picked up the repo's config (which is not user_config_path)
        assert cfg._explicit_config_path is False
        assert Path(cfg.config_path).resolve() != user_config.resolve()

        cfg.config = {"transcription": {"provider": "groq"}}
        assert cfg.save() is True

        # config_path was redirected to the user config
        assert cfg.config_path == str(user_config)
        assert "provider: groq" in user_config.read_text()
        # And the repo file was not modified
        if repo_contents_before is not None:
            assert repo_config.read_text() == repo_contents_before

    def test_save_writes_to_explicit_path_even_if_not_user_path(self, tmp_path):
        # Explicit path: should be respected, not migrated to user_config_path,
        # even if it happens to live under /tmp/ (e.g. a test fixture).
        explicit = tmp_path / "explicit-config.yaml"
        cfg = ConfigManager(config_path=str(explicit))
        cfg.config = {"transcription": {"provider": "groq"}}
        assert cfg.save() is True
        assert explicit.exists()
        assert "groq" in explicit.read_text()
        # And config_path still points at the explicit file
        assert cfg.config_path == str(explicit)
