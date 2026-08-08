# Moonshine Streaming Provider Implementation Plan

## Overview

Add Moonshine Medium Streaming as a local streaming STT provider alongside the existing Parakeet batch provider. Moonshine provides true streaming (269ms latency on Linux x86 CPU) with 6.65% WER — better than Whisper Large V3, running entirely on CPU without GPU.

## Current State Analysis

**Provider architecture:**
- `StreamingProvider` base class: `start_stream()`, `send_audio()`, `get_partial_result()`, `finalize_stream()`
- `BatchProvider` base class: `transcribe_file()`
- `HybridTranscriber` combines streaming + batch for live text + final accuracy
- Provider registry in `providers/__init__.py` maps names to classes

**Moonshine Voice API:**
- `pip install moonshine-voice` — pre-built wheels for Linux x86-64
- `Transcriber` class supports streaming via `TranscriptEventListener` callbacks
- Event-driven: `on_line_started`, `on_line_text_changed`, `on_line_completed`
- `transcribe_without_streaming()` for batch mode
- Model auto-download via `get_model_for_language("en")`

**Key insight:** Moonshine's `Transcriber` can do both streaming and batch, so a single provider class can implement both interfaces.

## Desired End State

1. `moonshine` available as both streaming and batch provider
2. Config: `provider: moonshine` or `streaming_provider: moonshine`
3. Streaming mode: live text appears as user speaks (269ms latency)
4. Batch mode: accurate final transcription after recording stops
5. Works on CPU — no GPU required

## What We're NOT Doing

- Modifying existing providers
- Adding multi-language support (English only for now)
- Changing the hybrid transcriber logic

> **Note:** Moonshine is added to all three GNOME extension provider selectors (batch, streaming, hybrid).

## Implementation Approach

Single `MoonshineProvider` class implementing both `StreamingProvider` and `BatchProvider`. Uses Moonshine's native `Transcriber` with event listeners for streaming, and `transcribe_without_streaming()` for batch.

---

## Phase 1: Core Provider

### Overview
Create `MoonshineProvider` class with streaming + batch support.

### Changes Required:

#### 1. New file: `src/voice_to_text/providers/moonshine.py`
```python
"""Moonshine local streaming transcription provider."""

import logging
from typing import Any

import numpy as np

from .base import BatchProvider, StreamingProvider

logger = logging.getLogger(__name__)


class MoonshineProvider(StreamingProvider, BatchProvider):
    """Moonshine provider supporting both streaming and batch modes."""

    def __init__(self, config: dict[str, Any]):
        self.model_name = config.get("model", "medium")
        self.language = config.get("language", "en")
        self._transcriber = None
        self._partial_result: str | None = None
        self._finalized_text = ""
        self._finalized_event = None  # threading.Event for finalize_stream
        # Lazy import to avoid slow startup
        self._moonshine = None

    def _ensure_imported(self):
        if self._moonshine is None:
            import moonshine_voice
            self._moonshine = moonshine_voice

    def _ensure_model(self):
        self._ensure_imported()
        if self._transcriber is None:
            model_path, model_arch = self._moonshine.get_model_for_language(self.language)
            self._transcriber = self._moonshine.Transcriber(
                model_path=model_path,
                model_arch=model_arch,
            )

    # --- StreamingProvider interface ---

    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        self._ensure_model()
        self._finalized_text = ""
        self._partial_result = None
        self._transcriber.remove_all_listeners()

        provider = self

        class _Listener(self._moonshine.TranscriptEventListener):
            def on_line_started(self, event):
                pass

            def on_line_text_changed(self, event):
                provider._partial_result = event.line.text

            def on_line_completed(self, event):
                provider._finalized_text = (
                    (provider._finalized_text + " " + event.line.text).strip()
                )
                provider._partial_result = None

        self._transcriber.add_listener(_Listener())
        self._transcriber.start()
        logger.info("Moonshine streaming started")

    async def send_audio(self, audio_chunk: bytes) -> None:
        if self._transcriber is None:
            raise RuntimeError("Stream not started")
        # Convert int16 bytes to float32 array
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32) / 32768.0
        self._transcriber.feed_audio(samples.tolist())

    async def finalize_stream(self) -> str:
        if self._transcriber is not None:
            try:
                self._transcriber.stop()
            except Exception:
                pass
        result = self._finalized_text
        if self._partial_result:
            result = (result + " " + self._partial_result).strip()
        self._partial_result = None
        self._finalized_text = ""
        return result

    # --- BatchProvider interface ---

    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        self._ensure_model()
        audio_data, sample_rate = self._moonshine.load_wav_file(audio_path)
        transcript = self._transcriber.transcribe_without_streaming(
            audio_data, sample_rate=sample_rate
        )
        text = " ".join(line.text for line in transcript.lines).strip()
        logger.info("Moonshine batch result: %s", text[:100])
        return text

    # --- Common ---

    @property
    def name(self) -> str:
        return "moonshine"

    async def close(self) -> None:
        if self._transcriber is not None:
            try:
                self._transcriber.stop()
            except Exception:
                pass
            self._transcriber = None
```

#### 2. Update: `src/voice_to_text/providers/__init__.py`
Add Moonshine to both registries:
```python
from .moonshine import MoonshineProvider

_BATCH_PROVIDERS = {
    ...
    "moonshine": MoonshineProvider,
}

_STREAMING_PROVIDERS = {
    ...
    "moonshine": MoonshineProvider,
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Import works: `python -c "from voice_to_text.providers import get_batch_provider, get_streaming_provider"`
- [ ] Provider instantiation: `get_batch_provider("moonshine", {})` returns `MoonshineProvider`
- [ ] Provider instantiation: `get_streaming_provider("moonshine", {})` returns `MoonshineProvider`
- [ ] Lint passes: `ruff check src/voice_to_text/providers/moonshine.py`
- [ ] Type check passes: `pyright src/voice_to_text/providers/moonshine.py`

#### Manual Verification:
- [ ] `uv run python -c "from voice_to_text.providers.moonshine import MoonshineProvider; p = MoonshineProvider({}); print(p.name)"` prints "moonshine"

---

## Phase 2: Configuration & Documentation

### Overview
Add config support and docs.

### Changes Required:

#### 1. Update: `config.yaml`
Add moonshine section:
```yaml
transcription:
  # ...
  providers:
    moonshine:
      model: medium
      language: en
```

#### 2. New file: `docs/providers/moonshine.md`
Document the provider with:
- Description (local streaming, CPU-only)
- Configuration options
- Installation (`pip install moonshine-voice`)
- Usage examples

#### 3. Update: `README.md`
Add Moonshine to the providers list.

### Success Criteria:

#### Automated Verification:
- [ ] `docs/providers/moonshine.md` exists
- [ ] Config loads without error

---

## Phase 3: Tests

### Overview
Add unit tests for Moonshine provider.

### Changes Required:

#### 1. New file: `tests/test_moonshine_provider.py`
Test:
- Provider instantiation with default config
- Provider name property
- Streaming mode start/send/finalize flow
- Batch mode transcribe_file flow
- Error handling when model not loaded

### Success Criteria:

#### Automated Verification:
- [ ] `uv run pytest tests/test_moonshine_provider.py -v` passes
- [ ] `uv run pytest tests/ -n auto` — full suite passes (no regressions)

---

## Phase 4: Integration Test

### Overview
Verify Moonshine works end-to-end with the engine.

### Changes Required:

#### 1. Manual test with D-Bus service
```bash
# Terminal 1: start service
just service-run

# Terminal 2: trigger recording via GNOME extension
# Set provider to "moonshine" in preferences
```

### Success Criteria:

#### Manual Verification:
- [ ] Recording starts and live text appears (streaming)
- [ ] Final text is accurate after recording stops
- [ ] CPU usage is reasonable (<50% on modern hardware)
- [ ] No crashes or errors in journal logs

---

## Testing Strategy

### Unit Tests:
- Provider construction with various configs
- Streaming lifecycle (start → send → finalize)
- Batch transcription of test audio file
- Error handling (model not found, invalid audio)

### Integration Tests:
- End-to-end with engine (requires audio device or test file)

### Manual Testing Steps:
1. Install moonshine-voice: `uv add moonshine-voice`
2. Run service: `just service-run`
3. Set provider to "moonshine" in GNOME extension preferences
4. Record audio and verify live text appears
5. Stop recording and verify final text
6. Check CPU usage with `htop`

## Performance Considerations

- **Model download**: First run downloads ~245MB model (cached after)
- **Memory**: ~500MB RAM during inference
- **CPU**: 269ms latency on Linux x86 — words appear as you speak
- **No GPU required**: Runs entirely on CPU

## References

- Moonshine Voice docs: https://github.com/moonshine-ai/moonshine
- Moonshine API: https://mintlify.wiki/moonshine-ai/moonshine/api/python/transcriber
- Existing provider pattern: `src/voice_to_text/providers/parakeet.py`
- Base classes: `src/voice_to_text/providers/base.py`
