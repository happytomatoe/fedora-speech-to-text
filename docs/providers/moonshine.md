# Moonshine — Local Streaming Provider

Moonshine Medium provides true streaming (269ms latency on Linux x86 CPU) with 6.65% WER — better than Whisper Large V3, running entirely on CPU without GPU.

## Features

- **True streaming**: Live text appears as user speaks (~269ms latency)
- **CPU-only**: No GPU required, runs on modern x86 processors
- **Batch mode**: Accurate final transcription after recording stops
- **Local**: No cloud API keys needed, no data sent externally

## Installation

```bash
uv add moonshine-voice
```

Or install directly:

```bash
pip install moonshine-voice
```

Pre-built wheels are available for Linux x86-64. First run downloads the model (~245MB, cached after).

## Configuration

### config.yaml

```yaml
transcription:
  provider: "moonshine"           # for batch mode
  # OR
  mode: "hybrid"
  hybrid:
    streaming_provider: "moonshine"
    batch_provider: "moonshine"

moonshine:
  model: medium                  # model size (default: "medium")
  language: en                   # language code (default: "en")
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | string | `"medium"` | Model size |
| `language` | string | `"en"` | Language code (ISO 639-1) |

## Usage

### As Streaming Provider

```python
from voice_to_text.providers import get_streaming_provider

provider = get_streaming_provider("moonshine", {"model": "medium"})

# Start streaming session
await provider.start_stream(language="en", sample_rate=16000)

# Send audio chunks (int16 bytes)
await provider.send_audio(audio_chunk)

# Get partial results (live text as user speaks)
partial = await provider.get_partial_result()

# Finalize and get complete transcript
final_text = await provider.finalize_stream()
```

### As Batch Provider

```python
from voice_to_text.providers import get_batch_provider

provider = get_batch_provider("moonshine", {"model": "medium"})

# Transcribe audio file
text = await provider.transcribe_file("/path/to/audio.wav")
```

### CLI

```bash
# Batch mode
uv run python -m voice_to_text --provider moonshine /path/to/audio.wav

# Streaming mode (via D-Bus service)
just service-run
# Then use GNOME extension with moonshine as streaming provider
```

## Performance

- **Latency**: ~269ms on Linux x86 CPU
- **Memory**: ~500MB RAM during inference
- **Model**: ~245MB download (cached)
- **WER**: 6.65% (better than Whisper Large V3)

## Requirements

- Linux x86-64
- Python 3.13+
- moonshine-voice package
- ~500MB RAM for model

## References

- [Moonshine GitHub](https://github.com/moonshine-ai/moonshine)
- [Moonshine API Docs](https://mintlify.wiki/moonshine-ai/moonshine/api/python/transcriber)
