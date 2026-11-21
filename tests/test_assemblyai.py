"""Tests for the AssemblyAI provider."""

import asyncio
import json
import os
import tempfile
from unittest.mock import Mock, patch

import pytest

from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.providers.assemblyai import AssemblyAIProvider


class _FakeWS:
    """Minimal stand-in for a websockets client connection."""

    def __init__(self, messages: list[str], after_terminate: list[str] | None = None):
        self._messages = list(messages)
        self._after_terminate = list(after_terminate or [])
        self.sent: list[str] = []
        self.closed = False

    async def send(self, payload: str) -> None:
        self.sent.append(payload)

    async def recv(self) -> str:
        if self._after_terminate and any("Terminate" in payload for payload in self.sent):
            self._messages.extend(self._after_terminate)
            self._after_terminate = []
        if self._messages:
            return self._messages.pop(0)
        raise TimeoutError

    async def close(self) -> None:
        self.closed = True


class _RaisingWS:
    """Connection whose first receive raises the supplied exception."""

    def __init__(self, exc: BaseException):
        self.exc = exc
        self.closed = False

    async def send(self, payload: str) -> None:
        pass

    async def recv(self) -> str:
        raise self.exc

    async def close(self) -> None:
        self.closed = True


class TestAssemblyAIFactory:
    def test_get_batch_provider(self):
        provider = get_batch_provider("assemblyai", {"api_key": "test_key"})
        assert isinstance(provider, AssemblyAIProvider)
        assert provider.name == "assemblyai"

    def test_get_streaming_provider(self):
        provider = get_streaming_provider("assemblyai", {"api_key": "test_key"})
        assert isinstance(provider, AssemblyAIProvider)


class TestAssemblyAIInit:
    def test_defaults(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        assert provider.model == "universal-3-6-pro"
        assert provider.streaming_model == "universal-streaming-english"
        assert provider.api_url == "https://sync.assemblyai.com"
        assert provider.streaming_url == "wss://streaming.assemblyai.com"

    def test_missing_api_key(self):
        old_key = os.environ.pop("ASSEMBLYAI_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="API key"):
                AssemblyAIProvider({})
        finally:
            if old_key is not None:
                os.environ["ASSEMBLYAI_API_KEY"] = old_key


class TestAssemblyAIBatch:
    @pytest.mark.asyncio
    async def test_request_format(self, monkeypatch):
        monkeypatch.delenv("ASSEMBLYAI_API_KEY", raising=False)
        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"text": "hello world"}

        with patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post:
            provider = AssemblyAIProvider({"api_key": "test_key"})
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                tmp.write(b"ID3")
                tmp_path = tmp.name
            try:
                result = await provider.transcribe_file(tmp_path)
            finally:
                os.unlink(tmp_path)

        assert result == "hello world"
        call_args = mock_post.call_args
        assert call_args[0][0] == "https://sync.assemblyai.com/v1/transcribe"
        assert call_args[1]["headers"]["Authorization"] == "test_key"
        assert call_args[1]["headers"]["X-AAI-Model"] == "universal-3-6-pro"
        file_part = call_args[1]["files"]["audio"]
        assert file_part[0] == os.path.basename(tmp_path)
        assert file_part[2] == "audio/mpeg"

    @pytest.mark.asyncio
    async def test_http_error_raises_runtime_error(self, monkeypatch):
        import httpx

        monkeypatch.delenv("ASSEMBLYAI_API_KEY", raising=False)
        request = httpx.Request("POST", "https://sync.assemblyai.com/v1/transcribe")
        response = httpx.Response(401, request=request, text="bad key")
        mock_response = Mock()
        mock_response.status_code = 401
        mock_response.json.side_effect = ValueError("not json")
        mock_response.text = "bad key"
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError("401", request=request, response=response)

        with patch("httpx.AsyncClient.post", return_value=mock_response):
            provider = AssemblyAIProvider({"api_key": "test_key"})
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(b"RIFF")
                tmp_path = tmp.name
            try:
                with pytest.raises(RuntimeError, match="AssemblyAI API error 401"):
                    await provider.transcribe_file(tmp_path)
            finally:
                os.unlink(tmp_path)


class TestAssemblyAIStreaming:
    @pytest.mark.asyncio
    async def test_finalize_concatenates_final_turns(self):
        """A final Turn carries the whole turn, so finals concatenate, not partials."""
        provider = AssemblyAIProvider({"api_key": "test_key"})
        ws = _FakeWS(
            [
                json.dumps({"type": "Begin", "id": "sess-1"}),
                json.dumps({"type": "Turn", "turn_order": 0, "end_of_turn": False, "transcript": "hello"}),
                json.dumps({"type": "Turn", "turn_order": 0, "end_of_turn": True, "transcript": "hello world"}),
                json.dumps({"type": "Turn", "turn_order": 1, "end_of_turn": True, "transcript": "and goodbye"}),
            ]
        )
        provider._ws = ws

        await provider.send_audio(b"\x00\x01")
        # Live text is finalized turns plus the open partial, so it accumulates.
        assert await provider.get_partial_result() == "hello world and goodbye"

        result = await provider.finalize_stream()

        assert result == "hello world and goodbye"
        assert json.loads(ws.sent[-1]) == {"type": "Terminate"}
        assert ws.closed is True
        assert provider._ws is None

    @pytest.mark.asyncio
    async def test_partial_is_returned_when_turn_does_not_end(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        provider._ws = _FakeWS([json.dumps({"type": "Turn", "end_of_turn": False, "transcript": "half a thought"})])

        await provider.send_audio(b"\x00")
        assert await provider.get_partial_result() == "half a thought"

        result = await provider.finalize_stream()
        assert result == "half a thought"

    @pytest.mark.asyncio
    async def test_termination_message_stops_collecting(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        ws = _FakeWS([json.dumps({"type": "Termination", "audio_duration_seconds": 1})])
        provider._ws = ws

        await provider._collect_final_turns()
        assert ws._messages == []

    @pytest.mark.asyncio
    async def test_finalize_drains_turns_sent_after_terminate(self):
        """Final turns arriving only after Terminate must still reach the result."""
        provider = AssemblyAIProvider({"api_key": "test_key"})
        ws = _FakeWS(
            [],
            after_terminate=[
                json.dumps({"type": "Turn", "turn_order": 0, "end_of_turn": True, "transcript": "late words"}),
                json.dumps({"type": "Termination"}),
            ],
        )
        provider._ws = ws

        assert await provider.finalize_stream() == "late words"
        assert json.loads(ws.sent[-1]) == {"type": "Terminate"}

    @pytest.mark.asyncio
    async def test_process_messages_propagates_cancellation(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        provider._ws = _RaisingWS(asyncio.CancelledError())

        with pytest.raises(asyncio.CancelledError):
            await provider._process_messages()

    @pytest.mark.asyncio
    async def test_process_messages_closes_socket_on_error(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        ws = _RaisingWS(ValueError("bad frame"))
        provider._ws = ws

        await provider._process_messages()

        assert ws.closed is True
        assert provider._ws is None

    @pytest.mark.asyncio
    async def test_send_audio_without_session_raises(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        with pytest.raises(RuntimeError, match="Stream not started"):
            await provider.send_audio(b"\x00")

    @pytest.mark.asyncio
    async def test_error_message_is_logged_not_raised(self):
        provider = AssemblyAIProvider({"api_key": "test_key"})
        provider._ws = _FakeWS([json.dumps({"type": "Error", "error": "boom"})])

        await provider.send_audio(b"\x00")
        assert await provider.finalize_stream() == ""
