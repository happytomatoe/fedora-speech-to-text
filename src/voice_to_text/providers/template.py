"""Template-based transcription provider (batch only).

The HTTP request is described declaratively in config.yaml as a Jinja2-templated
blueprint. Context variables available in templates: API_KEY, LANGUAGE,
CUSTOM_WORDS, MODEL.

Project docs: docs/providers/template.md
"""

import logging
import os
from typing import Any

import httpx
from jinja2 import Environment, Template
from jinja2.nativetypes import NativeEnvironment

from .base import BatchProvider, get_shared_client, resolve_api_key

logger = logging.getLogger(__name__)


def _dig(obj: Any, dotted: str) -> Any:
    """Walk a dotted path ('result.transcript' or 'segments.0.text') through nested dicts/lists."""
    for part in dotted.split("."):
        if isinstance(obj, list) and part.lstrip("-").isdigit():
            obj = obj[int(part)]
        elif isinstance(obj, dict):
            obj = obj[part]
        else:
            raise TypeError(f"cannot descend into {type(obj).__name__} at '{part}'")
    return obj


class TemplateProvider(BatchProvider):
    """Generic batch provider driven by a Jinja2-templated request blueprint.

    Config keys:
        endpoint (required): full URL to POST the audio to.
        form: multipart form fields (values are templates, rendered to str).
        json: JSON body fields (values are templates, rendered to native types).
        headers: request headers (values are templates).
        response_text_path: dotted path to the transcript in the response (default "text").
        model: value exposed to templates as MODEL (not sent unless templated).
        api_key / api_key_env: resolved via resolve_api_key, exposed as API_KEY.
        timeout: request timeout in seconds (default 120).
    """

    def __init__(self, config: dict[str, Any]):
        """Initialize the template provider from the request blueprint config."""
        if not config.get("endpoint"):
            raise ValueError("template provider requires 'endpoint'")
        if not (config.get("form") or config.get("json")):
            raise ValueError("template provider requires 'form' or 'json' request body")
        self.spec = config
        self.endpoint = config["endpoint"]
        self.timeout = config.get("timeout", 120.0)
        self.text_path = config.get("response_text_path", "text")
        wants_key = bool(config.get("api_key") or config.get("api_key_env"))
        self.api_key = resolve_api_key(config, "TEMPLATE_API_KEY", provider_name="template") if wants_key else ""
        # NativeEnvironment renders {{ CUSTOM_WORDS }} to a real list in JSON bodies
        self.env: Environment = NativeEnvironment()
        # Headers templating on an unset API_KEY (e.g. "Bearer {{ API_KEY }}")
        # would render to "Bearer " — an illegal header. Skip those entirely.
        self._header_tmpl: dict[str, Template] = {
            k: self.env.from_string(str(v))
            for k, v in config.get("headers", {}).items()
            if not (self.api_key == "" and "API_KEY" in str(v))
        }
        self._form_tmpl: dict[str, Template] = {
            k: self.env.from_string(str(v)) for k, v in config.get("form", {}).items()
        }
        self._json_tmpl: dict[str, tuple[bool, Any]] = {
            k: (True, self.env.from_string(v)) if isinstance(v, str) else (False, v)
            for k, v in config.get("json", {}).items()
        }
        self._client = get_shared_client()
        logger.info("Template provider: %s (timeout=%.0fs)", self.endpoint, self.timeout)

    def render(self, language: str = "en", custom_words: list[str] | None = None) -> dict[str, Any]:
        """Render the blueprint. Side-effect free; shared by transcribe_file and provider-test."""
        ctx = {
            "API_KEY": self.api_key,
            "LANGUAGE": language,
            "CUSTOM_WORDS": list(custom_words or []),
            "MODEL": self.spec.get("model", ""),
        }
        # The audio file forces multipart encoding, so `json` fields ride along as
        # additional multipart form fields; list values become repeated keys.
        fields: list[tuple[str, str]] = [(k, str(t.render(**ctx))) for k, t in self._form_tmpl.items()]
        for k, (is_tmpl, tmpl) in self._json_tmpl.items():
            value = tmpl.render(**ctx) if is_tmpl else tmpl
            if isinstance(value, list):
                fields.extend((k, str(item)) for item in value)
            else:
                fields.append((k, str(value)))
        return {
            "headers": {k: t.render(**ctx) for k, t in self._header_tmpl.items()},
            "fields": fields,
            "ctx": ctx,
        }

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe an audio file by POSTing it to the templated endpoint."""
        rendered = self.render(language, custom_words)
        # httpx AsyncClient rejects list-of-tuples `data=` payloads (mis-detects
        # them as a sync stream, httpx #3471) — pass a dict instead.
        data = dict(rendered["fields"])
        with open(audio_path, "rb") as f:
            files = {"file": (os.path.basename(audio_path), f, "audio/wav")}
            logger.info("Template POST %s (%d form fields)", self.endpoint, len(rendered["fields"]))
            try:
                response = await self._client.post(
                    self.endpoint,
                    headers=rendered["headers"],
                    data=data,
                    files=files,
                    timeout=self.timeout,
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as e:
                status = e.response.status_code if e.response is not None else "?"
                logger.error("Template provider error: HTTP %s for %s", status, self.endpoint)
                if e.response is not None:
                    logger.error("Response body: %s", e.response.text[:1000])
                raise
        try:
            result = str(_dig(response.json(), self.text_path)).strip()
        except (KeyError, TypeError, IndexError, ValueError) as e:
            raise RuntimeError(
                f"response_text_path '{self.text_path}' not found in response: {response.text[:500]}"
            ) from e
        logger.info("Transcription result: %s", result[:100])
        return result

    @property
    def name(self) -> str:
        """Return the provider name."""
        return "template"

    async def close(self) -> None:
        """No persistent resources to close."""
        pass
