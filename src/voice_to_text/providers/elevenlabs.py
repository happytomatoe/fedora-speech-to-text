"""ElevenLabs Scribe speech-to-text provider (batch only).

API reference: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
Project docs:  docs/providers/elevenlabs.md
"""

import logging
from pathlib import Path
from typing import Any

import httpx

from .base import BatchProvider, resolve_api_key

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "scribe_v2"


class ElevenLabsProvider(BatchProvider):
    """ElevenLabs Scribe batch transcription provider.

    ElevenLabs offers speech-to-text via the Scribe models
    (https://api.elevenlabs.io/v1/speech-to-text). It is REST/batch only; there is no
    streaming transcription WebSocket, so this provider does not implement
    StreamingProvider.

    Uses ``httpx.AsyncClient`` (already a dependency) for async batch transcription.
    """

    def __init__(self, config: dict[str, Any]):
        self.api_key = resolve_api_key(config, "ELEVENLABS_API_KEY", provider_name="elevenlabs")
        self.model = config.get("model", DEFAULT_MODEL)
        self.api_url = config.get("api_url", "https://api.elevenlabs.io")
        self.tag_audio_events = config.get("tag_audio_events", False)

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        logger.info("Transcribing %s with ElevenLabs model %s", audio_path, self.model)
        headers = {"xi-api-key": self.api_key}
        data: dict[str, Any] = {
            "model_id": self.model,
            "timestamps_granularity": "none",
            "tag_audio_events": str(self.tag_audio_events).lower(),
        }
        if custom_words:
            data["keyterms"] = custom_words
        # ElevenLabs accepts ISO-639-1 (2-letter, e.g. "en") and ISO-639-3
        # (3-letter, e.g. "eng") language codes. Forward the configured language
        # when present so the user's choice is respected instead of auto-detecting.
        if language and len(language) in (2, 3):
            data["language_code"] = language
        try:
            async with httpx.AsyncClient() as client:
                with open(audio_path, "rb") as audio_file:
                    response = await client.post(
                        f"{self.api_url}/v1/speech-to-text",
                        headers=headers,
                        data=data,
                        files={"file": (Path(audio_path).name, audio_file, "application/octet-stream")},
                        timeout=120,
                    )
            response.raise_for_status()
            result = response.json()
            text = (result.get("text") or "").strip()
            logger.info("Transcription result: %s", text[:100])
            return text
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else "?"
            body = ""
            if e.response is not None:
                try:
                    body = str(e.response.json())
                except ValueError:
                    body = e.response.text[:500]
            logger.error("ElevenLabs API error %s: %s", status, body)
            raise RuntimeError(f"ElevenLabs API error {status}: {body}") from e
        except Exception as e:
            logger.exception("ElevenLabs transcription failed")
            raise RuntimeError(f"ElevenLabs transcription failed: {e}") from e

    async def close(self) -> None:
        """No persistent resources to close."""
        pass

    @property
    def name(self) -> str:
        return "elevenlabs"
