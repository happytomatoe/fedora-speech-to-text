"""Provider template test CLI: `python -m voice_to_text.provider_test <name>`.

Dry-runs a template provider's request blueprint with sample context, or sends a
real request with `--send --audio <path>`. The authoring feedback loop for
custom providers.
"""

import asyncio
import dataclasses
import json
import logging
import os
import sys
from typing import Any

import httpx

from voice_to_text.config import ConfigManager
from voice_to_text.providers import get_batch_provider
from voice_to_text.providers.template import TemplateProvider

logger = logging.getLogger(__name__)

SAMPLE_WORDS = ["Sample", "Hotword"]

USAGE = """usage: python -m voice_to_text.provider_test <name> [overrides] [--send --audio <path>]

Context overrides (map to template variables):
  --language <code>        LANGUAGE (default: en)
  --custom-words "a,b"     CUSTOM_WORDS as comma-separated list
  --api-key <key>          API_KEY (masked in dry-run output)
  --var NAME=VALUE         override any custom variable from the variables: section
                           (repeatable; VALUE is parsed as JSON, falling back to string)

Dry-runs the rendered request blueprint for a template provider, or with
--send performs the real request against the configured endpoint."""


def _load_manager() -> ConfigManager:
    """Load config from VOICE_TO_TEXT_CONFIG env var if set, else default discovery."""
    path = os.environ.get("VOICE_TO_TEXT_CONFIG")
    return ConfigManager(path) if path else ConfigManager()


def _mask(value: str, ctx: dict[str, Any]) -> str:
    """Mask anything derived from the API key in rendered output."""
    api_key = ctx.get("API_KEY") or ""
    if api_key and api_key in value:
        return value.replace(api_key, "****")
    return value


def _parse_value(raw: str) -> Any:
    """Parse a --var value: JSON when it parses, else the raw string."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _print_blueprint(name: str, provider: TemplateProvider, language: str, words: list[str]) -> None:
    rendered = provider.render(language, words)
    print(f"Provider '{name}' (template)")
    print(f"POST {_mask(provider.endpoint, rendered['ctx'])}")
    if rendered["headers"]:
        print("  headers:")
        for k, v in rendered["headers"].items():
            print(f"    {k}: {_mask(v, rendered['ctx'])}")
    if rendered["fields"]:
        print("  form:")
        seen: set[str] = set()
        for k, v in rendered["fields"]:
            marker = "  (repeated)" if k in seen else ""
            seen.add(k)
            print(f"    {k}: {_mask(v, rendered['ctx'])}{marker}")
    print("  file: <attached on send>")
    print("Use --send --audio <path> to make the actual request.")


@dataclasses.dataclass
class _Args:
    """Parsed CLI state for provider-test."""

    send: bool = False
    audio: str | None = None
    language: str = "en"
    words: list[str] = dataclasses.field(default_factory=lambda: list(SAMPLE_WORDS))
    api_key: str | None = None
    overrides: dict[str, Any] = dataclasses.field(default_factory=dict)
    positional: list[str] = dataclasses.field(default_factory=list)


def _parse_value_flag(parsed: "_Args", flag: str, value: str) -> "_Args | int":
    """Apply one value-taking flag to parsed args; returns exit code on bad input."""
    if flag == "--audio":
        parsed.audio = value
    elif flag == "--language":
        parsed.language = value
    elif flag == "--custom-words":
        parsed.words = [w.strip() for w in value.split(",") if w.strip()]
    elif flag == "--api-key":
        parsed.api_key = value
    else:  # --var NAME=VALUE
        var_name, sep, raw = value.partition("=")
        if not sep or not var_name:
            print(f"--var expects NAME=VALUE, got {value!r}", file=sys.stderr)
            return 2
        parsed.overrides[var_name] = _parse_value(raw)
    return parsed


def _parse_args(args: list[str]) -> "_Args | int":
    """Parse argv. Returns _Args on success or exit code int on usage error."""
    parsed = _Args()
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--send":
            parsed.send = True
        elif arg in ("--audio", "--language", "--custom-words", "--api-key", "--var"):
            i += 1
            if i >= len(args):
                print(USAGE, file=sys.stderr)
                return 2
            result = _parse_value_flag(parsed, arg, args[i])
            if isinstance(result, int):
                return result
        else:
            parsed.positional.append(arg)
        i += 1
    if not parsed.positional or len(parsed.positional) > 1:
        print(USAGE, file=sys.stderr)
        return 2
    return parsed


def _resolve_provider(manager: ConfigManager, name: str, overrides: dict[str, Any]) -> "TemplateProvider | int":
    """Find and instantiate the named template provider, or return an exit code."""
    if name not in manager.config:
        available = [k for k, v in manager.config.items() if isinstance(v, dict) and k != "transcription"]
        print(f"Unknown provider '{name}'. Configured: {available}", file=sys.stderr)
        return 2
    section = manager.get_provider_config(name)
    if section.get("type") != "template":
        print(f"Provider '{name}' is type '{section.get('type')}', not 'template'.", file=sys.stderr)
        return 2
    section = dict(section)
    api_key_override = overrides.pop("API_KEY", None)
    if api_key_override is not None:
        section["api_key"] = api_key_override
    if overrides:
        variables = dict(section.get("variables") or {})
        variables.update(overrides)
        section["variables"] = variables
    try:
        provider = get_batch_provider("template", section)
    except Exception as e:
        print(f"Provider '{name}' failed to initialize: {e}", file=sys.stderr)
        return 1
    assert isinstance(provider, TemplateProvider)
    return provider


def _send(provider: TemplateProvider, audio: str, language: str, words: list[str]) -> int:
    """Send the audio file and print the transcription; returns exit code."""
    try:
        result = asyncio.run(provider.transcribe_file(audio, language, words))
    except httpx.HTTPError as exc:
        print(f"FAILED: request error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    print("Transcription result:")
    print(result)
    return 0


def main(argv: list[str] | None = None) -> int:
    """Run the provider-test CLI; returns the process exit code."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args = list(sys.argv[1:] if argv is None else argv)
    parsed = _parse_args(args)
    if isinstance(parsed, int):
        return parsed
    name = parsed.positional[0]

    overrides: dict[str, Any] = dict(parsed.overrides)
    if parsed.api_key is not None:
        overrides["API_KEY"] = parsed.api_key
    resolved = _resolve_provider(_load_manager(), name, overrides)
    if isinstance(resolved, int):
        return resolved
    provider = resolved

    if not parsed.send:
        _print_blueprint(name, provider, parsed.language, parsed.words)
        return 0

    audio = parsed.audio
    if not audio:
        print("--send requires --audio <path>", file=sys.stderr)
        return 2
    if not os.path.isfile(audio):
        print(f"Audio file not found: {audio}", file=sys.stderr)
        return 2

    return _send(provider, audio, parsed.language, parsed.words)


if __name__ == "__main__":
    sys.exit(main())
