"""Tests for the 60db provider (batch + streaming)."""

import asyncio
import json
from unittest.mock import AsyncMock, Mock, patch

import pytest

from voice_to_text.providers import get_batch_provider
from voice_to_text.providers.sixty import SixtyProvider


class TestSixtyBatch:
    @pytest.mark.asyncio
    async def test_transcribe_file_request_format(self):
        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"data": {"text": "hello world"}}

        provider = get_batch_provider("60db", {"api_key": "test_key", "api_key_source": "env"})

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> Mock:
            captured["url"] = url
            captured.update(kwargs)  # type: ignore[arg-type]
            return mock_response

        provider._client.post = _fake_post  # type: ignore[assignment]

        import os
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(b"RIFF....WAVEfmt ")
            tmp_path = tmp.name

        try:
            result = await provider.transcribe_file(tmp_path, language="en")

            assert captured["url"] == "https://api.60db.ai/stt"

            headers = captured["headers"]
            assert headers["Authorization"] == "Bearer test_key"

            data = captured["data"]
            assert data["language"] == "en"

            files = captured["files"]
            assert "file" in files

            assert result == "hello world"
        finally:
            os.unlink(tmp_path)

    @pytest.mark.asyncio
    async def test_transcribe_file_unwrapped_response(self):
        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"text": "unwrapped result"}

        provider = get_batch_provider("60db", {"api_key": "test_key", "api_key_source": "env"})

        async def _fake_post(url: str, **kwargs: object) -> Mock:
            return mock_response

        provider._client.post = _fake_post  # type: ignore[assignment]

        import os
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(b"RIFF....WAVEfmt ")
            tmp_path = tmp.name

        try:
            result = await provider.transcribe_file(tmp_path)
            assert result == "unwrapped result"
        finally:
            os.unlink(tmp_path)


class FakeSixtyWebSocket:
    """In-process fake of the 60db realtime WebSocket (no network)."""

    def __init__(self):
        self.sent_messages: list[str] = []
        self._incoming: asyncio.Queue[str] = asyncio.Queue()
        # Seed handshake messages delivered on connect.
        self._incoming.put_nowait(json.dumps({"connection_established": {}}))
        self._incoming.put_nowait(json.dumps({"type": "connected"}))
        self._incoming.put_nowait(json.dumps({"type": "session_started"}))
        self._audio_count = 0

    async def send(self, data: str) -> None:
        self.sent_messages.append(data)
        msg = json.loads(data)
        msg_type = msg.get("type")
        if msg_type == "audio":
            self._audio_count += 1
            if self._audio_count == 1:
                # Interim partial result.
                self._incoming.put_nowait(
                    json.dumps(
                        {
                            "type": "transcription",
                            "text": "hello world",
                            "is_final": False,
                            "is_partial": True,
                        }
                    )
                )
            elif self._audio_count == 2:
                # speech_final with empty text -> must be skipped.
                self._incoming.put_nowait(
                    json.dumps(
                        {
                            "type": "transcription",
                            "text": "",
                            "is_final": True,
                            "speech_final": True,
                            "is_partial": False,
                        }
                    )
                )
            elif self._audio_count == 3:
                # Canonical final transcription.
                self._incoming.put_nowait(
                    json.dumps(
                        {
                            "type": "transcription",
                            "text": "hello world",
                            "is_final": True,
                            "speech_final": True,
                            "is_partial": False,
                        }
                    )
                )
        elif msg_type == "stop":
            self._incoming.put_nowait(json.dumps({"type": "session_stopped"}))

    async def close(self) -> None:
        pass

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        return await self._incoming.get()


class TestSixtyStreaming:
    @pytest.mark.asyncio
    async def test_streaming_handshake(self):
        fake = FakeSixtyWebSocket()
        with patch(
            "voice_to_text.providers.sixty.websockets.connect",
            new=AsyncMock(return_value=fake),
        ):
            provider = SixtyProvider({"api_key": "test_key", "api_key_source": "env"})
            await provider.start_stream("en", 16000)

            # start message was sent after connection_established
            assert any(json.loads(m).get("type") == "start" for m in fake.sent_messages)

            # Frame 1 -> interim partial result.
            await provider.send_audio(b"PCMDATA1")
            for _ in range(5):
                await asyncio.sleep(0)
            partial = await provider.get_partial_result()
            assert partial == "hello world"

            # Frame 2 -> empty speech_final signal (skipped).
            await provider.send_audio(b"PCMDATA2")
            for _ in range(5):
                await asyncio.sleep(0)

            # Frame 3 -> canonical final.
            await provider.send_audio(b"PCMDATA3")
            for _ in range(5):
                await asyncio.sleep(0)

            result = await provider.finalize_stream()
            assert result == "hello world"

            # stop message was sent.
            assert any(json.loads(m).get("type") == "stop" for m in fake.sent_messages)
