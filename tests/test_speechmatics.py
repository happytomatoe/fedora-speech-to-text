"""Tests for the Speechmatics provider."""

import json
import os
import tempfile

import httpx
import pytest

from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.providers.speechmatics import SpeechmaticsProvider


class _FakeWS:
    """Minimal stand-in for a websockets client connection."""

    def __init__(self, messages: list[str]):
        self._messages = list(messages)
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, payload: str | bytes) -> None:
        if isinstance(payload, bytes):
            return
        data = json.loads(payload)
        self.sent.append(data)
        if data.get("message") == "EndOfStream":
            self._messages.append(json.dumps({"message": "EndOfTranscript"}))

    async def recv(self) -> str:
        if self._messages:
            return self._messages.pop(0)
        raise TimeoutError

    async def close(self) -> None:
        self.closed = True


def _provider(**config) -> SpeechmaticsProvider:
    return SpeechmaticsProvider({"api_key": "test-key", **config})


def _stream_messages(*payloads: dict) -> list[str]:
    return [json.dumps(payload) for payload in payloads]


def _transcript_payload(text: str, *, partial: bool = False) -> dict:
    return {
        "message": "AddPartialTranscript" if partial else "AddTranscript",
        "metadata": {"transcript": text},
    }


class TestSpeechmaticsFactory:
    def test_get_batch_provider(self):
        provider = get_batch_provider("speechmatics", {"api_key": "test_key"})
        assert isinstance(provider, SpeechmaticsProvider)
        assert provider.name == "speechmatics"

    def test_get_streaming_provider(self):
        provider = get_streaming_provider("speechmatics", {"api_key": "test_key"})
        assert isinstance(provider, SpeechmaticsProvider)


class TestSpeechmaticsInit:
    def test_defaults(self):
        provider = _provider()
        assert provider.model == "enhanced"
        assert provider.api_url == "https://eu1.asr.api.speechmatics.com/v2"
        assert provider.realtime_url == "wss://eu2.rt.speechmatics.com/v2"

    def test_missing_api_key(self):
        old_key = os.environ.pop("SPEECHMATICS_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="API key"):
                SpeechmaticsProvider({})
        finally:
            if old_key is not None:
                os.environ["SPEECHMATICS_API_KEY"] = old_key


class TestSpeechmaticsBatch:
    async def test_transcribe_file_polls_and_returns_text(self, monkeypatch):
        seen: list[httpx.Request] = []
        statuses = iter(["running", "done"])

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.method == "POST":
                return httpx.Response(201, json={"id": "job-1"})
            if request.url.path.endswith("/transcript"):
                return httpx.Response(200, text="  hello world  ")
            return httpx.Response(200, json={"job": {"id": "job-1", "status": next(statuses)}})

        monkeypatch.setattr("asyncio.sleep", _no_sleep)
        provider = _provider(poll_interval=0)
        provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
                text = await provider.transcribe_file(audio.name, language="en", custom_words=["Kubernetes"])
        finally:
            await provider._client.aclose()

        assert text == "hello world"
        submit = seen[0]
        assert submit.url.path == "/v2/jobs/"
        assert submit.headers["authorization"] == "Bearer test-key"
        assert b'"model": "enhanced"' in submit.content
        assert b'"language": "en"' in submit.content
        assert b'"additional_vocab": [{"content": "Kubernetes"}]' in submit.content
        transcript = seen[-1]
        assert transcript.url.path == "/v2/jobs/job-1/transcript"
        assert transcript.url.params["format"] == "txt"

    async def test_rejected_job_raises(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST":
                return httpx.Response(201, json={"id": "job-1"})
            return httpx.Response(200, json={"job": {"id": "job-1", "status": "rejected", "error": "bad audio"}})

        monkeypatch.setattr("asyncio.sleep", _no_sleep)
        provider = _provider(poll_interval=0)
        provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            with (
                tempfile.NamedTemporaryFile(suffix=".wav") as audio,
                pytest.raises(RuntimeError, match="rejected: bad audio"),
            ):
                await provider.transcribe_file(audio.name)
        finally:
            await provider._client.aclose()


class TestSpeechmaticsStreaming:
    async def test_stream_protocol_and_transcript(self):
        provider = _provider(streaming_options={"additional_vocab": [{"content": "Kubernetes"}]})
        ws = _FakeWS(
            _stream_messages(
                {"message": "RecognitionStarted", "id": "session-1"},
                _transcript_payload("hello", partial=True),
                _transcript_payload("hello world"),
                _transcript_payload("again", partial=True),
            )
        )

        async def connect(ws_url: str, headers: dict[str, str]) -> None:
            provider._ws = ws
            assert ws_url == "wss://eu2.rt.speechmatics.com/v2"
            assert headers == {"Authorization": "Bearer test-key"}

        provider._connect_ws = connect
        await provider.start_stream(language="en", sample_rate=16000)
        await provider.send_audio(b"\x00\x01")

        start = ws.sent[0]
        assert start["message"] == "StartRecognition"
        assert start["audio_format"] == {"type": "raw", "encoding": "pcm_s16le", "sample_rate": 16000}
        assert start["transcription_config"]["model"] == "enhanced"
        assert start["transcription_config"]["language"] == "en"
        assert start["transcription_config"]["enable_partials"] is True
        assert start["transcription_config"]["additional_vocab"] == [{"content": "Kubernetes"}]
        assert await provider.get_partial_result() == "hello world again"

        text = await provider.finalize_stream()
        assert text == "hello world again"
        assert ws.sent[-1] == {"message": "EndOfStream"}
        assert ws.closed is True


async def _no_sleep(seconds: float) -> None:
    del seconds
