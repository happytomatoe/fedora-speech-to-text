"""Hybrid transcriber combining streaming and batch providers."""

import asyncio
import contextlib
import logging

from .providers.base import BatchProvider, StreamingProvider

logger = logging.getLogger(__name__)

STREAM_FINALIZE_TIMEOUT = 2.0


class HybridTranscriber:
    """Streams live text, then optionally replaces it with a batch pass.

    ``batch=None`` selects stream-only mode: the streaming provider's own
    final transcript is the result, so stop does not trigger a second
    transcription round-trip.
    """

    def __init__(self, streaming: StreamingProvider, batch: BatchProvider | None = None):
        """Initialize the hybrid transcriber."""
        self.streaming = streaming
        self.batch = batch
        self.partial_text = ""

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Start the streaming session."""
        await self.streaming.start_stream(language, sample_rate=sample_rate)
        self.partial_text = ""

    async def on_audio_chunk(self, chunk: bytes) -> str:
        """Process an audio chunk during recording and return live text."""
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

    async def _finalize_stream(self) -> str:
        """Close the stream and return the best transcript available."""
        try:
            finalized = await asyncio.wait_for(self.streaming.finalize_stream(), timeout=STREAM_FINALIZE_TIMEOUT)
        except TimeoutError:
            logger.warning("Streaming finalize exceeded %.1fs, using last partial transcript", STREAM_FINALIZE_TIMEOUT)
            with contextlib.suppress(Exception):
                latest = await self.streaming.get_partial_result()
                if latest:
                    self.partial_text = latest
            return self.partial_text
        except Exception as e:
            logger.warning("Error finalizing stream: %s", e)
            return self.partial_text
        if finalized:
            self.partial_text = finalized
        return self.partial_text

    async def on_recording_stop(self, audio_path: str, language: str, custom_words: list[str] | None = None) -> str:
        """Return the final transcript after the recording stops."""
        stream_text = await self._finalize_stream()
        if self.batch is None:
            logger.info("Streaming mode: final transcript from stream (%d chars)", len(stream_text))
            return stream_text
        try:
            return await self.batch.transcribe_file(audio_path, language=language, custom_words=custom_words)
        except Exception as e:
            logger.warning("Batch transcription failed, falling back to streaming transcript: %s", e)
            return self.partial_text

    async def close(self) -> None:
        """Close both streaming and batch providers."""
        with contextlib.suppress(Exception):
            await self.streaming.close()
        if self.batch is not None:
            with contextlib.suppress(Exception):
                await self.batch.close()
