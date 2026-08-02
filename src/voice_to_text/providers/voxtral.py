"""Voxtral transcription provider (batch and streaming).

API reference: https://docs.mistral.ai/api/endpoint/audio/transcriptions
Project docs:  docs/providers/voxtral.md
"""

import asyncio
import concurrent.futures
import logging
import os
import threading
from pathlib import Path
from typing import Any

import httpx

from .base import BatchProvider, StreamingProvider, resolve_api_key

logger = logging.getLogger(__name__)


class VoxtralProvider(BatchProvider, StreamingProvider):
    """Voxtral transcription provider (batch and streaming).

    Uses Mistral's Voxtral models for both file transcription (batch)
    and real-time streaming via the Mistral SDK.

    Batch: uses ``httpx.AsyncClient`` (replaces ``requests``).
    Streaming: already uses asyncio internally via Mistral SDK realtime.
    """

    def __init__(self, config: dict[str, Any]):
        self.api_key = resolve_api_key(
            config, "VOXTRAL_API_KEY", extra_envs=("MISTRAL_API_KEY",), provider_name="voxtral"
        )
        self._api_url = config.get("api_url", "https://api.mistral.ai")
        # Batch model
        self.model = config.get("model", "voxtral-mini-latest")
        # Streaming model
        self._realtime_model = config.get("realtime_model", "voxtral-mini-transcribe-realtime-2602")
        self._target_delay_ms = config.get("target_delay_ms", 400)

        # Streaming state
        self._audio_queue: asyncio.Queue[bytes | None] | None = None
        self._partial_result: str | None = None
        self._partial_tokens: list[str] = []
        self._stream_task: concurrent.futures.Future[None] | None = None
        self._closed = False

        # Thread + event loop for async streaming
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready_event = threading.Event()

    # ── Batch ──────────────────────────────────────────────────────────

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe audio file using Voxtral batch transcription API."""
        logger.info("Transcribing %s with Voxtral model %s", audio_path, self.model)
        try:
            async with httpx.AsyncClient() as client:
                audio_data = await asyncio.to_thread(Path(audio_path).read_bytes)
                files = {"file": (os.path.basename(audio_path), audio_data)}
                data = {"model": self.model, "language": language}
                response = await client.post(
                    f"{self._api_url}/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    files=files,
                    data=data,
                    timeout=120,
                )
                response.raise_for_status()
                result = response.json()
                text = result.get("text", "").strip()
                logger.info("Transcription result: %s", text[:100])
                return text
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else "?"
            logger.error("Voxtral API error: HTTP %s", status)
            self._log_http_error_details(e)
            raise RuntimeError(f"Voxtral API request failed (HTTP {status}): {e}") from e
        except Exception as e:
            logger.exception("Voxtral transcription failed")
            raise RuntimeError(f"Voxtral transcription failed: {e}")

    def _log_http_error_details(self, e: httpx.HTTPStatusError) -> None:
        """Log additional details from HTTP error responses."""
        if e.response is None:
            return
        try:
            body = e.response.json()
            logger.error("Voxtral response body: %s", body)
        except ValueError:
            logger.error("Voxtral response text: %s", e.response.text[:500])
        if e.response.status_code == 401:
            key = self.api_key
            fingerprint = key[:6] + "..." + key[-4:] if len(key) > 10 else key
            logger.error("401 Unauthorized - key fingerprint=%s (len=%d)", fingerprint, len(key))

    # ── Streaming ──────────────────────────────────────────────────────

    def _run_event_loop(self):
        """Run the asyncio event loop in a dedicated thread."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._ready_event.set()
        self._loop.run_forever()

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Initialize a streaming session via Voxtral SDK."""
        import time as _time

        _t0 = _time.monotonic()
        # Ensure the SDK sees the correct key even if only VOXTRAL_API_KEY is set
        os.environ.setdefault("MISTRAL_API_KEY", self.api_key)

        # Start the event loop thread if not already running
        if self._thread is None or not self._thread.is_alive():
            self._loop = None
            self._ready_event.clear()
            self._thread = threading.Thread(target=self._run_event_loop, daemon=True)
            self._thread.start()
            ready = await asyncio.get_event_loop().run_in_executor(None, self._ready_event.wait, 5.0)
            if not ready or self._loop is None:
                raise RuntimeError("Failed to start event loop thread")
        _t_loop = _time.monotonic()

        # Create audio queue for this stream
        self._audio_queue = asyncio.Queue(maxsize=100)
        self._partial_tokens = []
        self._closed = False

        # Schedule the streaming coroutine on the event loop
        assert self._loop is not None  # guaranteed by the thread wait above
        self._stream_task = asyncio.run_coroutine_threadsafe(self._stream(sample_rate), self._loop)
        logger.info(
            "[PROFIL] Voxtral stream start: %.3fs total (event_loop %.3fs, model=%s delay=%sms)",
            _time.monotonic() - _t0,
            _t_loop - _t0,
            self._realtime_model,
            self._target_delay_ms,
        )

    async def _stream(self, sample_rate: int) -> None:
        """Run the Voxtral realtime streaming in the event loop thread."""
        from mistralai.client import Mistral
        from mistralai.extra.realtime import AudioFormat

        client = Mistral(api_key=self.api_key)
        rt = client.audio.realtime

        async def audio_chunks():
            while True:
                chunk = await self._audio_queue.get()  # type: ignore[union-attr]
                if chunk is None:
                    break
                yield chunk

        try:
            async for event in rt.transcribe_stream(
                audio_stream=audio_chunks(),
                model=self._realtime_model,
                audio_format=AudioFormat(encoding="pcm_s16le", sample_rate=sample_rate),
                target_streaming_delay_ms=self._target_delay_ms,
                server_url=self._api_url,
            ):
                self._emit(event)
                if getattr(event, "type", None) == "transcription.done":
                    break
        except asyncio.CancelledError:
            logger.info("Voxtral realtime stream cancelled")
            raise
        except Exception as exc:
            logger.exception("Voxtral realtime stream error")
            raise RuntimeError(f"Streaming connection lost: {exc}") from exc
        finally:
            if hasattr(rt, "close"):
                rt.close()  # type: ignore[attr-defined]
            logger.info("Voxtral realtime stream closed")

    def _enqueue_chunk(self, chunk: bytes) -> None:
        """Enqueue an audio chunk; called in the event-loop thread."""
        if self._audio_queue is None:
            return
        try:
            self._audio_queue.put_nowait(chunk)
        except asyncio.QueueFull:
            logger.warning("Audio queue full, dropping chunk")

    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send an audio chunk for processing - queues it for the async stream."""
        if self._audio_queue is not None and self._loop is not None:
            self._loop.call_soon_threadsafe(self._enqueue_chunk, audio_chunk)

    async def get_partial_result(self) -> str | None:
        """Get latest partial transcript."""
        return self._partial_result

    async def finalize_stream(self) -> str:
        """End stream and return final transcript."""
        self._closed = True
        if self._audio_queue is not None and self._loop is not None:
            try:
                fut = asyncio.run_coroutine_threadsafe(self._audio_queue.put(None), self._loop)
                await asyncio.wait_for(asyncio.wrap_future(fut), timeout=1.0)
            except Exception:
                logger.debug("Failed to signal stream shutdown", exc_info=True)

        if self._stream_task is not None:
            try:
                await asyncio.wait_for(asyncio.wrap_future(self._stream_task), timeout=5.0)
            except Exception:
                logger.debug("Stream task did not exit cleanly", exc_info=True)
            self._stream_task = None

        result = self._partial_result or ""
        self._partial_result = None
        return result

    def _emit(self, event) -> None:
        kind = getattr(event, "type", None)
        logger.info("Voxtral realtime event: type=%s", kind)

        if kind == "transcription.language":
            lang = getattr(event, "audio_language", "?")
            logger.info("Language detected: %s", lang)

        elif kind == "transcription.text.delta":
            token = event.text
            self._partial_tokens.append(token)
            self._partial_result = "".join(self._partial_tokens)
            logger.info("Partial result: %s", self._partial_result[:80])

        elif kind == "transcription.segment":
            sid = getattr(event, "speaker_id", None)
            tag = f"[{sid}]" if sid else ""
            text = f"{tag}{event.text}"
            self._partial_result = text
            self._partial_tokens = [text]
            logger.info("Segment: %s", text[:50])

        elif kind == "transcription.done":
            if getattr(event, "text", None):
                self._partial_result = event.text
            usage = getattr(event, "usage", None)
            if usage:
                logger.info("transcription.done usage: %s", usage)

        elif kind == "error":
            detail = getattr(getattr(event, "error", None), "message", str(event))
            logger.error("Voxtral realtime error: %s", detail)
            raise RuntimeError(detail)

        else:
            logger.debug("Unknown realtime event: %s", getattr(event, "content", event))

    @property
    def name(self) -> str:
        return "voxtral"

    async def close(self) -> None:
        """Clean up the event loop thread and streaming resources."""
        self._closed = True
        if self._audio_queue is not None and self._loop is not None:
            self._loop.call_soon_threadsafe(self._audio_queue.put_nowait, None)

        if self._loop is not None:
            try:
                # Use run_in_executor to stop the loop in its own thread
                await asyncio.get_event_loop().run_in_executor(None, lambda: self._loop.stop())
            except Exception:
                pass

        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None
        self._loop = None
