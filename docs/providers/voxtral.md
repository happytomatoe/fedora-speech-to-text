# Voxtral (Mistral) — API Reference

Mistral **Voxtral** is a speech-to-text API with batch (OpenAI-compatible REST) and realtime (WebSocket/SDK) interfaces.

## API Endpoint

- Base URL: `https://api.mistral.ai`
- Batch: `POST {base}/v1/audio/transcriptions` (multipart, OpenAI-compatible)
- Realtime: Mistral realtime SDK (`server_url` = base URL)

## Authentication

- Header: `Authorization: Bearer <API_KEY>`
- Get a key: https://console.mistral.ai/

## Modules / Libraries Used (what we can use)

- `httpx` — async HTTP client for batch.
- `mistralai` — `Mistral` client + `mistralai.extra.realtime.AudioFormat` for realtime streaming.

## Languages

- **100+ languages** (Voxtral models). Auto-detects when `language` is omitted.

## Parameters

Batch (`POST /v1/audio/transcriptions`) — OpenAI-compatible:

| Parameter | Description | Default | Notes |
|-----------|-------------|---------|-------|
| `model` | Model id | — (required) | e.g. `voxtral-mini-latest` |
| `file` | Audio file to transcribe | — (required) | |
| `language` | ISO-639-1 language hint | auto-detect | e.g. `en` |
| `diarize` | Speaker diarization | `false` | boolean |
| `prompt` | Guidance text | none | OpenAI-compatible |
| `context_bias` | Terms to bias recognition | none | repeatable form field; max 100 terms |
| `response_format` | Output format | `json` | OpenAI-compatible |
| `timestamp_granularities` | Word/segment timestamps | `segment` | OpenAI-compatible |

Realtime (Mistral `transcribe_stream`) parameters:

| Parameter | Description | Default | Notes |
|-----------|-------------|---------|-------|
| `model` | Realtime model id | — (required) | e.g. `voxtral-mini-transcribe-realtime-2602` |
| `audio_format` | Audio encoding + sample rate | — | e.g. `pcm_s16le` @ 16 kHz |
| `target_streaming_delay_ms` | Target streaming delay | — | integer (ms) |
| `server_url` | API base URL | `https://api.mistral.ai` | string |
| `languages` | Target languages | auto-detect | array |
| `vad_config` | Voice-activity detection config | — | object |

## References

- Official audio transcription API: https://docs.mistral.ai/api/endpoint/audio/transcriptions
