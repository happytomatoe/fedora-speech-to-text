"""60db (sixtydb) transcription provider (batch and streaming).

API reference: https://docs.60db.ai/api-reference/introduction
Project docs:  docs/providers/60db.md
"""

import asyncio
import base64
import contextlib
import json
import logging
import os
from typing import Any

import httpx
import websockets

from .base import BatchProvider, StreamingProvider, get_shared_client, resolve_api_key

logger = logging.getLogger(__name__)

# HTTP status codes
_HTTP_UNAUTHORIZED = 401
_API_KEY_MIN_LEN = 10


class SixtyProvider(BatchProvider, StreamingProvider):
    """60db Speech-to-Text provider (batch REST + realtime WebSocket)."""

    def __init__(self, config: dict[str, Any]):
        """Initialize the 60db provider."""
        self.api_key = resolve_api_key(config, "SIXTYDB_API_KEY", provider_name="60db")
        self.api_url = config.get("api_url", "https://api.60db.ai").rstrip("/")
        self.ws_url = config.get("ws_url", "wss://api.60db.ai/ws/stt")
        self.model = config.get("model", "60db-stt-v01")
        # Use shared HTTP client (created once at service startup)
        self._client = get_shared_client()
        # Streaming state
        self._ws: Any = None
        self._recv_task: asyncio.Task | None = None
        self._sample_rate: int = 16000
        self._finalized_text: str = ""
        self._partial_result: str | None = None
        self._connected = asyncio.Event()
        self._session_started = asyncio.Event()
        self._session_stopped = asyncio.Event()

    # ── Batch ──────────────────────────────────────────────────────────

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file using 60db."""
        logger.info("Transcribing %s with 60db", audio_path)
        headers = {"Authorization": f"Bearer {self.api_key}"}
        data: dict[str, str | list[str]] = {}
        if language and language != "auto":
            data["language"] = language
        if custom_words:
            data["context"] = ", ".join(custom_words)
        try:
            with open(audio_path, "rb") as audio_file:
                files = {"file": (os.path.basename(audio_path), audio_file)}
                response = await self._client.post(
                    f"{self.api_url}/stt",
                    headers=headers,
                    data=data,
                    files=files,
                    timeout=120,
                )
            response.raise_for_status()
            result = response.json()
            payload = result.get("data", result)
            text = (payload.get("text") or "").strip()
            logger.info("60db transcription result: %s", text[:100])
            return text
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else "?"
            logger.error("60db API error: HTTP %s", status)
            if e.response is not None:
                try:
                    body = e.response.json()
                    logger.error("60db response body: %s", body)
                except ValueError:
                    logger.error("60db response text: %s", e.response.text[:500])
                if status == _HTTP_UNAUTHORIZED:
                    key_len = len(self.api_key)
                    fp = self.api_key[:6] + "..." + self.api_key[-4:] if key_len > _API_KEY_MIN_LEN else self.api_key
                    logger.error("401 Unauthorized - key fingerprint=%s (len=%d)", fp, len(self.api_key))
            raise RuntimeError(f"60db API request failed (HTTP {status}): {e}") from e
        except Exception as e:
            logger.exception("60db transcription failed")
            raise RuntimeError(f"60db transcription failed: {e}") from e

    # ── Streaming ──────────────────────────────────────────────────────

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Start a WebSocket streaming session with 60db."""
        self._sample_rate = sample_rate
        self._finalized_text = ""
        self._partial_result = None
        self._connected.clear()
        self._session_started.clear()
        self._session_stopped.clear()

        ws_url = f"{self.ws_url}?apiKey={self.api_key}"
        self._ws = await websockets.connect(ws_url)
        self._recv_task = asyncio.create_task(self._receive_loop())

        # Wait for auth before sending start
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=10.0)
        except TimeoutError as e:
            raise RuntimeError("60db: connection_established not received") from e

        start_msg: dict[str, Any] = {
            "type": "start",
            "config": {
                "encoding": "linear",
                "sample_rate": sample_rate,
                "continuous_mode": True,
            },
        }
        if language and language != "auto":
            start_msg["languages"] = [language]
        await self._ws.send(json.dumps(start_msg))

        try:
            await asyncio.wait_for(self._session_started.wait(), timeout=10.0)
        except TimeoutError as e:
            raise RuntimeError("60db: session_started not received") from e

    async def _receive_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue  # binary frames are telephony μ-law; we use JSON
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                self._handle_message(msg)
        except asyncio.CancelledError:
            logger.info("60db receive loop cancelled")
            raise
        except Exception as e:
            logger.warning("60db receive loop error: %s", e)

    def _handle_message(self, msg: dict[str, Any]) -> None:
        # "connection_established" may arrive as a key (some SDK shapes) or as
        # msg["type"] == "connection_established" (documented WS protocol).
        if msg.get("connection_established") is not None or msg.get("type") == "connection_established":
            self._connected.set()
            return
        msg_type = msg.get("type")
        if msg_type in ("session_started", "connected"):
            self._session_started.set()
        elif msg_type == "transcription":
            self._on_transcription(msg)
        elif msg_type == "session_stopped":
            self._session_stopped.set()
        elif msg_type == "error":
            logger.error("60db stream error: %s", msg.get("error"))

    def _on_transcription(self, msg: dict[str, Any]) -> None:
        if msg.get("is_partial") or not msg.get("is_final"):
            self._partial_result = msg.get("text") or None
            return
        # is_final and speech_final → canonical; append if non-empty
        text = (msg.get("text") or "").strip()
        if text:
            self._finalized_text = (self._finalized_text + " " + text).strip()
        self._partial_result = None

    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send an audio chunk to the streaming transcriber."""
        if self._ws is None or not self._session_started.is_set():
            return  # drop frames before session is ready
        frame = json.dumps(
            {
                "type": "audio",
                "audio": base64.b64encode(audio_chunk).decode("ascii"),
                "encoding": "linear",
                "sample_rate": self._sample_rate,
            }
        )
        try:
            await self._ws.send(frame)
        except Exception as e:
            logger.warning("Error sending audio to 60db stream: %s", e)
            self._ws = None
            raise RuntimeError("Streaming connection lost") from e

    async def finalize_stream(self) -> str:
        """Finalize the streaming session and return the complete text."""
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "stop"}))
                try:
                    async with asyncio.timeout(5.0):
                        await self._session_stopped.wait()
                except TimeoutError:
                    pass
            except Exception as e:
                logger.warning("Error stopping 60db stream: %s", e)
            finally:
                with contextlib.suppress(Exception):
                    await self._ws.close()
                self._ws = None
        if self._recv_task is not None:
            self._recv_task.cancel()
            self._recv_task = None
        result = self._finalized_text
        self._finalized_text = ""
        self._partial_result = None
        return result

    async def close(self) -> None:
        """Close provider resources (WebSocket)."""
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
        if self._recv_task is not None:
            self._recv_task.cancel()
            self._recv_task = None

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "60db"
