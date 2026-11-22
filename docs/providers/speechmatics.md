# Speechmatics - API Reference

Speechmatics offers batch transcription (REST) and realtime transcription
(WebSocket). Both share the same `transcription_config` object.

## API Endpoints

- Batch base URL: `https://eu1.asr.api.speechmatics.com/v2`
- Realtime URL: `wss://eu2.rt.speechmatics.com/v2`
- Submit: `POST {base}/jobs/` (multipart: `data_file`, `config`)
- Status: `GET {base}/jobs/{job_id}`
- Transcript: `GET {base}/jobs/{job_id}/transcript?format=txt`

For on-prem appliances, override `api_url` and `realtime_url` in `config.yaml`.

## Authentication

- Header: `Authorization: Bearer <API_KEY>`
- Get a key: https://portal.speechmatics.com/settings/api-keys

## Models

Set `model` in `transcription_config`. `operating_point` is deprecated and
still maps to `model`.

| Model | Notes |
|---|---|
| `enhanced` | Default. Highest accuracy for single-language audio. |
| `standard` | Lower latency and higher throughput. |
| `melia-1` | Multilingual; set `language: multi` and send `ForceEndOfUtterance`. |
| `oak-1` | Batch only. |

## Batch

```json
{
  "type": "transcription",
  "transcription_config": {
    "model": "enhanced",
    "language": "en"
  }
}
```

`POST /jobs/` returns `{"id": "<job_id>"}` with HTTP 201. The provider polls
`GET /jobs/{job_id}` until the status is `done`, then downloads the plain-text
transcript. Terminal failures (`rejected`, `deleted`, `expired`) raise.

Options set in `speechmatics.batch_options` merge into `transcription_config`
(for example `domain: medical`, `diarization: speaker`, `output_locale`).

## Realtime

The first frame is `StartRecognition`; audio follows as binary frames, and
`EndOfStream` ends the session.

```json
{
  "message": "StartRecognition",
  "audio_format": {"type": "raw", "encoding": "pcm_s16le", "sample_rate": 16000},
  "transcription_config": {
    "model": "enhanced",
    "language": "en",
    "enable_partials": true,
    "max_delay": 0.7
  }
}
```

Server messages used by the provider:

- `AddPartialTranscript` - `metadata.transcript` is the changing partial.
- `AddTranscript` - final segment; appended to the transcript.
- `EndOfTranscript` - acknowledgement of `EndOfStream`.
- `Error` - `reason` is logged.

`speechmatics.streaming_options` merges into the realtime
`transcription_config` (for example `max_delay`, `additional_vocab`,
`enable_entities`).

## Custom Words

`transcribe_file` maps `custom_words` to `additional_vocab` as
`[{"content": "<word>"}]` unless `batch_options` already sets it. Streaming has
no per-call word list, so set `streaming_options.additional_vocab` in
`config.yaml`.

## Config

```yaml
speechmatics:
  api_key_env: "SPEECHMATICS_API_KEY"
  model: "enhanced"
  # batch_options:
  #   domain: "medical"
  # streaming_options:
  #   max_delay: 1.0
  # api_url: "https://eu1.asr.api.speechmatics.com/v2"
  # realtime_url: "wss://eu2.rt.speechmatics.com/v2"
```
