"""Configuration management for groq-voice."""

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


class ConfigManager:
    """Manage application configuration with provider support."""

    def __init__(self, config_path: str | None = None):
        """Initialize the configuration manager."""
        self._explicit_config_path = bool(config_path)
        # User config path (persistent)
        self.user_config_path = str(Path.home() / ".config" / "voice-to-text" / "config.yaml")

        # Look for config in multiple locations
        default_paths = [
            self.user_config_path,  # User config (persistent)
            str(Path(__file__).parent.parent / "config.yaml"),  # Development
            str(Path(__file__).parent / "config.yaml"),  # Alternative dev location
            str(Path(__file__).parent.parent.parent / "config.yaml"),  # Root project
        ]

        # Use provided path or find first existing one
        if config_path:
            self.config_path = config_path
        else:
            for path in default_paths:
                if Path(path).exists():
                    self.config_path = path
                    break
            else:
                self.config_path = self.user_config_path

        self.config = self._load_config()

    def _load_config(self) -> dict[str, Any]:
        """Load configuration from file."""
        try:
            with open(self.config_path) as f:
                return yaml.safe_load(f) or {}
        except FileNotFoundError:
            logger.warning("Config file not found: %s", self.config_path)
            return {}
        except yaml.YAMLError as e:
            logger.error("Failed to parse config: %s", e)
            return {}

    def save(self) -> bool:
        """Save config to a persistent location.

        If the path was auto-discovered (i.e. not explicitly provided) and is
        not the user config dir, redirect writes to the user config path so we
        never overwrite a bundled/dev config. An explicitly provided path is
        always respected.
        """
        target = self.config_path
        if not self._explicit_config_path and target != self.user_config_path:
            target = self.user_config_path
            self.config_path = target
        try:
            Path(target).parent.mkdir(parents=True, exist_ok=True)
            with open(target, "w") as f:
                yaml.dump(self.config, f)
            return True
        except Exception:
            logger.exception("Failed to save config: %s", target)
            return False

    def get_provider_config(self, provider_name: str) -> dict[str, Any]:
        """Get configuration for specific provider."""
        provider_config = self.config.get(provider_name, {})

        # Merge with global transcription settings
        transcription_config = self.config.get("transcription", {})

        # Provider-specific config takes precedence
        merged = transcription_config.copy()
        merged.update(provider_config)

        return merged

    def _section(self, name: str) -> dict[str, Any]:
        """Return a top-level config section, or an empty dict if absent."""
        section = self.config.get(name)
        return section if isinstance(section, dict) else {}

    def get_selected_provider(self) -> str:
        """Get the selected transcription provider."""
        provider = self._section("transcription").get("provider")
        return provider if isinstance(provider, str) and provider else "voxtral"

    def get_audio_config(self) -> dict[str, Any]:
        """Get audio configuration."""
        return self._section("audio")

    def get_speaker_config(self) -> dict[str, Any]:
        """Get speaker volume configuration."""
        audio_cfg = self.config.get("audio") or {}
        if not isinstance(audio_cfg, dict):
            return {}
        speaker_cfg = audio_cfg.get("speaker") or {}
        return speaker_cfg if isinstance(speaker_cfg, dict) else {}
