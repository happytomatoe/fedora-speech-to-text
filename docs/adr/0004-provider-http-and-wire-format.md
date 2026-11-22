# 0004 — Provider HTTP, key resolution and wire-format quirks

- Status: Accepted
- Date: 2026-11-22

## Context

Transcription providers share an HTTP client, an API-key resolver and a streaming base class,
but each remote API has a wire format that punishes "obvious" implementations. These facts were
previously recorded as comments spread across `providers/`.

## Decisions

### 1. One shared `httpx.AsyncClient`

All providers use `get_shared_client()`, a lazily created module-level `AsyncClient`, instead of
constructing a client per recording. Constructing a client costs roughly 300 ms, which would be
added to the first-words latency of every recording. Connection pool limits are therefore
global; providers must not create per-request clients.

### 2. `!!command` keys are deferred, `!command` keys run synchronously

`resolve_api_key()` is synchronous and cannot create an asyncio Future on a running loop. A
`!!command` key is therefore returned verbatim and `AsyncKeyMixin._ensure_api_key()` creates the
Future later, inside the event loop. A single `!` key is executed synchronously during
resolution. Neither form may be executed during config validation (see 0008).

### 3. The websocket attribute is typed `Any`

The shared streaming base stores `websockets.WebSocketClientProtocol | None` in an `Any` field to
avoid importing the library's protocol type at module scope. The concrete type still matters for
`send`/`recv`/`close`; do not replace the field with a looser abstraction.

### 4. Custom-provider templates use `NativeEnvironment` and a key sentinel

Template values are rendered with Jinja2's `NativeEnvironment` so JSON body fields keep native
types: `{{ CUSTOM_WORDS }}` must produce a list, not the string `"['a', 'b']"`.

Headers are rendered even when no API key is configured. `API_KEY` is given a sentinel value
under `ChainableUndefined`, because `StrictUndefined` would raise on `{% if API_KEY %}` and drop
headers that are valid without a key. If the sentinel survives into the rendered value, the
header depends on a bare unresolved `API_KEY` and is skipped; an unfilled `Bearer ` is an invalid
header value.

### 5. A configured audio file forces multipart encoding

When the request carries an audio file it is multipart regardless of config, so configured
`json` body fields ride along as additional multipart form fields, and list values become
repeated keys.

`httpx.AsyncClient` mis-detects a list-of-tuples `data=` payload as a synchronous stream (httpx
issue #3471), so form data is passed as a dict. Repeated keys cannot be represented in a dict and
are supplied through `files=` as `(name, (None, value))` tuples, which httpx encodes as extra
multipart fields.

### 6. Provider-specific wire rules

- **AssemblyAI**: the Sync upload validates the part's content type, derived from the filename
  suffix (`_AUDIO_CONTENT_TYPES`, default `audio/wav`). A single generic content type breaks it.
  Keyterm prompting is capped by the service at 100 terms per request and 8 000 characters
  across Sync keyterms (`_MAX_KEYTERMS`, `_MAX_BATCH_KEYTERM_CHARS`); `_SUPPORTED_LANGUAGES`
  mirrors the documented Sync/streaming language set.
- **ElevenLabs**: accepts ISO-639-1 and ISO-639-3 codes. A configured language is forwarded
  (2–3 characters) and deliberately overrides server-side auto-detection.
- **Moonshine**: `moonshine_voice` is imported on first use because importing it is slow and
  would delay service startup. `Transcriber.stop` runs in a thread because it blocks and could
  otherwise outlive the caller's timeout.
- **60db**: the server's `connection_established` (authentication) message must arrive before
  `start` is sent; the provider waits up to 10 s. That signal is accepted in two shapes: a
  top-level object key or `msg["type"] == "connection_established"`. Binary websocket frames are
  telephony μ-law audio and are intentionally ignored by the JSON protocol client.
- **Voxtral**: `context_bias` rejects entries containing spaces or commas, so custom words are
  split into individual terms. The Mistral SDK reads `MISTRAL_API_KEY`; when only
  `VOXTRAL_API_KEY` is configured, `os.environ.setdefault` bridges the resolved key without
  overwriting an existing `MISTRAL_API_KEY`. The dedicated streaming loop is stopped through
  `run_in_executor` because the caller runs on a different loop/thread.

## Consequences

Adding a provider means reusing the shared client and the key resolver; bypassing either is a
review finding. Wire quirks above are contractual and should be covered by provider tests rather
than re-documented in comments.
