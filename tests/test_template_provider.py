"""Tests for the template-based transcription provider."""

from pathlib import Path

import httpx
import pytest

from voice_to_text.providers import get_batch_provider
from voice_to_text.providers.template import TemplateProvider

WAV_FIXTURE = str(Path(__file__).parents[1] / "e2e" / "fixtures" / "test-01-weather.wav")


def _make_wav(tmp_path: Path) -> str:
    path = tmp_path / "test.wav"
    path.write_bytes(b"RIFF....WAVEfmt ")  # content irrelevant; server is mocked
    return str(path)


CRISPASR_CONFIG = {
    "type": "template",
    "endpoint": "http://stub/v1/audio/transcriptions",
    "model": "whisper-1",
    "form": {
        "model": "{{ MODEL }}",
        "hotwords": "{{ CUSTOM_WORDS | join(', ') }}",
        "hotwords_boost": "2.0",
    },
    "response_text_path": "text",
}


class TestConfigValidation:
    def test_missing_endpoint_raises(self):
        with pytest.raises(ValueError, match="endpoint"):
            TemplateProvider({"form": {"model": "x"}})

    def test_missing_body_raises(self):
        with pytest.raises(ValueError, match="'form' or 'json'"):
            TemplateProvider({"endpoint": "http://stub"})

    def test_registry_entry(self):
        provider = get_batch_provider("template", CRISPASR_CONFIG)
        assert isinstance(provider, TemplateProvider)
        assert provider.name == "template"


class TestRender:
    def test_form_comma_join(self):
        provider = TemplateProvider(CRISPASR_CONFIG)
        rendered = provider.render("en", ["Kubernetes", "ROCm"])
        assert dict(rendered["fields"])["hotwords"] == "Kubernetes, ROCm"
        assert dict(rendered["fields"])["model"] == "whisper-1"
        assert dict(rendered["fields"])["hotwords_boost"] == "2.0"

    def test_empty_custom_words(self):
        provider = TemplateProvider(CRISPASR_CONFIG)
        rendered = provider.render("en", [])
        assert dict(rendered["fields"])["hotwords"] == ""

    def test_json_section_repeated_keys(self):
        provider = TemplateProvider(
            {
                "endpoint": "http://stub",
                "json": {"keyterms": "{{ CUSTOM_WORDS }}", "model_id": "scribe_v2"},
            }
        )
        rendered = provider.render("en", ["alpha", "beta"])
        assert rendered["fields"] == [
            ("keyterms", "alpha"),
            ("keyterms", "beta"),
            ("model_id", "scribe_v2"),
        ]

    def test_headers_with_key(self):
        provider = TemplateProvider(
            {
                "endpoint": "http://stub",
                "api_key": "sk-secret",
                "headers": {"Authorization": "Bearer {{ API_KEY }}"},
                "form": {"model": "{{ MODEL }}"},
            }
        )
        rendered = provider.render()
        assert rendered["headers"]["Authorization"] == "Bearer sk-secret"

    def test_no_key_no_headers(self):
        provider = TemplateProvider({"endpoint": "http://stub", "form": {"model": "m"}})
        rendered = provider.render()
        assert rendered["headers"] == {}
        assert rendered["ctx"]["API_KEY"] == ""

    def test_no_leftover_template_markers(self):
        provider = TemplateProvider(CRISPASR_CONFIG)
        rendered = provider.render("en", ["x"])
        for value in rendered["headers"].values():
            assert "{{" not in str(value)
            assert "}}" not in str(value)
        for _key, value in rendered["fields"]:
            assert "{{" not in value
            assert "}}" not in value


def _last_form(httpserver) -> dict[str, str]:
    """Return decoded multipart form of the last request the real server received."""
    return httpserver.log[-1][0].form.to_dict()


def _last_headers(httpserver) -> dict[str, str]:
    return dict(httpserver.log[-1][0].headers)


class TestTranscribeFile:
    @pytest.mark.asyncio
    async def test_happy_path_multipart(self, httpserver, tmp_path):
        # NOTE: pytest-httpserver `data=` matches raw body bytes, which never
        # matches multipart (random boundary) — match uri+method, then assert
        # the decoded form fields from the server log.
        httpserver.expect_request("/v1/audio/transcriptions", method="POST").respond_with_json(
            {"text": "  Hello world.  "}
        )
        config = dict(CRISPASR_CONFIG, endpoint=httpserver.url_for("/v1/audio/transcriptions"))
        provider = TemplateProvider(config)
        result = await provider.transcribe_file(_make_wav(tmp_path), "en", ["ROCm", "Kubernetes"])
        assert result == "Hello world."
        form = _last_form(httpserver)
        assert form["model"] == "whisper-1"
        assert form["hotwords"] == "ROCm, Kubernetes"
        assert form["hotwords_boost"] == "2.0"

    @pytest.mark.asyncio
    async def test_json_section_repeated_keys_on_wire(self, httpserver, tmp_path):
        """Array values from the json section must arrive as repeated multipart keys."""
        httpserver.expect_request("/recognize", method="POST").respond_with_json(
            {"result": {"transcript": "nested text"}}
        )
        provider = TemplateProvider(
            {
                "endpoint": httpserver.url_for("/recognize"),
                "json": {"keyterms": "{{ CUSTOM_WORDS }}"},
                "response_text_path": "result.transcript",
            }
        )
        result = await provider.transcribe_file(_make_wav(tmp_path), "en", ["alpha"])
        assert result == "nested text"
        form = _last_form(httpserver)
        assert form["keyterms"] == "alpha"

    @pytest.mark.asyncio
    async def test_auth_header_sent(self, httpserver, tmp_path):
        httpserver.expect_request(
            "/v1/audio/transcriptions",
            method="POST",
            headers={"Authorization": "Bearer sk-live"},
        ).respond_with_json({"text": "ok"})
        provider = TemplateProvider(
            {
                "endpoint": httpserver.url_for("/v1/audio/transcriptions"),
                "api_key": "sk-live",
                "headers": {"Authorization": "Bearer {{ API_KEY }}"},
                "form": {"model": "m"},
            }
        )
        assert await provider.transcribe_file(_make_wav(tmp_path)) == "ok"
        assert _last_headers(httpserver).get("Authorization") == "Bearer sk-live"

    @pytest.mark.asyncio
    async def test_no_auth_header_when_no_key(self, httpserver, tmp_path):
        httpserver.expect_request("/v1/audio/transcriptions", method="POST").respond_with_json({"text": "ok"})
        provider = TemplateProvider(
            {"endpoint": httpserver.url_for("/v1/audio/transcriptions"), "form": {"model": "m"}}
        )
        assert await provider.transcribe_file(_make_wav(tmp_path)) == "ok"
        assert "Authorization" not in _last_headers(httpserver)

    @pytest.mark.asyncio
    async def test_http_error_raises_with_context(self, httpserver, tmp_path):
        httpserver.expect_request("/v1/audio/transcriptions", method="POST").respond_with_json(
            {"error": {"message": "bad key"}}, status=401
        )
        provider = TemplateProvider(
            {
                "endpoint": httpserver.url_for("/v1/audio/transcriptions"),
                "api_key": "wrong",
                "headers": {"Authorization": "Bearer {{ API_KEY }}"},
                "form": {"model": "m"},
            }
        )
        with pytest.raises(httpx.HTTPStatusError, match="401"):
            await provider.transcribe_file(_make_wav(tmp_path))

    @pytest.mark.asyncio
    async def test_missing_text_path_raises_with_snippet(self, httpserver, tmp_path):
        httpserver.expect_request("/x", method="POST").respond_with_json({"result": {"transcript": "hi"}})
        provider = TemplateProvider({"endpoint": httpserver.url_for("/x"), "form": {"m": "1"}})
        with pytest.raises(RuntimeError, match="response_text_path 'text'") as exc_info:
            await provider.transcribe_file(_make_wav(tmp_path))
        assert "transcript" in str(exc_info.value)  # response snippet included

    @pytest.mark.asyncio
    async def test_real_wav_against_stub(self, httpserver):
        """End-to-end provider call with a real fixture WAV through a real HTTP server."""
        httpserver.expect_request("/v1/audio/transcriptions", method="POST").respond_with_json(
            {"text": "The weather today is sunny with a high of 75 degrees."}
        )
        provider = TemplateProvider(
            {
                "endpoint": httpserver.url_for("/v1/audio/transcriptions"),
                "form": {"model": "{{ MODEL }}", "model_value": "parakeet"},
                "model": "parakeet-tdt-0.6b",
            }
        )
        assert "sunny" in await provider.transcribe_file(WAV_FIXTURE)
