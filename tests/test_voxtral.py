"""Tests for Voxtral provider."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from voice_to_text.providers import get_batch_provider
from voice_to_text.providers.voxtral import VoxtralProvider


class TestVoxtralProvider:
    def test_get_voxtral_provider(self):
        config = {"api_key": "test_key", "model": "voxtral-mini-latest"}
        provider = get_batch_provider("voxtral", config)
        assert isinstance(provider, VoxtralProvider)
        assert provider.name == "voxtral"

    def test_initialization(self):
        config = {"api_key": "test_key"}
        provider = VoxtralProvider(config)
        assert provider.model == "voxtral-mini-latest"
        assert provider._api_url == "https://api.mistral.ai"

    def test_provider_name_passed_to_resolve(self):
        """Verify provider_name='voxtral' is passed to resolve_api_key."""
        from unittest.mock import patch

        with patch("voice_to_text.providers.voxtral.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = "test_key"
            config = {"api_key": "test_key"}
            VoxtralProvider(config)
            mock_resolve.assert_called_once_with(
                config, "VOXTRAL_API_KEY", extra_envs=("MISTRAL_API_KEY",), provider_name="voxtral"
            )

    def test_missing_api_key(self):
        # Unset the environment variables for this test
        import os

        old_voxtral_key = os.environ.pop("VOXTRAL_API_KEY", None)
        old_mistral_key = os.environ.pop("MISTRAL_API_KEY", None)
        try:
            with pytest.raises(ValueError, match="API key"):
                VoxtralProvider({"api_key_source": "env"})
        finally:
            if old_voxtral_key is not None:
                os.environ["VOXTRAL_API_KEY"] = old_voxtral_key
            if old_mistral_key is not None:
                os.environ["MISTRAL_API_KEY"] = old_mistral_key

    @pytest.mark.asyncio
    async def test_transcribe_file_request_format(self):
        """Test that transcribe_file sends properly formatted request."""
        import os
        import tempfile

        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"text": "test transcription"}

        config = {"api_key": "test_key"}
        provider = VoxtralProvider(config)

        captured: dict = {}

        async def _fake_post(url: str, **kwargs: object) -> MagicMock:
            captured["url"] = url
            captured.update(kwargs)  # type: ignore[arg-type]
            return mock_response

        mock_client = AsyncMock()
        mock_client.post = _fake_post
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        # Create a temporary audio file for testing
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(b"RIFF....WAVEfmt ")  # Minimal WAV header
            tmp_path = tmp.name

        try:
            with patch("voice_to_text.providers.voxtral.httpx.AsyncClient", return_value=mock_client):
                result = await provider.transcribe_file(tmp_path)

            # Check URL
            assert captured["url"] == "https://api.mistral.ai/v1/audio/transcriptions"

            # Check headers
            headers = captured["headers"]
            assert headers["Authorization"] == "Bearer test_key"

            # Check files parameter
            files = captured["files"]
            assert "file" in files
            file_tuple = files["file"]
            assert len(file_tuple) == 2  # Should be (filename, file_object)
            assert file_tuple[0] == os.path.basename(tmp_path)

            # Check data parameter
            data = captured["data"]
            assert data["model"] == "voxtral-mini-latest"
            assert data["language"] == "en"

            # Check result
            assert result == "test transcription"

        finally:
            os.unlink(tmp_path)
