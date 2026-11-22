"""Tests that GNOME extension provider lists match the Python backend."""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

from voice_to_text.providers import _BATCH_PROVIDERS, _STREAMING_PROVIDERS

GNOME_EXT = Path(__file__).resolve().parent.parent / "gnome-ext"
GSCHEMA_XML = GNOME_EXT / "schemas" / "org.gnome.shell.extensions.voice-to-text.gschema.xml"
PREFS_JS = GNOME_EXT / "prefs.js"
PROVIDER_ROW_JS = GNOME_EXT / "prefs" / "provider-row.js"


def _parse_gschema_provider_defaults() -> dict[str, str]:
    """Extract provider defaults from gschema XML."""
    tree = ET.parse(GSCHEMA_XML)
    defaults = {}
    for key in tree.findall(".//key"):
        name = key.get("name")
        if name in ("provider", "streaming-provider", "batch-provider"):
            default_el = key.find("default")
            if default_el is not None and default_el.text:
                defaults[name] = default_el.text.strip('"')
    return defaults


def _js_block(text: str, start: str, end: str) -> str:
    """Return the text between two markers."""
    return text.split(start, 1)[1].split(end, 1)[0]


def _parse_prefs_providers() -> dict[str, list[str]]:
    """Extract provider IDs from the prefs UI (combo literals and provider-row.js)."""
    result: dict[str, list[str]] = {}

    text = PREFS_JS.read_text()
    # Match: someCombo.append("id", "Label")
    for match in re.finditer(r'(\w+ProviderCombo)\.append\("([^"]+)"', text):
        result.setdefault(match.group(1), []).append(match.group(2))

    row_text = PROVIDER_ROW_JS.read_text()
    batch_block = _js_block(row_text, "const BATCH_PROVIDERS = {", "};")
    batch_ids = [quoted or bare for quoted, bare in re.findall(r"^\s+(?:'([^']+)'|(\w+)):", batch_block, re.M)]
    streaming_block = _js_block(row_text, "const STREAMING_PROVIDER_IDS = [", "];")
    streaming_ids = re.findall(r"'([^']+)'", streaming_block)

    result.setdefault("batchProviderCombo", []).extend(batch_ids)
    result.setdefault("providerCombo", []).extend(batch_ids)
    result.setdefault("streamingProviderCombo", []).extend(streaming_ids)
    return result


class TestProviderConsistency:
    """Verify GNOME extension and Python backend agree on provider names."""

    def test_gschema_provider_defaults_exist_in_python(self):
        defaults = _parse_gschema_provider_defaults()
        all_python = set(_BATCH_PROVIDERS) | set(_STREAMING_PROVIDERS)

        for key, default in defaults.items():
            assert default in all_python, (
                f"gschema key '{key}' defaults to '{default}' "
                f"which is not a registered Python provider. "
                f"Available: {sorted(all_python)}"
            )

    def test_gschema_streaming_default_in_streaming_providers(self):
        defaults = _parse_gschema_provider_defaults()
        streaming_default = defaults.get("streaming-provider")
        assert streaming_default in _STREAMING_PROVIDERS, (
            f"gschema streaming-provider default '{streaming_default}' "
            f"is not a streaming provider. Available: {sorted(_STREAMING_PROVIDERS)}"
        )

    def test_gschema_batch_default_in_batch_providers(self):
        defaults = _parse_gschema_provider_defaults()
        batch_default = defaults.get("batch-provider")
        assert batch_default in _BATCH_PROVIDERS, (
            f"gschema batch-provider default '{batch_default}' "
            f"is not a batch provider. Available: {sorted(_BATCH_PROVIDERS)}"
        )

    def test_prefs_streaming_providers_exist_in_python(self):
        prefs = _parse_prefs_providers()
        streaming_ids = prefs.get("streamingProviderCombo", [])
        for pid in streaming_ids:
            assert pid in _STREAMING_PROVIDERS, (
                f"prefs.js streaming provider '{pid}' "
                f"is not a registered streaming provider. "
                f"Available: {sorted(_STREAMING_PROVIDERS)}"
            )

    def test_prefs_batch_providers_exist_in_python(self):
        prefs = _parse_prefs_providers()
        batch_ids = prefs.get("batchProviderCombo", [])
        for pid in batch_ids:
            assert pid in _BATCH_PROVIDERS, (
                f"prefs.js batch provider '{pid}' "
                f"is not a registered batch provider. "
                f"Available: {sorted(_BATCH_PROVIDERS)}"
            )

    def test_prefs_provider_exists_in_python(self):
        prefs = _parse_prefs_providers()
        provider_ids = prefs.get("providerCombo", [])
        all_python = set(_BATCH_PROVIDERS) | set(_STREAMING_PROVIDERS)
        for pid in provider_ids:
            assert pid in all_python, (
                f"prefs.js provider '{pid}' is not a registered provider. Available: {sorted(all_python)}"
            )
