# AssemblyAI — API Reference

AssemblyAI offers two relevant lanes: **Sync** (one HTTP request, transcript in the
response) for finished recordings, and **Universal-Streaming** (WebSocket) for live
audio. The pre-recorded async API (upload + poll) is not used by this provider.

## API Endpoints

- Batch (Sync): `POST https://sync.assemblyai.com/v1/transcribe` (multipart/form-data)
- Streaming: `wss://streaming.assemblyai.com/v3/ws`
- EU residency: `https://sync.eu.assemblyai.com`, `wss://streaming.eu.assemblyai.com`

## Authentication

- HTTP: `Authorization: <API_KEY>` (a `Bearer ` prefix is accepted)
- WebSocket: the same header, or a temporary token in the `token` query parameter
- Get a key: https://www.assemblyai.com/dashboard/signup

## Modules / Libraries Used

- `httpx` — shared async client for the Sync request.
- `websockets` — the v3 streaming connection.
- No vendor SDK: both protocols are small enough to keep explicit.

## Batch (Sync API)

| Parameter | Description | Default | Notes |
|-----------|-------------|---------|-------|
| `audio` | Multipart audio part | — (required) | ≤ 20 min, ≤ 256 MB; WAV/PCM/MP3/M4A/AAC/Ogg/FLAC/WebM |
| `X-AAI-Model` | Model header | — (required) | `universal-3-6-pro` |
| client timeout | `httpx` request timeout | 120 s | The server's own deadline is 30 s; this only bounds the client wait |

The provider reads only `text` from the response. The API also returns `words`,
`confidence`, `audio_duration_ms`, `session_id`, and `request_time_ms`; this
integration does not consume them.

## Streaming (v3 WebSocket)

Query parameters this provider sends: `speech_model` (default
`universal-streaming-english`), `sample_rate`, `encoding=pcm_s16le`, and
`format_turns=true`. The endpoint also accepts `end_of_turn_confidence_threshold`,
`vad_threshold`, and `keyterms_prompt`, but they are not exposed through
`config.yaml` and are not sent.

Messages:

| Direction | Type | Handling |
|-----------|------|----------|
| server → client | `Begin` | session id logged at debug |
| server → client | `Turn` | `transcript` holds finalized words; `end_of_turn: false` is a partial, `true` finishes the turn |
| server → client | `Termination` | ends draining |
| client → server | `Terminate` | sent by `finalize_stream()` |

Sessions left open keep accruing charges until the 3-hour cap, so
`finalize_stream()` always sends `Terminate`.

## Languages

- Batch (Sync, `universal-3-6-pro`): 32 languages, auto-detected.
- Streaming: `universal-streaming-english` (English);
  `universal-streaming-multilingual` covers en/es/fr/de/it/pt. Other languages need
  `speech_model=whisper-rt`.

## Data retention

| Lane | Default | Zero retention |
|------|---------|----------------|
| Batch (Sync) | request-scoped; no stored artifact to fetch | not offered |
| Streaming | audio and transcripts kept unless opted out of training | paid plan + training opt-out in the dashboard |

The training opt-out is an **account setting**, not a request parameter, so it
cannot be expressed as a `config.yaml` flag. Free plans cannot opt out.

## Configuration

```yaml
assemblyai:
  api_key_env: "ASSEMBLYAI_API_KEY"
  model: "universal-3-6-pro"
  streaming_model: "universal-streaming-english"
  # api_url: "https://sync.eu.assemblyai.com"
  # streaming_url: "wss://streaming.eu.assemblyai.com"
```

## References

- Sync API: https://www.assemblyai.com/docs/api-reference/sync-api/transcribe
- Sync limits: https://www.assemblyai.com/docs/sync-stt/audio-requirements
- Streaming API: https://www.assemblyai.com/docs/api-reference/streaming-api/universal-streaming/universal-streaming
- Streaming messages: https://www.assemblyai.com/docs/streaming/universal-streaming/message-sequence
- Data retention: https://www.assemblyai.com/docs/data-retention-and-model-training
