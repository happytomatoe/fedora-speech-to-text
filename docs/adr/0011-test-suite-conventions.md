# 0011 — Test suite conventions and fake-server constraints

- Status: Accepted
- Date: 2026-11-22

## Context

The provider tests fake HTTP and websocket servers. Several assertions are only correct because
of how the fakes and the ambient environment behave; the reasoning was previously inline.

## Decisions

### 1. Provider key tests must clear the ambient environment

`resolve_api_key` prefers environment variables over the config file, so a developer's real
`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `VOXTRAL_API_KEY` or `MISTRAL_API_KEY` would override
the mock key. Tests that exercise config-file key resolution unset those variables for their
duration.

### 2. Multipart assertions use the server log, not `data=`

`pytest-httpserver`'s `data=` matcher compares raw body bytes, which never match a multipart body
because httpx generates a random boundary per request. Match on URI and method, then assert the
decoded form fields from `httpserver.log[-1][0].form`.

For httpx, ordinary form fields live in `data` and the uploaded file in `files`. A configured
language is forwarded as ISO-639-1 (`en`), even when the mocked response uses `eng`.

### 3. 60db fake frames must mirror the protocol

The fake server pre-queues `connection_established`, `connected` and `session_started` on
connect; the provider blocks until the handshake is complete and sends `start` only afterwards. A
`speech_final` frame with empty text is an end-of-speech signal and must be skipped, not emitted
as an empty transcript.

### 4. AssemblyAI live text accumulates

A finalized turn already contains its whole text, and the live transcript is finalized turns plus
the still-open partial. Appending a final turn to the open partial would duplicate words.

### 5. Post-processing tests encode real-language false positives

`um` is a Portuguese article and `ha` is a Spanish verb form, so neither may be in that language's
filler list; the unknown-language fallback is deliberately conservative and also omits them.
Removing these assertions would reintroduce word deletion in those languages.

### 6. dbus-next state is asserted through `_state`

The `@method()` decorator intercepts direct calls, so a test of the interface's state reads
`interface._state` rather than calling `GetStatus()`. This avoids a bus round trip but couples the
test to the attribute name.

### 7. Device-list sentinel ordering

`ListInputDevices` must return `__system_default__` first; the preferences device picker relies
on that position.

### 8. Config-manager failure injection needs a non-existent nested path

The mkdir-failure test uses a target below a non-existent directory so `ConfigManager.__init__`
takes the empty-config branch and `save()` reaches `mkdir`. An existing directory would bypass the
injected failure.

Placeholder WAV bytes are sufficient for mocked-server tests; the server never decodes them, only
the multipart shape is asserted.

## Consequences

Fakes are protocol fixtures, not convenience mocks. When a provider's wire format changes, its
fake and the fake's queued frames must change together.
