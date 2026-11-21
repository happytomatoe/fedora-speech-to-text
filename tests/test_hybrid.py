"""Tests for the hybrid/streaming transcriber."""

import asyncio

import pytest

from voice_to_text import hybrid
from voice_to_text.hybrid import HybridTranscriber


class FakeStreaming:
    def __init__(self, final: str = "stream text", hang: bool = False):
        self.final = final
        self.hang = hang
        self.latest = final
        self.closed = False

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        pass

    async def send_audio(self, chunk: bytes) -> None:
        pass

    async def get_partial_result(self) -> str | None:
        return self.latest

    async def finalize_stream(self) -> str:
        if self.hang:
            await asyncio.sleep(30)
        return self.final

    async def close(self) -> None:
        self.closed = True


class FakeBatch:
    def __init__(self, text: str = "batch text", fail: bool = False):
        self.text = text
        self.fail = fail
        self.calls = 0

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        self.calls += 1
        if self.fail:
            raise RuntimeError("batch down")
        return self.text

    async def close(self) -> None:
        pass


async def test_streaming_mode_uses_stream_transcript_without_batch():
    transcriber = HybridTranscriber(FakeStreaming("hello there"))
    assert await transcriber.on_recording_stop("/tmp/a.wav", "en") == "hello there"


async def test_hybrid_mode_uses_batch_result():
    batch = FakeBatch("corrected text")
    transcriber = HybridTranscriber(FakeStreaming("live text"), batch)
    assert await transcriber.on_recording_stop("/tmp/a.wav", "en") == "corrected text"
    assert batch.calls == 1


async def test_hybrid_mode_falls_back_to_stream_text_when_batch_fails():
    transcriber = HybridTranscriber(FakeStreaming("live text"), FakeBatch(fail=True))
    assert await transcriber.on_recording_stop("/tmp/a.wav", "en") == "live text"


async def test_finalize_timeout_outputs_latest_partial(monkeypatch):
    monkeypatch.setattr(hybrid, "STREAM_FINALIZE_TIMEOUT", 0.05)
    streaming = FakeStreaming("final text", hang=True)
    streaming.latest = "last partial"
    transcriber = HybridTranscriber(streaming)

    transcript = await asyncio.wait_for(transcriber.on_recording_stop("/tmp/a.wav", "en"), timeout=1.0)

    assert transcript == "last partial"
    assert streaming.closed is False


async def test_close_skips_absent_batch_provider():
    streaming = FakeStreaming()
    transcriber = HybridTranscriber(streaming)
    await transcriber.close()
    assert streaming.closed is True


@pytest.mark.parametrize("chunk", [b"\x00\x01" * 1024])
async def test_partial_text_updates_during_recording(chunk):
    transcriber = HybridTranscriber(FakeStreaming("live words"))
    assert await transcriber.on_audio_chunk(chunk) == "live words"
