"""Tests for Deepgram provider."""

import os

import pytest

from voice_to_text.providers import get_batch_provider
from voice_to_text.providers.deepgram import DeepgramProvider


class TestDeepgramProvider:
    def test_get_deepgram_provider(self):
        config = {"api_key": "test_key"}
        provider = get_batch_provider("deepgram", config)
        assert isinstance(provider, DeepgramProvider)
        assert provider.name == "deepgram"

    def test_initialization(self):
        config = {"api_key": "test_key"}
        provider = DeepgramProvider(config)
        assert provider.model == "nova-3"
        assert provider.api_url == "https://api.deepgram.com"

    def test_provider_name_passed_to_resolve(self):
        """Verify provider_name='deepgram' is passed to resolve_api_key."""
        from unittest.mock import patch

        with patch("voice_to_text.providers.deepgram.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = "test_key"
            config = {"api_key": "test_key"}
            DeepgramProvider(config)
            mock_resolve.assert_called_once_with(config, "DEEPGRAM_API_KEY", provider_name="deepgram")

    def test_missing_api_key(self):

        old_key = os.environ.pop("DEEPGRAM_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="api_key"):
                DeepgramProvider({"api_key_source": "env"})
        finally:
            if old_key is not None:
                os.environ["DEEPGRAM_API_KEY"] = old_key

    @pytest.mark.asyncio
    async def test_transcribe_file_request_format(self):
        """Test that transcribe_file sends properly formatted request for local files."""
        import tempfile
        from unittest.mock import Mock, patch

        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"results": {"channels": [{"alternatives": [{"transcript": "hello world"}]}]}}

        # Clear env vars to force config fallback
        with (
            patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post,
            patch.dict(os.environ, {}, clear=True),
        ):
            config = {"api_key": "test_key"}
            provider = DeepgramProvider(config)

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(b"RIFF....WAVEfmt ")
                tmp_path = tmp.name

            try:
                result = await provider.transcribe_file(tmp_path)

                assert mock_post.called
                call_args = mock_post.call_args
                url = call_args[0][0]
                assert url == "https://api.deepgram.com/v1/listen"

                params = call_args[1]["params"]
                assert params["model"] == "nova-3"
                assert params["language"] == "en"

                headers = call_args[1]["headers"]
                assert headers["Authorization"] == "Token test_key"
                assert headers["Content-Type"] == "audio/wav"

                content = call_args[1]["content"]
                assert content is not None
                assert call_args[1]["json"] is None

                assert result == "hello world"
            finally:
                os.unlink(tmp_path)

    @pytest.mark.asyncio
    async def test_transcribe_url_request_format(self):
        """Test that transcribe_file sends properly formatted request for URLs."""
        from unittest.mock import Mock, patch

        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"results": {"channels": [{"alternatives": [{"transcript": "url world"}]}]}}

        # Clear env vars to force config fallback
        with (
            patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post,
            patch.dict(os.environ, {}, clear=True),
        ):
            config = {"api_key": "test_key"}
            provider = DeepgramProvider(config)
            url_path = "https://example.com/audio.wav"

            result = await provider.transcribe_file(url_path)

            assert mock_post.called
            call_args = mock_post.call_args

            headers = call_args[1]["headers"]
            assert headers["Authorization"] == "Token test_key"
            assert "Content-Type" not in headers

            content = call_args[1]["content"]
            assert content is None

            json_data = call_args[1]["json"]
            assert json_data == {"url": url_path}

            assert result == "url world"

    @pytest.mark.asyncio
    async def test_transcribe_defaults(self):
        """Test that default batch_options are applied when none are provided in config."""
        from unittest.mock import Mock, patch

        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {
            "results": {"channels": [{"alternatives": [{"transcript": "default world"}]}]}
        }

        with (
            patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post,
            patch.dict(os.environ, {}, clear=True),
        ):
            # Provide config without batch_options
            config = {"api_key": "test_key"}
            provider = DeepgramProvider(config)

            await provider.transcribe_file("https://example.com/audio.wav")

            params = mock_post.call_args[1]["params"]
            # Check the specifically required defaults from the plan
            assert params["mip_opt_out"] is True, "mip_opt_out should be True by default"
            assert params["filler_words"] is False, "filler_words should be False by default"
            assert params["model"] == "nova-3"

    @pytest.mark.asyncio
    async def test_transcribe_dynamic_params(self):
        """Test that batch_options from config are passed as query params."""
        from unittest.mock import Mock, patch

        mock_response = Mock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"results": {"channels": [{"alternatives": [{"transcript": "param world"}]}]}}

        with (
            patch("httpx.AsyncClient.post", return_value=mock_response) as mock_post,
            patch.dict(os.environ, {}, clear=True),
        ):
            config = {
                "api_key": "test_key",
                "batch_options": {
                    "smart_format": False,
                    "filler_words": True,
                    "mip_opt_out": True,
                    "custom_param": "custom_val",
                },
            }
            provider = DeepgramProvider(config)

            await provider.transcribe_file("https://example.com/audio.wav")

            params = mock_post.call_args[1]["params"]
            assert params["smart_format"] is False
            assert params["filler_words"] is True
            assert params["mip_opt_out"] is True
            assert params["custom_param"] == "custom_val"
            assert params["model"] == "nova-3"
