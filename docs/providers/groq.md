# Groq — API Reference

Groq provides OpenAI-compatible Whisper transcription. **Batch / REST only** — no streaming endpoint.

## API Endpoint

- Base URL: `https://api.groq.com/openai/v1`
- Batch: `POST {base}/audio/transcriptions`
- Limits: max 25 MB (direct upload); up to 100 MB (URL-based, paid tier). Formats `mp3, mp4, mpeg, mpga, m4a, wav, webm`. `vtt` / `srt` are **not** supported.

## Authentication

- API key (Bearer) passed to the Groq SDK / `Authorization: Bearer <API_KEY>`.
- Get a key: https://console.groq.com/keys

## Modules / Libraries Used (what we can use)

- `groq` — `AsyncGroq` SDK (built on `httpx`) for async batch transcription.

## Languages

- **99+ languages** (Whisper `large-v3` / `large-v3-turbo`). Auto-detects when `language` is omitted.

## Parameters

All parameters for `POST /v1/audio/transcriptions` (OpenAI-compatible):

| Parameter | Description | Default | Notes |
|-----------|-------------|---------|-------|
| `file` | Audio file to transcribe | — (required) | `mp3, mp4, mpeg, mpga, m4a, wav, webm`; max 25 MB |
| `model` | Model id | — (required) | `whisper-large-v3`, `whisper-large-v3-turbo` |
| `language` | ISO-639-1 language hint | auto-detect | e.g. `en` |
| `prompt` | Guidance text to steer style / spelling | none | used for terminology biasing via `custom_words` |
| `response_format` | Output format | `json` | `json`, `text`, `verbose_json` (vtt/srt **not** supported on Groq) |
| `temperature` | Sampling temperature | `0` | 0.0–1.0 |
| `timestamp_granularities` | Word/segment timestamps | `segment` | used with `verbose_json` |

## References

- Official docs: https://console.groq.com/docs/speech-to-text
- OpenAI-compatible spec: https://console.groq.com/docs/openai
