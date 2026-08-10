"""Groq Whisper transcription provider (batch only).

API reference: https://console.groq.com/docs/speech-to-text
Project docs:  docs/providers/groq.md
"""

import logging
from pathlib import Path
from typing import Any

from groq import AsyncGroq

from .base import BatchProvider, resolve_api_key

logger = logging.getLogger(__name__)


class GroqProvider(BatchProvider):
    """Groq Whisper batch transcription provider.

    Note: Groq does not support WebSocket streaming for audio transcription.
    Their API is REST-only. Use batch transcription with fast inference.

    Uses ``AsyncGroq`` SDK (built on httpx) for async batch transcription.
    """

    def __init__(self, config: dict[str, Any]):
        """Initialize the Groq provider."""
        self.api_key = resolve_api_key(config, "GROQ_API_KEY", provider_name="groq")
        self.model = config.get("model", "whisper-large-v3-turbo")
        self.client = AsyncGroq(api_key=self.api_key)  # pyright: ignore[reportCallIssue]

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file using Groq."""
        logger.info("Transcribing %s with Groq model %s", audio_path, self.model)
        try:
            kwargs: dict[str, Any] = {
                "model": self.model,
                "file": Path(audio_path),
                "language": language,
                "response_format": "text",
            }
            if custom_words:
                kwargs["prompt"] = ", ".join(custom_words)
            transcription = await self.client.audio.transcriptions.create(**kwargs)
            result = str(transcription).strip()
            logger.info("Transcription result: %s", result[:100])
            return result
        except Exception:
            logger.exception("Groq transcription API call failed")
            raise

    def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Raise NotImplementedError (Groq does not support streaming)."""
        raise NotImplementedError(
            "Groq does not support WebSocket streaming for audio transcription. "
            "Use batch transcription or choose a different provider for streaming."
        )

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "groq"

    async def close(self) -> None:
        """Close the Groq client."""
        await self.client.close()
