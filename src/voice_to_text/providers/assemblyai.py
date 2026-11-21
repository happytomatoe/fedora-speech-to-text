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

import asyncio
import contextlib
import json
import logging
from pathlib import Path
from typing import Any

import httpx

from .base import (
    BatchProvider,
    WebSocketStreamingProvider,
    get_shared_client,
    resolve_api_key,
)

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "universal-3-6-pro"
DEFAULT_STREAMING_MODEL = "universal-streaming-english"
DEFAULT_API_URL = "https://sync.assemblyai.com"
DEFAULT_STREAMING_URL = "wss://streaming.assemblyai.com"
MODEL_HEADER = "X-AAI-Model"

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


class AssemblyAIProvider(BatchProvider, WebSocketStreamingProvider):
    """AssemblyAI provider: Sync API for files, v3 WebSocket for live audio."""

    def __init__(self, config: dict[str, Any]):
        """Initialize the AssemblyAI provider."""
        self.api_key = resolve_api_key(config, "ASSEMBLYAI_API_KEY", provider_name="assemblyai")
        self.model = config.get("model", DEFAULT_MODEL)
        self.streaming_model = config.get("streaming_model", DEFAULT_STREAMING_MODEL)
        self.api_url = config.get("api_url", DEFAULT_API_URL)
        self.streaming_url = config.get("streaming_url", DEFAULT_STREAMING_URL)
        self.format_turns = config.get("format_turns", True)
        self._client = get_shared_client()
        self._init_ws_state()

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file with the AssemblyAI Sync API."""
        logger.info("Transcribing %s with AssemblyAI model %s", audio_path, self.model)
        logger.debug("AssemblyAI Sync auto-detects language (hint=%r)", language)
        if custom_words:
            logger.debug("AssemblyAI Sync does not accept keyterms; ignoring %d words", len(custom_words))
        try:
            with open(audio_path, "rb") as audio_file:
                response = await self._client.post(
                    f"{self.api_url}/v1/transcribe",
                    headers={"Authorization": self.api_key, MODEL_HEADER: self.model},
                    files={"audio": (Path(audio_path).name, audio_file, _content_type(audio_path))},
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
        logger.debug("AssemblyAI streaming model %s ignores language hint %r", self.streaming_model, language)
        format_turns = "true" if self.format_turns else "false"
        ws_url = (
            f"{self.streaming_url}/v3/ws"
            f"?speech_model={self.streaming_model}"
            f"&sample_rate={sample_rate}"
            f"&encoding=pcm_s16le"
            f"&format_turns={format_turns}"
        )
        await self._connect_ws(ws_url, {"Authorization": self.api_key})

    async def finalize_stream(self) -> str:
        """Send ``Terminate``, collect the last turns, and return the transcript."""
        if self._ws is None:
            result = self._combined_text()
            self._partial_result = None
            self._finalized_text = ""
            return result

        try:
            await self._ws.send(json.dumps({"type": "Terminate"}))
            await asyncio.wait_for(self._collect_final_turns(), timeout=2.0)
        except TimeoutError:
            logger.debug("Timeout draining AssemblyAI stream during close")
        except Exception as e:
            logger.warning("Error closing AssemblyAI stream: %s", e)
        finally:
            if self._ws is not None:
                with contextlib.suppress(Exception):
                    await self._ws.close()

        result = self._combined_text()
        self._ws = None
        self._partial_result = None
        self._finalized_text = ""
        return result

    async def _collect_final_turns(self) -> None:
        """Read messages until the server sends ``Termination``."""
        assert self._ws is not None
        while self._ws is not None:
            raw = await self._ws.recv()
            if isinstance(raw, str) and self._handle_message(json.loads(raw)):
                return

    async def _process_messages(self) -> None:
        """Apply buffered streaming messages without blocking the audio loop."""
        if self._ws is None:
            return
        try:
            async with asyncio.timeout(0.01):
                while self._ws is not None:
                    raw = await self._ws.recv()
                    if isinstance(raw, str) and self._handle_message(json.loads(raw)):
                        return
        except TimeoutError:
            pass
        except Exception as e:
            logger.warning("Error processing AssemblyAI messages: %s", e)
            ws, self._ws = self._ws, None
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()

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
