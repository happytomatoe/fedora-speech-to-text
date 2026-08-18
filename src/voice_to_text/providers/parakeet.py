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
        logger.info("Using Parakeet HTTP mode: %s (timeout=%.1fs)", self.http_endpoint, self.timeout)

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file using Parakeet HTTP API."""
        logger.info("Transcribing %s via HTTP", audio_path)
        url = f"{self.http_endpoint}/v1/audio/transcriptions"
        with open(audio_path, "rb") as f:
            files = {"file": (os.path.basename(audio_path), f, "audio/wav")}
            data = {"model": self.model_name}
            if custom_words:
                data["initial_prompt"] = ", ".join(custom_words)
            response = await self._client.post(url, files=files, data=data, timeout=self.timeout)
        response.raise_for_status()
        result = response.json().get("text", "").strip()
        logger.info("Transcription result: %s", result[:100])
        return result

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "parakeet"

    async def close(self) -> None:
        """No persistent resources to close."""
        pass
