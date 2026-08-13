# Adding a New Transcription Provider

This guide walks through adding a new speech-to-text provider to voice-to-text.
It uses the **ElevenLabs Scribe** provider (batch-only) as the reference
implementation, since it exercises every step below.

## Overview

Providers live in `src/voice_to_text/providers/` and are wired into a central
factory (`src/voice_to_text/providers/__init__.py`). A provider is one of:

- **Batch** (`BatchProvider`) — transcribes a complete audio file in one call.
  Most cloud providers (Groq, Deepgram, Voxtral, Parakeet, ElevenLabs) are batch.
- **Streaming** (`StreamingProvider` / `WebSocketStreamingProvider`) —
  transcribes audio in real time. Only Deepgram and Voxtral support streaming.

A provider can be batch-only, streaming-only, or both (Deepgram/Voxtral are
both). **A batch-only provider must NOT be added to the streaming dropdown** —
`tests/test_gnome_providers.py` enforces this and will fail otherwise.

## 1. Create the provider module

Create `src/voice_to_text/providers/<provider>.py`. Implement `BatchProvider`
(or `StreamingProvider`):

```python
"""<Provider> transcription provider."""

import logging
from pathlib import Path
from typing import Any

import httpx  # or the provider SDK

from .base import BatchProvider, resolve_api_key

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "..."


class MyProvider(BatchProvider):
    def __init__(self, config: dict[str, Any]):
        # provider_name is used for logging and key fingerprinting
        self.api_key = resolve_api_key(
            config, "MYPROVIDER_API_KEY", provider_name="myprovider"
        )
        self.model = config.get("model", DEFAULT_MODEL)
        self.api_url = config.get("api_url", "https://api.example.com")

    async def transcribe_file(self, audio_path: str, language: str = "en") -> str:
        logger.info("Transcribing %s with %s", audio_path, self.model)
        # ... perform the transcription request ...
        return text

    async def close(self) -> None:
        """Release persistent resources. No-op if you use a per-call client."""
        # e.g. await self.client.close() — or just `pass` when there is none

    @property
    def name(self) -> str:
        return "myprovider"
```

### Contract details

- **`close()` is abstract and required.** Even batch providers must implement
  it. Use `pass` when there is no persistent connection (e.g. you create the
  HTTP client per call inside `transcribe_file`).
- **`provider_name` parameter** is used for logging and key fingerprinting.
- **All imports must be at module level** (project rule in `AGENTS.md`).

## 2. Register in the factory

Edit `src/voice_to_text/providers/__init__.py`:

```python
from .myprovider import MyProvider
...
_BATCH_PROVIDERS = {
    ...
    "myprovider": MyProvider,
}
```

- Add the import in isort/alphabetical order.
- Batch-only providers go **only** in `_BATCH_PROVIDERS`. Add to
  `_STREAMING_PROVIDERS` only if the provider supports streaming.
- The provider key (`"myprovider"`) is what users set in `config.yaml`
  (`transcription.provider`) and select in the GNOME dropdown.

## 3. Add configuration

In `config.yaml`, add a provider block:

```yaml
myprovider:
  api_key_env: "MYPROVIDER_API_KEY"
  model: "default-model"
```

Update the `transcription.provider` comment to list the new option.

### API keys

Keys are resolved at runtime by `resolve_api_key` (step 1). Options:

1. **Environment variable** (default): set `MYPROVIDER_API_KEY`
2. **Config file**: add `api_key: "your-key"` to the provider block
3. **Command substitution** (recommended for secret managers):
   ```yaml
   # 1Password
   myprovider:
     api_key: "!op read 'op://Vault/MyProvider/key'"
   ```

   ```yaml
   # pass
   myprovider:
     api_key: "!pass show myprovider/api-key"
   ```

   ```yaml
   # GNOME Keyring
   myprovider:
     api_key: "!secret-tool lookup service voice-to-text username myprovider"
   ```
   The command runs fresh each time; output goes to stdout, errors to stderr.
   Raises `ValueError` on timeout, non-zero exit, or empty output.

4. **Async command substitution** (for slow key resolution):
   ```yaml
   myprovider:
     api_key: "!!bash /path/to/get-key.sh"
   ```
   The `!!` prefix runs the command in the background while recording starts
   immediately. Use when key resolution involves network calls (e.g., secret
   managers). The key is awaited only when transcription begins.

> Resolution order: environment variable → config file → command substitution.
> Command substitution supports shell pipes and quotes (`shell=True`).
> 10-second timeout; raises `ValueError` on failure.

## 4. Surface in the GNOME extension

Edit `gnome-ext/prefs.js`:

```js
providerCombo.append('myprovider', 'MyProvider');
// and, for batch providers, also:
batchProviderCombo.append('myprovider', 'MyProvider');
// DO NOT add batch-only providers to streamingProviderCombo
```

Update the summary text in
`gnome-ext/schemas/org.gnome.shell.extensions.voice-to-text.gschema.xml`
(the `provider` and/or `batch-provider` keys) to mention the new option. The
key type is `type="s"` (open string), so no enum change is needed.

> **Regression guard:** `tests/test_gnome_providers.py` parses `prefs.js`
> combos and asserts every entry resolves to a registered Python provider.
> Every combo entry MUST have a matching factory registration, or the test
> fails.

## 5. Tests

Mirror `tests/test_elevenlabs.py` / `tests/test_deepgram.py`:

- factory lookup returns the right class and `.name`
- `__init__` defaults (model, api_url, etc.)
- missing API key raises `ValueError`
- a mocked HTTP/SK call verifying the request shape (URL, headers, body fields,
  `text` extraction)

Also add a factory + missing-key case to `tests/test_providers.py` for
completeness.

## 6. Documentation

Update `README.md`:

- add the provider under **Providers** (Cloud / Local)
- add an API-key requirement bullet under **Requirements**
- add the `secret-tool store` command under **API Keys**

## 7. Validate

```bash
uv run ruff check src/voice_to_text/providers/<provider>.py
uv run pyright src/voice_to_text/providers/<provider>.py
uv run pytest            # includes test_gnome_providers.py and the new tests
```

All checks must pass before opening a PR.
