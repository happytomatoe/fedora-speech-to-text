"""Config validation CLI: `python -m voice_to_text.config_check`.

Dry validation of config.yaml — no network, no API key resolution side effects.
Exit 0 if clean, 1 otherwise.
"""

import logging
import os
import sys
from typing import Any

from jinja2 import TemplateError
from jinja2.nativetypes import NativeEnvironment

from voice_to_text.config import ConfigManager
from voice_to_text.providers import get_batch_provider

_NATIVE_ENV = NativeEnvironment()

logger = logging.getLogger(__name__)

VALID_TEMPLATE_KEYS = {
    "type",
    "endpoint",
    "form",
    "json",
    "headers",
    "response_text_path",
    "model",
    "api_key",
    "api_key_env",
    "timeout",
}


def _compile_template(provider: str, location: str, value: str) -> list[str]:
    """Try compiling one template value; return a finding on failure."""
    try:
        _NATIVE_ENV.from_string(value)
    except TemplateError as e:
        return [f"provider '{provider}': template error in {location}: {e}"]
    return []


def _findings_for_template_provider(name: str, section: dict[str, Any]) -> list[str]:
    findings: list[str] = []
    unknown = set(section) - VALID_TEMPLATE_KEYS
    if unknown:
        findings.append(f"provider '{name}': unknown keys {sorted(unknown)}")
    if not section.get("endpoint"):
        findings.append(f"provider '{name}': missing 'endpoint'")
    if not (section.get("form") or section.get("json")):
        findings.append(f"provider '{name}': needs 'form' or 'json' request body")
    path = section.get("response_text_path", "text")
    if not isinstance(path, str) or not path or any(not p for p in path.split(".")):
        findings.append(f"provider '{name}': invalid response_text_path {path!r}")
    for key in ("headers", "form"):
        for k, v in section.get(key, {}).items():
            if isinstance(v, str):
                findings.extend(_compile_template(name, f"{key}.{k}", v))
    for k, v in section.get("json", {}).items():
        if isinstance(v, str):
            findings.extend(_compile_template(name, f"json.{k}", v))
    return findings


def _load_manager() -> ConfigManager:
    """Load config from VOICE_TO_TEXT_CONFIG env var if set, else default discovery."""
    path = os.environ.get("VOICE_TO_TEXT_CONFIG")
    return ConfigManager(path) if path else ConfigManager()


def check_config(manager: ConfigManager) -> list[str]:
    """Validate the whole config; returns a list of human-readable findings."""
    findings: list[str] = []
    selected = manager.get_selected_provider()
    sections = manager.config
    # Only flag a missing section when other provider sections exist (built-in
    # providers like groq work from env vars alone and need no section).
    provider_sections = [k for k, v in sections.items() if isinstance(v, dict) and k != "transcription"]
    if selected not in sections and provider_sections:
        findings.append(f"transcription.provider '{selected}' has no config section")
    for name, section in sections.items():
        if not isinstance(section, dict) or section.get("type") != "template":
            continue
        findings.extend(_findings_for_template_provider(name, section))
    if selected in sections and isinstance(sections[selected], dict) and sections[selected].get("type") == "template":
        # Selected template provider must also instantiate via its registry type.
        # Neutralize api_key sources: resolve_api_key runs !command substitutions,
        # which must never execute during a supposedly dry validation.
        cfg = dict(manager.get_provider_config(selected))
        cfg.pop("api_key", None)
        cfg.pop("api_key_env", None)
        try:
            get_batch_provider("template", cfg)
        except Exception as e:
            findings.append(f"provider '{selected}' failed to initialize: {e}")
    return findings


def main() -> int:
    """Run the config-check CLI; returns the process exit code."""
    logging.basicConfig(level=logging.WARNING)
    try:
        manager = _load_manager()
    except Exception as e:
        print(f"FAILED to load config: {e}", file=sys.stderr)
        return 1
    findings = check_config(manager)
    if findings:
        for f in findings:
            print(f"FAIL: {f}")
        return 1
    print("config OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
