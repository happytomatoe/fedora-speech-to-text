"""Tests for the config-check and provider-test CLIs."""

import os
import tempfile

from voice_to_text.config import ConfigManager
from voice_to_text.config_check import check_config
from voice_to_text.config_check import main as config_check_main
from voice_to_text.provider_test import main as provider_test_main

main = provider_test_main  # shorthand

VALID_TEMPLATE_CONFIG = """
transcription:
  provider: crispasr
crispasr:
  type: template
  endpoint: http://localhost:5092/v1/audio/transcriptions
  model: whisper-1
  headers:
    Authorization: "Bearer {{ API_KEY }}"
  form:
    model: "{{ MODEL }}"
    hotwords: "{{ CUSTOM_WORDS | join(', ') }}"
    hotwords_boost: "2.0"
  response_text_path: text
"""

BROKEN_TEMPLATE_CONFIG = """
transcription:
  provider: crispasr
crispasr:
  type: template
  form:
    hotwords: "{{ CUSTOM_WORDS | join(', ')"   # unterminated Jinja block
"""

MISSING_ENDPOINT_CONFIG = """
transcription:
  provider: crispasr
crispasr:
  type: template
  form:
    hotwords: "{{ CUSTOM_WORDS }}"
"""

DANGLING_PROVIDER_CONFIG = """
transcription:
  provider: nosuch
crispasr:
  type: template
  endpoint: http://localhost:5092
  form:
    model: m
"""


def _write_config(content: str, monkeypatch=None) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(content)
        path = f.name
    if monkeypatch is not None:
        monkeypatch.setenv("VOICE_TO_TEXT_CONFIG", path)
    return path


class TestCheckConfig:
    def test_valid_template_config_clean(self, monkeypatch):
        path = _write_config(VALID_TEMPLATE_CONFIG, monkeypatch)
        try:
            assert check_config(ConfigManager(path)) == []
        finally:
            os.unlink(path)

    def test_broken_jinja_template_found(self, monkeypatch):
        path = _write_config(BROKEN_TEMPLATE_CONFIG, monkeypatch)
        try:
            findings = check_config(ConfigManager(path))
            assert any("template error" in f and "hotwords" in f for f in findings)
        finally:
            os.unlink(path)

    def test_missing_endpoint_found(self, monkeypatch):
        path = _write_config(MISSING_ENDPOINT_CONFIG, monkeypatch)
        try:
            findings = check_config(ConfigManager(path))
            assert any("missing 'endpoint'" in f for f in findings)
        finally:
            os.unlink(path)

    def test_dangling_selected_provider_found(self, monkeypatch):
        path = _write_config(DANGLING_PROVIDER_CONFIG, monkeypatch)
        try:
            findings = check_config(ConfigManager(path))
            assert any("'nosuch' has no config section" in f for f in findings)
        finally:
            os.unlink(path)


class TestConfigCheckMain:
    def test_main_returns_1_on_load_failure(self, monkeypatch):
        monkeypatch.setattr(
            "voice_to_text.config_check.ConfigManager",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("no config")),
        )
        assert config_check_main() == 1


class TestProviderTestMain:
    def test_unknown_provider_exit_2(self, capsys, monkeypatch):
        path = _write_config(VALID_TEMPLATE_CONFIG, monkeypatch)
        try:
            from voice_to_text.provider_test import main

            assert main(["nonexistent"]) == 2  # type: ignore[arg-type]
        finally:
            os.unlink(path)

    def test_send_without_audio_exit_2(self, capsys, monkeypatch):
        path = _write_config(VALID_TEMPLATE_CONFIG, monkeypatch)
        try:
            assert main(["crispasr", "--send"]) == 2  # type: ignore[arg-type]
        finally:
            os.unlink(path)

    def test_send_with_missing_audio_file_exit_2(self, capsys, monkeypatch):
        path = _write_config(VALID_TEMPLATE_CONFIG, monkeypatch)
        try:
            assert main(["crispasr", "--send", "--audio", "/nonexistent/file.wav"]) == 2  # type: ignore[arg-type]
        finally:
            os.unlink(path)

    def test_no_args_exit_2(self, monkeypatch):
        assert main([]) == 2  # type: ignore[arg-type]

    def test_non_template_provider_rejected(self, monkeypatch):
        path = _write_config(
            """
transcription:
  provider: parakeet
parakeet:
  type: builtin
  http_endpoint: http://localhost:5092
"""
        )
        try:
            assert main(["parakeet"]) == 2  # type: ignore[arg-type]
        finally:
            os.unlink(path)

    def test_dry_run_prints_blueprint(self, capsys, monkeypatch):
        path = _write_config(VALID_TEMPLATE_CONFIG, monkeypatch)
        try:
            assert main(["crispasr"]) == 0  # type: ignore[arg-type]
        finally:
            os.unlink(path)
        out = capsys.readouterr().out
        assert "Provider 'crispasr' (template)" in out
        assert "POST http://localhost:5092/v1/audio/transcriptions" in out
        assert "hotwords: Sample, Hotword" in out
        assert "hotwords_boost: 2.0" in out

    def test_dry_run_masks_api_key(self, capsys, monkeypatch):
        path = _write_config(
            VALID_TEMPLATE_CONFIG.replace(
                "  endpoint: http://localhost:5092/v1/audio/transcriptions",
                "  endpoint: http://localhost:5092/v1/audio/transcriptions\n  api_key: super-secret-key-123",
            ),
            monkeypatch,
        )
        try:
            assert main(["crispasr"]) == 0  # type: ignore[arg-type]
        finally:
            os.unlink(path)
        out = capsys.readouterr().out
        assert "Bearer ****" in out
        assert "super-secret-key-123" not in out

    def test_words_override(self, capsys, monkeypatch):
        path = _write_config(VALID_TEMPLATE_CONFIG, monkeypatch)
        try:
            assert main(["crispasr", "--words", "ROCm,Kubernetes"]) == 0  # type: ignore[arg-type]
        finally:
            os.unlink(path)
        assert "hotwords: ROCm, Kubernetes" in capsys.readouterr().out

    def test_send_against_local_server(self, capsys, monkeypatch, httpserver, tmp_path):
        wav = tmp_path / "test.wav"
        wav.write_bytes(b"RIFF....WAVEfmt ")
        httpserver.expect_request("/v1/audio/transcriptions", method="POST").respond_with_json(
            {"text": "hello from stub"}
        )
        path = _write_config(
            VALID_TEMPLATE_CONFIG.replace(
                "http://localhost:5092/v1/audio/transcriptions", httpserver.url_for("/v1/audio/transcriptions")
            ),
            monkeypatch,
        )
        try:
            assert main(["crispasr", "--send", "--audio", str(wav)]) == 0  # type: ignore[arg-type]
        finally:
            os.unlink(path)
        assert "hello from stub" in capsys.readouterr().out
