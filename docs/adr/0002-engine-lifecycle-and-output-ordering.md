# 0002 — Engine lifecycle and output ordering

- Status: Accepted
- Date: 2026-11-22

## Context

`RecordingEngine` coordinates audio capture, streaming partials, batch transcription,
post-processing and text output. Several orderings are load-bearing and were previously
explained only by inline comments.

## Decisions

### 1. `stop_timeout` is read at construction and validated at `start()`

`__init__` reads `engine.stop_timeout` so `stop()` can enforce a deadline even if it races a
failed `start()`. `start()` re-reads the config, accepts an override only when it parses as a
positive integer, and otherwise falls back to the configured default. Zero, negative and
non-numeric values are not clamped; they select the default.

### 2. A cancelled or failed task keeps a local reference

`_run()` nulls `self._task` in its `finally` block. `stop()`/`cancel()` capture `self._task` in a
local variable before awaiting, because the field may be cleared while the wait is in flight;
the local reference is what lets the second `wait_for` see completion.

### 3. Providers are constructed in a worker thread

Provider `__init__` may perform blocking I/O (API-key resolution, file reads). All provider
construction goes through `asyncio.to_thread` so the D-Bus service's event loop never stalls.
This applies to batch, streaming and hybrid construction.

### 4. In streaming mode the stream's final transcript is the result

When `mode == "streaming"`, `batch_provider` is `None`. The streaming provider's own final
transcript is the output; no second batch round-trip is made. Hybrid mode keeps both.

### 5. `MutterVirtualPaster` buffers during streaming and commits in `flush()`

`stream_diff()` on the paster only stores text. The commit to `Main.inputMethod` happens in
`flush()`. Callers must flush after the final `stream_diff` or the text is dropped. The engine
therefore flushes explicitly for that typer, including on the cancel paths.

### 6. The microphone stops before the state becomes `PROCESSING`

`_start_recording` stops the recorder before emitting `PROCESSING`. This releases the GNOME
recording/privacy indicator at the same moment the UI stops showing "recording", and keeps the
capture device free while the network transcription runs.

### 7. The streaming finalize wait is bounded at two seconds

`STREAM_FINALIZE_TIMEOUT` bounds how long `HybridTranscriber` waits for the streaming server's
final transcript after stop. It is long enough to flush the last audio window and short enough
that a hung connection cannot hold output.

## Consequences

Reordering these steps requires a new decision, not an edit. The output typer contract is
documented in 0001-adjacent code by the `stream_diff`/`flush` docstrings; a future typer must
either commit in `stream_diff` or expose the same buffered `flush` contract.
