"""Speechmatics transcription provider (batch and realtime).

API reference:
- Batch:    https://docs.speechmatics.com/api-ref/batch/create-a-new-job
- Realtime: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket
Project docs: docs/providers/speechmatics.md

Batch submits a job (``POST /v2/jobs``), polls its status, then downloads the
plain-text transcript. Realtime opens ``wss://…/v2`` and streams raw PCM:
``StartRecognition``, binary audio, then ``EndOfStream``; the server answers
with ``AddPartialTranscript``/``AddTranscript`` and ``EndOfTranscript``.

``model`` replaces the deprecated ``operating_point`` field. The default is
``enhanced``; ``standard`` trades accuracy for throughput.
"""

import asyncio
import contextlib
import json
import logging
import math
from pathlib import Path
from typing import Any

import httpx

from .base import BatchProvider, WebSocketStreamingProvider, get_shared_client, resolve_api_key

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "enhanced"
DEFAULT_API_URL = "https://eu1.asr.api.speechmatics.com/v2"
DEFAULT_REALTIME_URL = "wss://eu2.rt.speechmatics.com/v2"
DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_POLL_INTERVAL = 0.5

_TERMINAL_FAILURES = frozenset({"rejected", "deleted", "expired"})


class SpeechmaticsProvider(BatchProvider, WebSocketStreamingProvider):
    """Speechmatics batch transcription and realtime WebSocket streaming."""

    def __init__(self, config: dict[str, Any]):
        """Initialize the Speechmatics provider."""
        self.api_key = resolve_api_key(config, "SPEECHMATICS_API_KEY", provider_name="speechmatics")
        self.model = config.get("model", DEFAULT_MODEL)
        self.api_url = str(config.get("api_url", DEFAULT_API_URL)).rstrip("/")
        self.realtime_url = str(config.get("realtime_url", DEFAULT_REALTIME_URL)).rstrip("/")
        # Extra ``transcription_config`` fields for batch and realtime.
        self.batch_options: dict[str, Any] = dict(config.get("batch_options", {}))
        self.streaming_options: dict[str, Any] = dict(config.get("streaming_options", {}))
        self.timeout_seconds = float(config.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
        self.poll_interval = float(config.get("poll_interval", DEFAULT_POLL_INTERVAL))
        self._client = get_shared_client()
        self._init_ws_state()
        self._audio_seq = 0

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "speechmatics"

    def _transcription_config(
        self, language: str, custom_words: list[str] | None, options: dict[str, Any]
    ) -> dict[str, Any]:
        """Build a ``transcription_config`` object for either API."""
        transcription_config: dict[str, Any] = {"model": self.model, "language": language}
        transcription_config.update(options)
        if custom_words and "additional_vocab" not in transcription_config:
            transcription_config["additional_vocab"] = [{"content": word} for word in custom_words]
        return transcription_config

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file with the Speechmatics batch API."""
        logger.info("Transcribing %s with Speechmatics model %s", audio_path, self.model)
        job_config = {
            "type": "transcription",
            "transcription_config": self._transcription_config(language, custom_words, self.batch_options),
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            job_id = await self._submit_job(audio_path, job_config, headers)
            await self._wait_for_job(job_id, headers)
            return await self._fetch_transcript(job_id, headers)
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else "?"
            body = e.response.text[:500] if e.response is not None else ""
            logger.error("Speechmatics API error %s: %s", status, body)
            raise RuntimeError(f"Speechmatics API error {status}: {body}") from e
        except TimeoutError as e:
            raise RuntimeError(f"Speechmatics transcription timed out after {self.timeout_seconds:.0f}s") from e
        except Exception as e:
            logger.exception("Speechmatics transcription failed")
            raise RuntimeError(f"Speechmatics transcription failed: {e}") from e

    async def _submit_job(self, audio_path: str, job_config: dict[str, Any], headers: dict[str, str]) -> str:
        """Upload the audio file and return the job id."""
        with open(audio_path, "rb") as audio_file:
            files = {
                "data_file": (Path(audio_path).name, audio_file),
                "config": (None, json.dumps(job_config), "application/json"),
            }
            response = await self._client.post(f"{self.api_url}/jobs/", headers=headers, files=files)
        response.raise_for_status()
        job_id = response.json().get("id")
        if not isinstance(job_id, str) or not job_id:
            raise RuntimeError(f"Speechmatics did not return a job id: {response.text[:500]}")
        logger.debug("Speechmatics job submitted: %s", job_id)
        return job_id

    async def _wait_for_job(self, job_id: str, headers: dict[str, str]) -> None:
        """Poll the job until it is done or fails, bounded by ``timeout_seconds``."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.timeout_seconds
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError
            response = await self._client.get(
                f"{self.api_url}/jobs/{job_id}",
                headers=headers,
                params={"wait": max(1, min(30, math.ceil(remaining)))},
            )
            response.raise_for_status()
            job = response.json().get("job") or {}
            status = job.get("status")
            if status == "done":
                return
            if status in _TERMINAL_FAILURES:
                raise RuntimeError(f"Speechmatics job {job_id} {status}: {job.get('error') or job}")
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError
            await asyncio.sleep(min(self.poll_interval, remaining))

    async def _fetch_transcript(self, job_id: str, headers: dict[str, str]) -> str:
        """Download the plain-text transcript for a finished job."""
        response = await self._client.get(
            f"{self.api_url}/jobs/{job_id}/transcript",
            headers=headers,
            params={"format": "txt", "wait": 10},
        )
        response.raise_for_status()
        text = response.text.strip()
        logger.info("Transcription result: %s", text[:100])
        return text

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Open the Speechmatics realtime WebSocket and start recognition."""
        transcription_config = self._transcription_config(language, None, self.streaming_options)
        transcription_config.setdefault("enable_partials", True)
        transcription_config.setdefault("max_delay", 0.7)
        message = {
            "message": "StartRecognition",
            "audio_format": {"type": "raw", "encoding": "pcm_s16le", "sample_rate": sample_rate},
            "transcription_config": transcription_config,
        }
        await self._connect_ws(self.realtime_url, {"Authorization": f"Bearer {self.api_key}"})
        if self._ws is None:
            raise RuntimeError("Speechmatics WebSocket failed to connect")
        await self._ws.send(json.dumps(message))
        await self._await_recognition_started()
        self._audio_seq = 0
        logger.debug("Speechmatics StartRecognition: %s", transcription_config)

    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send raw audio, then track the chunk count for ``last_seq_no``."""
        await super().send_audio(audio_chunk)
        self._audio_seq += 1

    async def _await_recognition_started(self) -> None:
        """Block until the server accepts the session, so auth errors surface early."""
        while self._ws is not None:
            raw = await asyncio.wait_for(self._ws.recv(), timeout=10.0)
            if not isinstance(raw, str):
                continue
            data = json.loads(raw)
            kind = data.get("message")
            if kind == "RecognitionStarted":
                return
            if kind == "Error":
                raise RuntimeError(f"Speechmatics could not start the stream: {data.get('reason') or data}")
        raise RuntimeError("Speechmatics stream closed before it started")

    async def finalize_stream(self) -> str:
        """Send ``EndOfStream``, collect the final transcripts, and close."""
        await self._finalize_ws({"message": "EndOfStream", "last_seq_no": self._audio_seq})
        return self._take_combined_text()

    def _handle_message(self, data: dict[str, Any]) -> bool:
        """Apply one server message; return True on ``EndOfTranscript``."""
        kind = data.get("message")
        if kind == "AddTranscript":
            transcript = ((data.get("metadata") or {}).get("transcript") or "").strip()
            if transcript:
                self._finalized_text = f"{self._finalized_text} {transcript}".strip()
            self._partial_result = None
        elif kind == "AddPartialTranscript":
            transcript = ((data.get("metadata") or {}).get("transcript") or "").strip()
            if transcript:
                self._partial_result = transcript
        elif kind == "EndOfTranscript":
            return True
        elif kind == "Error":
            logger.error("Speechmatics stream error: %s", data.get("reason") or data)
        elif kind == "RecognitionStarted":
            logger.debug("Speechmatics session started: %s", data.get("id"))
        return False

    def _take_combined_text(self) -> str:
        """Return finalized plus partial text, then reset stream state."""
        result = (
            f"{self._finalized_text} {self._partial_result}".strip() if self._partial_result else self._finalized_text
        )
        self._partial_result = None
        self._finalized_text = ""
        return result

    async def close(self) -> None:
        """Close the WebSocket; the HTTP client is shared."""
        if self._ws is not None:
            ws, self._ws = self._ws, None
            with contextlib.suppress(Exception):
                await ws.close()
