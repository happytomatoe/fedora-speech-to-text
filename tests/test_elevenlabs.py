"""Tests for ElevenLabs Scribe provider."""

import os
import tempfile
from unittest.mock import Mock, patch

import pytest

from voice_to_text.providers import get_batch_provider
from voice_to_text.providers.elevenlabs import ElevenLabsProvider


class TestElevenLabsProvider:
    def test_get_elevenlabs_provider(self):
        provider = get_batch_provider("elevenlabs", {"api_key": "test_key"})
        assert isinstance(provider, ElevenLabsProvider)
        assert provider.name == "elevenlabs"

    @pytest.mark.asyncio
    async def test_transcribe_file_request_format(self):
        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"text": "hello world", "language_code": "eng"}

        with patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post:
            provider = ElevenLabsProvider({"api_key": "test_key"})
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(b"RIFF....WAVEfmt ")
                tmp_path = tmp.name
            try:
                result = await provider.transcribe_file(tmp_path)
                assert mock_post.called
                call_args = mock_post.call_args
                assert call_args[0][0] == "https://api.elevenlabs.io/v1/speech-to-text"
                headers = call_args[1]["headers"]
                assert headers["xi-api-key"] == "test_key"
                # httpx multipart: form fields are in `data`, file in `files`
                data = call_args[1]["data"]
                assert data["model_id"] == "scribe_v2"
                assert data["tag_audio_events"] == "false"
                assert data["language_code"] == "en"  # default "en" is forwarded (ISO-639-1)
                assert call_args[1]["files"]["file"] is not None
                assert result == "hello world"
            finally:
                os.unlink(tmp_path)
