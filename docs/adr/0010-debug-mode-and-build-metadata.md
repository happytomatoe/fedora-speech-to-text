# 0010 — Debug mode and optional build metadata

- Status: Accepted
- Date: 2026-11-22

## Context

The service ships a debug path used by the E2E suite and CI, and a build hash that is generated
only in release builds.

## Decisions

### 1. Debug mode fakes audio levels for three seconds

When `VOICE_TO_TEXT_DEBUG_FILE` is set, the engine skips the microphone, simulates a recording for
`DEBUG_RECORDING_DURATION` (3 s) while emitting levels, then transcribes the file. The simulated
level is a deterministic ramp/sine/ramp: E2E screenshots and visual assertions depend on it being
reproducible, so it must not be replaced with random noise.

### 2. Cancel still works during simulation

The debug loop checks the same cancellation event as the real recorder and returns `None` when it
is set, so `CancelRecording` behaves identically in debug and normal mode.

### 3. `_build_info` is optional

`voice_to_text._build_info` is generated at release time and imported under
`contextlib.suppress(ImportError)`. A development checkout has no such module; `source_hash()`
returns `None`. The import must not become unconditional, and the module must not be committed.

## Consequences

Debug mode exercises the real batch provider and post-processing; it is not a mock of the
transcription pipeline. Any new pipeline stage must be added to both paths or debug output will
diverge from production output.
