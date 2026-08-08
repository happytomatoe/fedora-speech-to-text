# Deepgram — API Reference

Deepgram **Nova** is a speech-to-text API with both batch (REST) and streaming (WebSocket) interfaces.

## API Endpoint

- Base URL: `https://api.deepgram.com`
- Batch: `POST {base}/v1/listen` (query parameters; audio as multipart or JSON `{"url": ...}`)
- Streaming: `wss://api.deepgram.com/v1/listen` (query parameters)

## Authentication

- Header: `Authorization: Token <API_KEY>`
- Get a key: https://console.deepgram.com/

## Modules / Libraries Used (what we can use)

- `httpx` — async HTTP client for batch.
- `websockets` — persistent WebSocket for streaming.

## Languages

- **30+ languages** (Nova models). Auto-detects when `language` is omitted.

## Parameters

Batch (`POST /v1/listen`) query parameters:

| Parameter | Description | Default | Notes |
|-----------|-------------|---------|-------|
| `model` | Model to use | — (required) | e.g. `nova-3` |
| `language` | Language code | auto-detect | e.g. `en` |
| `punctuate` | Add punctuation | `false` | boolean |
| `smart_format` | Format numbers / dates / times | `false` | boolean |
| `paragraphs` | Split transcript into paragraphs | `false` | boolean |
| `numerals` | Convert numbers from words to digits | `false` | boolean |
| `filler_words` | Include filler words (`uh`, `um`) | `false` | boolean |
| `utterances` | Split by speaker utterance | `false` | boolean |
| `diarize` | Speaker diarization | `false` | boolean |
| `multichannel` | Transcribe each channel separately | `false` | boolean |
| `profanity_filter` | Mask profanity | `false` | boolean |
| `redact` | Redact PII | none | array: `pii`, `pci`, `numbers`, `ssn`, ... |
| `search` | Search for specific terms | none | array of terms |
| `replace` | Find-and-replace words | none | array of `{term, replace_with}` |
| `callback` | Async callback URL | none | string |
| `mip_opt_out` | Opt out of the Model Improvement Program | `false` | boolean |
| `detect_language` | Auto-detect language | `false` | boolean |
| `dictation` | Optimize for dictation | `false` | boolean |
| `measurements` | Include measurement output | `false` | boolean |
| `keyterm` | Terms to bias recognition | none | repeatable param; 500 tokens max; Nova-3 & Flux only |

Streaming-only query parameters (`wss://.../v1/listen`):

| Parameter | Description | Default | Notes |
|-----------|-------------|---------|-------|
| `encoding` | Audio encoding | — | e.g. `linear16` |
| `sample_rate` | Audio sample rate (Hz) | — | integer |
| `channels` | Number of channels | `1` | integer |
| `interim_results` | Return interim results | `false` | boolean |
| `endpointing` | Endpoint detection sensitivity (ms) | — | integer |
| `vad_turnoff` | Voice-activity turn-off (ms) | — | integer |

## References

- Official API reference: https://developers.deepgram.com/reference
  - Pre-recorded: https://developers.deepgram.com/reference/pre-recorded
  - Streaming: https://developers.deepgram.com/reference/streaming
