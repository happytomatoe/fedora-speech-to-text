"""Deepgram Nova-3 transcription provider (batch and streaming).

API reference: https://developers.deepgram.com/reference
- Pre-recorded: https://developers.deepgram.com/reference/pre-recorded
- Streaming:    https://developers.deepgram.com/reference/streaming
- Project docs: docs/providers/deepgram.md

Available query parameters (set via deepgram.batch_options in config.yaml):
- model:           Model to use (default: nova-3)
- language:        Language code (default: en)
- punctuate:       Add punctuation to transcript
- smart_format:    Format dates, times, numbers, etc.
- paragraphs:      Split transcript into paragraphs with blank-line breaks
- numerals:        Convert numbers from words to digits
- filler_words:    Include filler words (uh, um)
- utterances:      Split transcript by speaker utterance
- diarize:         Speaker diarization
- multichannel:    Transcribe each channel separately
- profanity_filter: Mask profanity
- redact:          Redact PII (credit_cards, ssn, etc.)
- search:          Search for specific terms
- replace:         Find-and-replace words
- callback:        Callback URL for async results
- endpointing:     Endpoint detection sensitivity for streaming
- interim_results: Return interim results during streaming
- encoding:        Audio encoding format
- sample_rate:     Audio sample rate
- channels:        Number of audio channels
- mip_opt_out:     Opt out of the Model Improvement Program
"""

import asyncio
import logging
from pathlib import Path
from typing import Any

import httpx

from .base import BatchProvider, WebSocketStreamingProvider, resolve_api_key

logger = logging.getLogger(__name__)


class DeepgramProvider(BatchProvider, WebSocketStreamingProvider):
    """Deepgram Nova-3 transcription provider (batch and streaming).

    Batch: uses ``httpx.AsyncClient`` (replaces ``requests``).
    Streaming: uses ``websockets`` (replaces ``websocket-client``).
    """

    def __init__(self, config: dict[str, Any]):
        self.api_key = resolve_api_key(config, "DEEPGRAM_API_KEY", provider_name="deepgram")
        self.model = config.get("model", "nova-3")
        self.api_url = config.get("api_url", "https://api.deepgram.com")

        # Default batch options
        self.batch_options = {
            "filler_words": False,
            "mip_opt_out": True,
            "paragraphs": True,
        }
        # Merge with config options
        self.batch_options.update(config.get("batch_options", {}))

        self._client = httpx.AsyncClient(timeout=120)
        self._init_ws_state()

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        logger.info("Transcribing %s with Deepgram model %s", audio_path, self.model)
        try:
            params = {
                "model": self.model,
                "language": language,
            }
            params.update(self.batch_options)
            if audio_path.startswith(("http://", "https://")):
                headers = {"Authorization": f"Token {self.api_key}"}
                content = None
                json_data = {"url": audio_path}
            else:
                headers = {
                    "Authorization": f"Token {self.api_key}",
                    "Content-Type": "audio/wav",
                }
                content = await asyncio.to_thread(Path(audio_path).read_bytes)
                json_data = None

            response = await self._client.post(
                f"{self.api_url}/v1/listen",
                params=params,
                headers=headers,
                content=content,
                json=json_data,
            )
            response.raise_for_status()
            result = response.json()
            text = (
                result.get("results", {})
                .get("channels", [{}])[0]
                .get("alternatives", [{}])[0]
                .get("transcript", "")
                .strip()
            )
            logger.info("Transcription result: %s", text[:100])
            return text
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else "?"
            logger.error("Deepgram API error: HTTP %s", status)
            self._log_http_error_details(e, status)
            raise RuntimeError(f"Deepgram API request failed (HTTP {status}): {e}") from e
        except Exception as e:
            logger.exception("Deepgram transcription failed")
            raise RuntimeError(f"Deepgram transcription failed: {e}")

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        import time as _time

        _t0 = _time.monotonic()
        ws_url = (
            f"{self.api_url.replace('https://', 'wss://').replace('http://', 'ws://')}/v1/listen"
            f"?model={self.model}"
            f"&language={language}"
            f"&encoding=linear16"
            f"&sample_rate={sample_rate}"
            f"&interim_results=true"
            f"&smart_format=true"
            f"&punctuate=true"
            f"&numerals=true"
            f"&filler_words=true"
        )
        headers = {"Authorization": f"Token {self.api_key}"}
        await self._connect_ws(ws_url, headers)
        logger.info("[PROFIL] Deepgram WS connect: %.3fs (sample_rate=%d)", _time.monotonic() - _t0, sample_rate)

    def _log_http_error_details(self, e: httpx.HTTPStatusError, status: int | str) -> None:
        """Log additional details from HTTP error responses."""
        if e.response is None:
            return
        try:
            body = e.response.json()
            logger.error("Deepgram response body: %s", body)
        except ValueError:
            logger.error("Deepgram response text: %s", e.response.text[:500])
        if status == 401:
            key = self.api_key
            fingerprint = key[:6] + "..." + key[-4:] if len(key) > 10 else key[:3] + "..." + key[-2:]
            logger.error("401 Unauthorized - key fingerprint=%s (len=%d)", fingerprint, len(key))

    @property
    def name(self) -> str:
        return "deepgram"

    async def close(self) -> None:
        """Close the persistent HTTP client and WebSocket."""
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        await self._client.aclose()
