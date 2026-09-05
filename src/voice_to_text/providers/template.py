"""Template-based transcription provider (batch only).

The HTTP request is described declaratively in config.yaml as a Jinja2-templated
blueprint. Context variables available in templates: API_KEY, LANGUAGE,
CUSTOM_WORDS, plus any custom variables defined per-provider in the
"variables" config section.

Project docs: docs/providers/add-custom-provider.md
"""

import logging
import os
from typing import Any

import httpx
from jinja2 import ChainableUndefined, Environment, Template
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
        variables: custom key/value pairs exposed to templates (values must be scalars).
        api_key / api_key_env: resolved via resolve_api_key, exposed as API_KEY.
    """

    def __init__(self, config: dict[str, Any]):
        """Initialize the template provider from the request blueprint config."""
        if not config.get("endpoint"):
            raise ValueError("template provider requires 'endpoint'")
        if not (config.get("form") or config.get("json")):
            raise ValueError("template provider requires 'form' or 'json' request body")
        self.spec = config
        self.endpoint = config["endpoint"]
        self.text_path = config.get("response_text_path", "text")
        self._variables = self._validate_variables(config.get("variables", {}))
        wants_key = bool(config.get("api_key") or config.get("api_key_env"))
        self.api_key = resolve_api_key(config, "TEMPLATE_API_KEY", provider_name="template") if wants_key else ""
        # NativeEnvironment renders {{ CUSTOM_WORDS }} to a real list in JSON bodies
        self.env: Environment = NativeEnvironment()

        def _usable_header(source: str) -> bool:
            # Key configured → always usable. Without a key, render with
            # API_KEY as a sentinel (ChainableUndefined keeps fallbacks like
            # `{{ API_KEY or 'public' }}` and `{% if API_KEY %}` working —
            # StrictUndefined would raise on the truthiness check and drop
            # legitimate no-key-friendly headers). If the sentinel survives
            # into the output, the header depends on a bare unresolved
            # API_KEY → skip it (an unfilled "Bearer " would be an illegal
            # header value).
            if self.api_key != "":
                return True
            if "API_KEY" not in source:
                return True
            sentinel = "__UNRESOLVED_API_KEY__"
            env = NativeEnvironment(undefined=ChainableUndefined)
            rendered = str(
                env.from_string(source).render(API_KEY=sentinel, LANGUAGE="", CUSTOM_WORDS=[])
            )
            return sentinel not in rendered and rendered.strip() != ""

        self._header_tmpl: dict[str, Template] = {
            k: self.env.from_string(v) for k, v in config.get("headers", {}).items() if _usable_header(str(v))
        }
        self._form_tmpl: dict[str, Template] = {
            k: self.env.from_string(str(v)) for k, v in config.get("form", {}).items()
        }
        self._json_tmpl: dict[str, tuple[bool, Any]] = {
            k: (True, self.env.from_string(v)) if isinstance(v, str) else (False, v)
            for k, v in config.get("json", {}).items()
        }
        self._client = get_shared_client()
        logger.info("Template provider: %s", self.endpoint)

    _RESERVED_VARIABLES = ("API_KEY", "LANGUAGE", "CUSTOM_WORDS")

    @staticmethod
    def _validate_variables(variables: Any) -> dict[str, Any]:
        """Validate the ``variables`` section, failing fast on misuse."""
        if not isinstance(variables, dict):
            raise ValueError("template provider 'variables' must be a mapping")
        for name, value in variables.items():
            if not isinstance(name, str) or not name:
                raise ValueError("template provider 'variables' keys must be non-empty strings")
            if name in TemplateProvider._RESERVED_VARIABLES:
                raise ValueError(
                    f"template provider variable '{name}' conflicts with a built-in template variable"
                )
            if not isinstance(value, (str, int, float, bool)):
                raise ValueError(
                    f"template provider variable '{name}' must be a scalar (str/int/float/bool)"
                )
        return dict(variables)

    def render(self, language: str = "en", custom_words: list[str] | None = None) -> dict[str, Any]:
        """Render the blueprint. Side-effect free; shared by transcribe_file and provider-test."""
        ctx = {
            **self._variables,
            "API_KEY": self.api_key,
            "LANGUAGE": language,
            "CUSTOM_WORDS": list(custom_words or []),
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
        # them as a sync stream, httpx #3471) — pass a dict instead. Repeated
        # keys (list-valued json fields) can't live in a dict, so they ride in
        # `files=` as (name, (None, value)) tuples, which httpx encodes as
        # additional multipart fields.
        data: dict[str, str] = {}
        repeated: list[tuple[str, tuple[None, str]]] = []
        seen: set[str] = set()
        for k, v in rendered["fields"]:
            if k in seen:
                repeated.append((k, (None, v)))
            else:
                seen.add(k)
                data[k] = v
        with open(audio_path, "rb") as f:
            files: list[tuple[str, Any]] = [("file", (os.path.basename(audio_path), f, "audio/wav"))]
            files.extend(repeated)
            logger.info("Template POST %s (%d form fields)", self.endpoint, len(rendered["fields"]))
            try:
                response = await self._client.post(
                    self.endpoint,
                    headers=rendered["headers"],
                    data=data,
                    files=files,
                    timeout=120.0,
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
