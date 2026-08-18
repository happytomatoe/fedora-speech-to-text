"""Parakeet HTTP transcription provider (local, no cloud).

Project docs: docs/providers/parakeet.md
"""

import logging
import os
from typing import Any

from .base import BatchProvider, get_shared_client

logger = logging.getLogger(__name__)


class ParakeetProvider(BatchProvider):
    """Parakeet transcription provider (HTTP mode only).

    Uses ``httpx.AsyncClient`` (replaces ``requests``).
    """

    def __init__(self, config: dict[str, Any]):
        """Initialize the Parakeet provider."""
        self.model_name = config.get("model", "nvidia/parakeet-tdt-0.6b-v3")
        self.http_endpoint = config.get("http_endpoint", "http://localhost:5092")
        self.timeout = config.get("timeout", 120.0)
        self._client = get_shared_client()
        # Load custom words from file if specified
        self._file_custom_words = self._load_custom_words_file(config.get("custom_words_file"))
        logger.info("Using Parakeet HTTP mode: %s (timeout=%.1fs)", self.http_endpoint, self.timeout)

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file using Parakeet HTTP API."""
        logger.info("Transcribing %s via HTTP", audio_path)
        url = f"{self.http_endpoint}/v1/audio/transcriptions"
        # Merge file words with passed-in words
        all_words = self._file_custom_words + (custom_words or [])
        with open(audio_path, "rb") as f:
            files = {"file": (os.path.basename(audio_path), f, "audio/wav")}
            data = {"model": self.model_name}
            if all_words:
                data["initial_prompt"] = ", ".join(all_words)
            response = await self._client.post(url, files=files, data=data, timeout=self.timeout)
        response.raise_for_status()
        result = response.json().get("text", "").strip()
        logger.info("Transcription result: %s", result[:100])
        return result

    @staticmethod
    def _load_custom_words_file(file_path: str | None) -> list[str]:
        """Load custom words from a text file (one word per line)."""
        if not file_path:
            return []
        try:
            with open(file_path) as f:
                words = [line.strip() for line in f if line.strip() and not line.startswith("#")]
            logger.info("Loaded %d custom words from %s", len(words), file_path)
            return words
        except FileNotFoundError:
            logger.warning("Custom words file not found: %s", file_path)
            return []
        except Exception:
            logger.warning("Failed to load custom words from %s", file_path, exc_info=True)
            return []

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "parakeet"

    async def close(self) -> None:
        """No persistent resources to close."""
        pass
