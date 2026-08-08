"""Moonshine local streaming transcription provider.

Project docs: docs/providers/moonshine.md

Moonshine Medium provides true streaming (269ms latency on Linux x86 CPU) with
6.65% WER — better than Whisper Large V3, running entirely on CPU without GPU.
"""

import asyncio
import logging
from typing import Any

import numpy as np

from .base import BatchProvider, StreamingProvider

logger = logging.getLogger(__name__)


class MoonshineProvider(StreamingProvider, BatchProvider):
    """Moonshine provider supporting both streaming and batch modes.

    Uses moonshine-voice pre-built wheels for Linux x86-64.
    First run downloads ~245MB model (cached after).
    """

    def __init__(self, config: dict[str, Any]):
        self.model_name = config.get("model", "medium")
        self.language = config.get("language", "en")
        self._transcriber: Any = None
        self._partial_result: str | None = None
        self._finalized_text = ""
        self._sample_rate: int = 16000
        # Lazy imports to avoid slow startup
        self._moonshine: Any = None

    def _ensure_imported(self) -> None:
        """Lazily import moonshine_voice."""
        if self._moonshine is None:
            import moonshine_voice  # pyright: ignore[reportMissingImports]

            self._moonshine = moonshine_voice

    def _ensure_model(self, language: str | None = None) -> None:
        """Lazily load the Moonshine model and create Transcriber."""
        self._ensure_imported()
        lang = language or self.language
        if self._transcriber is None:
            model_path, model_arch = self._moonshine.get_model_for_language(lang, self.model_name)
            self._transcriber = self._moonshine.Transcriber(
                model_path=model_path,
                model_arch=model_arch,
            )
            logger.info("Moonshine model loaded: %s (%s)", model_path, model_arch)

    # --- StreamingProvider interface ---

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        self._sample_rate = sample_rate
        await asyncio.to_thread(self._ensure_model, language)
        self._finalized_text = ""
        self._partial_result = None
        self._transcriber.remove_all_listeners()

        provider = self

        class _Listener(self._moonshine.TranscriptEventListener):
            def on_line_started(self, event: Any) -> None:
                pass

            def on_line_text_changed(self, event: Any) -> None:
                provider._partial_result = event.line.text

            def on_line_completed(self, event: Any) -> None:
                provider._finalized_text = (provider._finalized_text + " " + event.line.text).strip()
                provider._partial_result = None

        self._transcriber.add_listener(_Listener())
        self._transcriber.start()
        logger.info("Moonshine streaming started")

    async def send_audio(self, audio_chunk: bytes) -> None:
        if self._transcriber is None:
            raise RuntimeError("Stream not started. Call start_stream() first.")
        # Convert int16 bytes to float32 array (normalized to [-1, 1])
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32) / 32768.0
        self._transcriber.add_audio(samples.tolist(), self._sample_rate)

    async def finalize_stream(self) -> str:
        if self._transcriber is not None:
            try:
                self._transcriber.stop()
            except Exception:
                logger.warning("Error stopping Moonshine transcriber", exc_info=True)
        result = self._finalized_text
        if self._partial_result:
            result = (result + " " + self._partial_result).strip()
        self._partial_result = None
        self._finalized_text = ""
        return result

    # --- BatchProvider interface ---

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        await asyncio.to_thread(self._ensure_model, language)
        audio_data, sample_rate = self._moonshine.load_wav_file(audio_path)
        transcript = self._transcriber.transcribe_without_streaming(audio_data, sample_rate=sample_rate)
        text = " ".join(line.text for line in transcript.lines).strip()
        logger.info("Moonshine batch result: %s", text[:100])
        return text

    # --- Common ---

    @property
    def name(self) -> str:
        return "moonshine"

    async def close(self) -> None:
        if self._transcriber is not None:
            try:
                self._transcriber.stop()
            except Exception:
                logger.warning("Error stopping Moonshine transcriber during close", exc_info=True)
            finally:
                self._transcriber = None
