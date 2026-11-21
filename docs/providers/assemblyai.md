# AssemblyAI — API Reference

AssemblyAI offers two relevant lanes: **Sync** (one HTTP request, transcript in the
response) for finished recordings, and **Universal-Streaming** (WebSocket) for live
audio. The pre-recorded async API (upload + poll) is not used by this provider.

## API Endpoints

- Batch (Sync): `POST https://sync.assemblyai.com/v1/transcribe` (multipart/form-data)
- Sync warm-up: `GET https://sync.assemblyai.com/v1/warm`
- Streaming: `wss://streaming.assemblyai.com/v3/ws`
- EU residency: `https://sync.eu.assemblyai.com`, `wss://streaming.eu.assemblyai.com`
- US residency: `wss://streaming.us.assemblyai.com`

The global streaming host routes each connection to the nearest region and is the
lowest-latency choice. The `.us` and `.eu` hosts exist for data residency, not
speed; they pin processing to that region.

## Authentication

- HTTP: `Authorization: <API_KEY>` (a `Bearer ` prefix is accepted)
- WebSocket: the same header, or a temporary token in the `token` query parameter
- Get a key: https://www.assemblyai.com/dashboard/signup

## Modules / Libraries Used

- `httpx` — shared async client for the Sync request.
- `websockets` — the v3 streaming connection.
- No vendor SDK: both protocols are small enough to keep explicit.

## Models

### Batch (Sync, `X-AAI-Model` header)

| Model | Use | Notes |
|-------|-----|-------|
| `universal-3-6-pro` | Default for Sync | Highest accuracy, 32 languages, automatic language detection |

### Streaming (`speech_model` query parameter)

| Model | Use | Notes |
|-------|-----|-------|
| `assemblyai-stt-3-7-realtime` | Default here: live transcripts, captions, notetakers | 32 languages, speaker labels final at turn end, $0.30/hr |
| `assemblyai-stt-3-7-realtime-agent` | Voice agents and IVR that wait for an end-of-turn decision | Short replies and entities, lowest end-of-turn latency, $0.45/hr |
| `universal-3-6-pro` | Previous-generation streaming model | Still available; superseded by the 3.7 models |
| `universal-streaming-english` | Replaced by `assemblyai-stt-3-7-realtime` | Legacy English-only model |

## Batch (Sync API)

Request parts:

| Part | Description | App behavior |
|------|-------------|--------------|
| `audio` (required) | Audio file | Always sent; content type derived from the file suffix |
| `config` (JSON, optional) | Transcription options | Built from `batch_options`, `custom_words`, and `language` |
| `X-AAI-Model` header (required) | Model name | `model` from config, default `universal-3-6-pro` |
| `token` query parameter | Auth alternative | Not used; the header carries the key |

`config` object fields:

| Field | Description | App behavior |
|-------|-------------|--------------|
| `sample_rate` | Audio sample rate in Hz | Not sent; file header carries it |
| `channels` | Audio channel count | Not sent |
| `prompt` | Context about the audio (domain, scenario, names) | Set `batch_options.prompt` |
| `keyterms_prompt` | Up to 100 terms (8000 characters total) to bias recognition; aliases `keyterms`, `word_boost` | Filled from `custom_words` when not overridden in `batch_options` |
| `conversation_context` | Prior transcript context | Available through `batch_options.conversation_context` |
| `language_codes` | Language or languages in the audio | Set from `language` when it is one of the 32 supported codes; omitted otherwise (auto-detect) |
| `timestamps` | Include word-level timings | Available through `batch_options.timestamps`; response words are not consumed |

The provider reads only `text` from the response. The API also returns `words`,
`confidence`, `audio_duration_ms`, `session_id`, and `request_time_ms`; this
integration does not consume them.

`GET /v1/warm` pre-opens a connection so a recording started seconds later skips
the handshake. The provider does not call it; `httpx` keep-alive already reuses
the pooled connection between requests.

## Streaming (v3 WebSocket)

Connection parameters:

| Parameter | Description | App behavior |
|-----------|-------------|--------------|
| `speech_model` | Streaming model | Sent; `streaming_model` from config |
| `sample_rate` | Audio sample rate in Hz | Sent from the recorder |
| `encoding` | `pcm_s16le`, `pcm_mulaw`, or `opus` | Always `pcm_s16le` |
| `language_codes` | JSON array of expected language codes | Sent when `language` is one of the 32 supported codes; omit for native code switching |
| `token` | Temporary auth token | Not used; the `Authorization` header is sent |
| `language_detection` | Report each turn's `language_code` | Via `streaming_options` |
| `domain` | Domain model (`medical-v1`, `veterinary-v1`) | Via `streaming_options` |
| `mode` | Turn-detection preset (`max_accuracy`, `min_latency`, `balanced`, `manual`) | Via `streaming_options` |
| `session_heartbeat` | Send a `Heartbeat` every 5 s | Via `streaming_options` |
| `min_turn_silence` | Minimum silence before a turn can end | Via `streaming_options` |
| `max_turn_silence` | Maximum silence before a turn must end | Via `streaming_options` |
| `vad_threshold` | Voice-activity threshold | Via `streaming_options` |
| `interruption_delay` | Delay before background speech interrupts | Via `streaming_options` |
| `include_partial_turns` | Emit partial turns | Via `streaming_options` |
| `prompt` | Context about the audio (≤400 characters) | Via `streaming_options` |
| `keyterms_prompt` | JSON array of up to 100 terms to boost | Via `streaming_options`; distinct from batch `custom_words` |
| `agent_context` | Spoken text of the agent's reply, for voice agents | Via `streaming_options` |
| `previous_context_n_turns` | Turns of context carried across | Via `streaming_options` |
| `speaker_labels` | Inline speaker labels | Via `streaming_options` |
| `max_speakers` | Expected speaker count | Via `streaming_options` |
| `voice_focus` | Filter background speech | Via `streaming_options` |
| `voice_focus_threshold` | Voice-focus aggressiveness | Via `streaming_options` |
| `redact_pii` | Redact PII in transcripts | Via `streaming_options` |
| `redact_pii_policies` | PII categories | Via `streaming_options` |
| `redact_pii_sub` | Replacement for redacted text | Via `streaming_options` |
| `filter_profanity` | Mask profanity | Via `streaming_options` |
| `llm_gateway` | Route transcripts through LLM Gateway | Via `streaming_options` |
| `inactivity_timeout` | Close an idle session | Via `streaming_options` |

`streaming_options` values are serialized per type: booleans become `true`/`false`,
lists and dicts become JSON, everything else `str()`.

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

- Batch (Sync, `universal-3-6-pro`): 32 languages, auto-detected when no
  `language_codes` are sent.
- Streaming (`assemblyai-stt-3-7-*`, `universal-3-6-pro`): 32 languages with native
  code switching. Omit `language_codes` for full multilingual behavior; send one or
  more codes to steer accuracy.
- Supported codes: `af`, `ar`, `yue`, `ca`, `da`, `nl`, `en`, `et`, `fi`, `fr`, `gl`,
  `de`, `he`, `hi`, `it`, `ja`, `ko`, `zh`, `mr`, `no`, `nn`, `fa`, `pt`, `ro`, `ru`,
  `es`, `sv`, `tr`, `ur`, `vi`, `xh`, `zu`.

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
  streaming_model: "assemblyai-stt-3-7-realtime"
  # api_url: "https://sync.eu.assemblyai.com"
  # streaming_url: "wss://streaming.eu.assemblyai.com"
  # batch_options:                     # merged into the Sync config object
  #   prompt: "Dictation of technical notes."
  #   timestamps: true
  # streaming_options:                 # merged into the v3 connection query
  #   keyterms_prompt: ["Kubernetes", "OAuth"]
  #   min_turn_silence: 400
```

## References

- Sync API: https://www.assemblyai.com/docs/api-reference/sync-api/transcribe
- Sync limits: https://www.assemblyai.com/docs/sync-stt/audio-requirements
- Streaming API: https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
- Streaming keyterms and prompts: https://www.assemblyai.com/docs/streaming/prompting-and-keyterms
- Supported streaming languages: https://www.assemblyai.com/docs/streaming/multilingual-transcription
- Models: https://www.assemblyai.com/llms/models.md
- Data retention: https://www.assemblyai.com/docs/data-retention-and-model-training
