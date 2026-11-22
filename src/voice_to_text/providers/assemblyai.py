"""AssemblyAI Universal transcription provider (batch and streaming).

API reference:
- Sync (batch): https://www.assemblyai.com/docs/api-reference/sync-api/transcribe
- Streaming:    https://www.assemblyai.com/docs/api-reference/streaming-api/universal-streaming/universal-streaming
Project docs: docs/providers/assemblyai.md

Batch uses the Sync API: one multipart request, transcript in the response — no
upload step and no polling. Streaming uses the v3 WebSocket: ``Turn`` events
carry ``end_of_turn``, and a session ends with ``{"type": "Terminate"}``.

Retention: the training opt-out is an account setting in the AssemblyAI
dashboard, not a request parameter. Free plans cannot opt out, and zero
retention on the streaming product requires a paid plan.
"""

import contextlib
import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from .base import (
    BatchProvider,
    WebSocketStreamingProvider,
    get_shared_client,
    resolve_api_key,
)

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "universal-3-6-pro"
DEFAULT_STREAMING_MODEL = "assemblyai-stt-3-7-realtime"
DEFAULT_API_URL = "https://sync.assemblyai.com"
DEFAULT_STREAMING_URL = "wss://streaming.assemblyai.com"
MODEL_HEADER = "X-AAI-Model"

# Languages the Sync and streaming models accept in ``language_codes``.
# https://www.assemblyai.com/docs/streaming/multilingual-transcription
_SUPPORTED_LANGUAGES = frozenset(
    {
        "af",
        "ar",
        "yue",
        "ca",
        "da",
        "nl",
        "en",
        "et",
        "fi",
        "fr",
        "gl",
        "de",
        "he",
        "hi",
        "it",
        "ja",
        "ko",
        "zh",
        "mr",
        "no",
        "nn",
        "fa",
        "pt",
        "ro",
        "ru",
        "es",
        "sv",
        "tr",
        "ur",
        "vi",
        "xh",
        "zu",
    }
)

_KEYTERM_FIELDS = ("keyterms_prompt", "keyterms", "word_boost")

# API limits: 100 keyterms per request, 8000 characters across all Sync keyterms.
_MAX_KEYTERMS = 100
_MAX_BATCH_KEYTERM_CHARS = 8000

# The Sync API needs the part's content type; the suffix identifies it.
_AUDIO_CONTENT_TYPES = {
    ".wav": "audio/wav",
    ".pcm": "audio/pcm",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
}


def _content_type(audio_path: str) -> str:
    """Return the multipart content type for an audio file."""
    return _AUDIO_CONTENT_TYPES.get(Path(audio_path).suffix.lower(), "audio/wav")


def _language_codes(language: str) -> list[str] | None:
    """Return a ``language_codes`` value for a known code, else None (auto-detect)."""
    code = (language or "").strip().lower()
    return [code] if code in _SUPPORTED_LANGUAGES else None


def _keyterms(terms: list[str], max_total_chars: int) -> list[str]:
    """Strip, dedupe, and cap keyterms to the API's per-request limits."""
    result: list[str] = []
    total = 0
    for term in terms:
        cleaned = term.strip()
        if not cleaned or cleaned in result:
            continue
        new_total = total + len(cleaned)
        if new_total > max_total_chars:
            continue
        total = new_total
        result.append(cleaned)
        if len(result) == _MAX_KEYTERMS:
            break
    return result


def _query_value(value: Any) -> str:
    """Serialize a connection-parameter value for the WebSocket query string."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return json.dumps(value)
    return str(value)


class AssemblyAIProvider(BatchProvider, WebSocketStreamingProvider):
    """AssemblyAI provider: Sync API for files, v3 WebSocket for live audio."""

    def __init__(self, config: dict[str, Any]):
        """Initialize the AssemblyAI provider."""
        self.api_key = resolve_api_key(config, "ASSEMBLYAI_API_KEY", provider_name="assemblyai")
        self.model = config.get("model", DEFAULT_MODEL)
        self.streaming_model = config.get("streaming_model", DEFAULT_STREAMING_MODEL)
        self.api_url = config.get("api_url", DEFAULT_API_URL)
        self.streaming_url = config.get("streaming_url", DEFAULT_STREAMING_URL)
        # Extra Sync ``config`` fields and streaming connection parameters.
        self.batch_options: dict[str, Any] = dict(config.get("batch_options", {}))
        self.streaming_options: dict[str, Any] = dict(config.get("streaming_options", {}))
        self._client = get_shared_client()
        self._init_ws_state()

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file with the AssemblyAI Sync API."""
        logger.info("Transcribing %s with AssemblyAI model %s", audio_path, self.model)
        payload: dict[str, Any] = dict(self.batch_options)
        if custom_words and not any(field in payload for field in _KEYTERM_FIELDS):
            keyterms = _keyterms(custom_words, _MAX_BATCH_KEYTERM_CHARS)
            if keyterms:
                payload["keyterms_prompt"] = keyterms
        if "language_codes" not in payload:
            language_codes = _language_codes(language)
            if language_codes:
                payload["language_codes"] = language_codes
        files: dict[str, Any] = {}
        if payload:
            files["config"] = (None, json.dumps(payload), "application/json")
        logger.debug("AssemblyAI Sync config: %s", payload)
        try:
            with open(audio_path, "rb") as audio_file:
                files["audio"] = (Path(audio_path).name, audio_file, _content_type(audio_path))
                response = await self._client.post(
                    f"{self.api_url}/v1/transcribe",
                    headers={"Authorization": self.api_key, MODEL_HEADER: self.model},
                    files=files,
                    timeout=120,
                )
            response.raise_for_status()
            text = (response.json().get("text") or "").strip()
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
            logger.error("AssemblyAI API error %s: %s", status, body)
            raise RuntimeError(f"AssemblyAI API error {status}: {body}") from e
        except Exception as e:
            logger.exception("AssemblyAI transcription failed")
            raise RuntimeError(f"AssemblyAI transcription failed: {e}") from e

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Open the AssemblyAI v3 streaming WebSocket."""
        params: dict[str, str] = {key: _query_value(value) for key, value in self.streaming_options.items()}
        params.update(
            {
                "speech_model": self.streaming_model,
                "sample_rate": str(sample_rate),
                "encoding": "pcm_s16le",
            }
        )
        if "language_codes" not in params:
            language_codes = _language_codes(language)
            if language_codes:
                params["language_codes"] = json.dumps(language_codes)
        logger.debug("AssemblyAI streaming params: %s", params)
        ws_url = f"{self.streaming_url}/v3/ws?{urlencode(params)}"
        await self._connect_ws(ws_url, {"Authorization": self.api_key})

    async def finalize_stream(self) -> str:
        """Send ``Terminate``, collect the last turns, and return the transcript."""
        await self._finalize_ws({"type": "Terminate"}, timeout=2.0)
        result = self._combined_text()
        self._partial_result = None
        self._finalized_text = ""
        return result

    def _handle_message(self, data: dict[str, Any]) -> bool:
        """Apply one streaming message; return True on session termination."""
        kind = data.get("type")
        if kind == "Turn":
            transcript = (data.get("transcript") or "").strip()
            if data.get("end_of_turn"):
                if transcript:
                    self._finalized_text = f"{self._finalized_text} {transcript}".strip()
                self._partial_result = None
            elif transcript:
                self._partial_result = transcript
        elif kind == "Termination":
            logger.debug("AssemblyAI session terminated: %s", data)
            return True
        elif kind == "Begin":
            logger.debug("AssemblyAI session started: %s", data.get("id"))
        elif kind == "Error":
            logger.error("AssemblyAI stream error: %s", data.get("error") or data)
        return False

    def _combined_text(self) -> str:
        """Join finalized text with the current partial."""
        if self._partial_result:
            return f"{self._finalized_text} {self._partial_result}".strip()
        return self._finalized_text

    async def close(self) -> None:
        """Close the WebSocket; the HTTP client is shared."""
        if self._ws is not None:
            ws, self._ws = self._ws, None
            with contextlib.suppress(Exception):
                await ws.close()

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "assemblyai"
