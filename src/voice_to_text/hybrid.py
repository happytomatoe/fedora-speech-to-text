"""Hybrid transcriber combining streaming and batch providers."""

import logging

from .providers.base import BatchProvider, StreamingProvider

logger = logging.getLogger(__name__)


class HybridTranscriber:
    """Combines streaming provider for real-time text with batch provider for final accuracy.

    All methods are async (``streaming.send_audio``, ``streaming.get_partial_result``,
    ``batch.transcribe_file`` are now async).
    """

    def __init__(self, streaming: StreamingProvider, batch: BatchProvider):
        self.streaming = streaming
        self.batch = batch
        self.partial_text = ""

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Start the streaming session."""
        await self.streaming.start_stream(language, sample_rate=sample_rate)
        self.partial_text = ""

    async def on_audio_chunk(self, chunk: bytes) -> str:
        """Called during recording. Returns live text for display."""
        logger.debug("Hybrid.on_audio_chunk: %d bytes", len(chunk))
        try:
            await self.streaming.send_audio(chunk)
            result = await self.streaming.get_partial_result()
            if result:
                self.partial_text = result
                logger.debug("Streaming partial len=%d", len(result))
            else:
                logger.debug("No partial result from streaming provider")
        except Exception as e:
            logger.warning("Streaming connection lost, continuing without live text: %s", e)
        return self.partial_text

    async def on_recording_stop(self, audio_path: str, language: str, custom_words: list[str] | None = None) -> str:
        """Called when recording stops. Returns accurate batch text."""
        try:
            finalized = await self.streaming.finalize_stream()
            if finalized:
                self.partial_text = finalized
        except Exception as e:
            logger.warning("Error finalizing stream: %s", e)
        try:
            return await self.batch.transcribe_file(audio_path, language=language, custom_words=custom_words)
        except Exception as e:
            logger.warning("Batch transcription failed, falling back to streaming transcript: %s", e)
            return self.partial_text

    async def close(self) -> None:
        """Close both streaming and batch providers."""
        try:
            await self.streaming.close()
        except Exception:
            pass
        try:
            await self.batch.close()
        except Exception:
            pass
