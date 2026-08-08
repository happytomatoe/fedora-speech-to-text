# Local Model Evaluation

Comparison of all transcription providers evaluated for voice-to-text.

## Provider Overview

| Provider | Type | Streaming | Batch | Latency | WER | Cost | GPU Required |
|----------|------|-----------|-------|---------|-----|------|--------------|
| **Moonshine** | local | ✅ | ✅ | ~269ms | 6.65% | Free | ❌ CPU-only |
| **Parakeet** | local | ❌ | ✅ | ~1-2s | ~5% | Free | Optional |
| **Voxtral** | cloud | ✅ | ✅ | ~200ms | ~5% | Free tier | ❌ |
| **Deepgram** | cloud | ✅ | ✅ | ~200ms | ~5% | Pay-per-min | ❌ |
| **60db** | cloud | ✅ | ✅ | ~300ms | ~6% | Free tier | ❌ |
| **Groq** | cloud | ❌ | ✅ | ~1-2s | ~5% | Free tier | ❌ |
| **ElevenLabs** | cloud | ❌ | ✅ | ~1-2s | ~5% | Pay-per-min | ❌ |

## Detailed Profiles

### Moonshine (Recommended for local)

- **Model**: Moonshine Medium (`moonshine-voice` package)
- **Type**: Local, CPU-only
- **Modes**: Streaming + Batch
- **Latency**: ~269ms on Linux x86 CPU
- **WER**: 6.65% (better than Whisper Large V3)
- **Memory**: ~500MB RAM
- **Model size**: ~245MB download (cached)
- **Languages**: English (primary)
- **Pros**: True streaming, no GPU needed, no API key, fully local
- **Cons**: English-only, model download on first use
- **Config**: `provider: moonshine` or `streaming_provider: moonshine`

### Parakeet (Local batch)

- **Model**: NVIDIA Parakeet TDT 0.6B v3
- **Type**: Local (HTTP mode, containerized)
- **Modes**: Batch only
- **Latency**: ~1-2s (batch processing)
- **WER**: ~5% (strong accuracy)
- **Memory**: ~1GB RAM (in container)
- **Pros**: High accuracy, no API key
- **Cons**: No streaming, requires container setup
- **Config**: `provider: parakeet`

### Voxtral / Mistral (Cloud)

- **Model**: Voxtral (Mistral)
- **Type**: Cloud API
- **Modes**: Batch (REST) + Realtime (WebSocket/SDK)
- **Latency**: ~200ms streaming
- **Languages**: 100+ languages (auto-detect)
- **Pros**: Multilingual, free tier, streaming support
- **Cons**: Requires API key, data sent to cloud
- **Config**: `provider: voxtral`

### Deepgram (Cloud)

- **Model**: Deepgram Nova
- **Type**: Cloud API
- **Modes**: Batch (REST) + Streaming (WebSocket)
- **Latency**: ~200ms streaming
- **Languages**: 30+ languages
- **Pros**: Low latency, good accuracy, streaming
- **Cons**: Pay-per-minute after free tier
- **Config**: `provider: deepgram`

### 60db (Cloud)

- **Model**: 60db STT
- **Type**: Cloud API
- **Modes**: Batch (REST) + Realtime (WebSocket)
- **Latency**: ~300ms
- **Pros**: Free tier, streaming support
- **Cons**: Smaller language coverage
- **Config**: `provider: 60db`

### Groq (Cloud)

- **Model**: OpenAI-compatible Whisper
- **Type**: Cloud API (via Groq hardware)
- **Modes**: Batch only (REST)
- **Latency**: ~1-2s (but fast hardware)
- **Pros**: Free tier, OpenAI-compatible API
- **Cons**: No streaming, batch only
- **Config**: `provider: groq`

### ElevenLabs (Cloud)

- **Model**: ElevenLabs Scribe
- **Type**: Cloud API
- **Modes**: Batch only (REST)
- **Latency**: ~1-2s
- **Pros**: Good accuracy, simple API
- **Cons**: No streaming, pay-per-minute
- **Config**: `provider: elevenlabs`

## Decision Matrix

| Use Case | Best Provider | Why |
|----------|---------------|-----|
| Privacy-sensitive | Moonshine or Parakeet | No data leaves the machine |
| Streaming (live text) | Moonshine, Voxtral, or Deepgram | True streaming support |
| Multilingual | Voxtral | 100+ languages |
| No GPU available | Moonshine | CPU-only, ~269ms latency |
| Highest accuracy | Parakeet or Voxtral | ~5% WER |
| Zero cost | Moonshine or Parakeet | No API keys needed |
| Quick setup | Moonshine | `pip install moonshine-voice` |

## Hybrid Mode

The engine supports combining providers via `hybrid` mode:

```yaml
transcription:
  mode: hybrid
  hybrid:
    streaming_provider: moonshine   # live text while speaking
    batch_provider: moonshine       # accurate final transcription
```

This gives live feedback during recording with accurate final results.

## References

- [Moonshine GitHub](https://github.com/moonshine-ai/moonshine)
- [Deepgram Docs](https://developers.deepgram.com/)
- [Voxtral Docs](https://docs.mistral.ai/capabilities/audio/)
- [Groq Docs](https://console.groq.com/docs/speech-text)
- [60db Docs](https://60db.com/docs)
- [ElevenLabs Scribe](https://elevenlabs.io/docs/speech-to-text)
