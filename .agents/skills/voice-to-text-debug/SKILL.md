---
name: voice-to-text-debug
description: Debug the voice-to-text GNOME Shell extension + Python D-Bus backend, especially the "spinner hangs on recording start" symptom. Use when the mic indicator spinner never stops, recording never starts, or StateChanged/AudioLevel signals misbehave in the nested dev environment.
---

# voice-to-text Debugging

Project-specific debugging for the voice-to-text stack:

- **GNOME extension (JS)** in `gnome-ext/` — panel indicator, spinner, meter, D-Bus proxy.
- **Python D-Bus service (backend)** in `src/voice_to_text/` — `dbus_service.py`, `engine.py`, `typer.py`, `bluetooth.py`, `providers/`.
- **Dev runner**: `just dev` starts an isolated `dbus-run-session` containing BOTH the backend (`voice-to-text-dbus`) and a nested `gnome-shell` running the extension.

## When to use

- Spinner hangs on recording start (the stated symptom).
- Clicking the mic icon / pressing the hotkey shows the spinner forever.
- `StateChanged` / `AudioLevel` signals appear missing.
- Recording starts but the meter never appears, or the UI never returns to idle.

Do NOT guess. Read the backend log first (Phase 1) — it has phase markers that pinpoint the exact blocking call.

## Architecture: why a hung spinner means a stuck / frozen engine

The spinner is driven entirely by D-Bus signals. There is no client-side timeout.

**Start flow (JS):** `extension.js` `_start()`:
1. `this._indicator.setProcessing()` → shows the spinner, hides icon/meter/stop button (`indicator.js` `setProcessing()`).
2. `this._recording = true`.
3. `this._proxy.StartRecordingAsync(config)` — fire and forget.
4. On D-Bus method error → notification + `setRecording(false)` (resets UI). On success → nothing else.

**What hides the spinner:**
- `StateChanged('recording')` → `setRecordingActive()` (`indicator.js`) hides spinner, shows meter.
- `StateChanged('idle')` → `setRecording(false)` → idle UI.

**Backend flow:** `dbus_service.py` `StartRecording()` validates state, parses JSON, then `loop.create_task(self._engine.start(config))` and RETURNS IMMEDIATELY. So `StartRecordingAsync` almost always resolves. The spinner is hidden only when the engine task reaches `EngineState.RECORDING` (`engine.py` `_run()`, ~line 332-333) which emits `StateChanged('recording')` via `_notify_state` → `on_state_change` → the `@signal()` method.

**Key consequence:** If the engine task BLOCKS before reaching `RECORDING` — either raising/hanging in a synchronous call on the event loop, or awaiting something that never completes — then:
- No `StateChanged('recording')` is emitted → spinner never hidden.
- Worse: if the block is a **synchronous call on the asyncio event loop**, the entire loop freezes, so even the eventual signal could not be sent and `AudioLevel` updates stop.

So "spinner hangs" == "engine is stuck/frozen somewhere before `self.state = EngineState.RECORDING`." The log tells you exactly where.

## Phase 1 — Read the backend log (primary evidence)

`just dev` redirects the service to `/tmp/voice-to-text.log` and the shell to `/tmp/gnome-shell-nested.log`:

```bash
tail -n 80 /tmp/voice-to-text.log
tail -n 40 /tmp/gnome-shell-nested.log
```

The backend logs an INFO line at EVERY phase boundary in `engine.py _run()`:

```
Engine config: output_method=..., use_typing=...
Engine: config parsed, opening dotoolc...
Continuous dotoolc pipe opened for recording session      # success
  - or: Typing requested but dotoolc not found: ...       # warning
Engine: dotoolc opened, activating headset...
Engine: headset activated, initializing providers...
Engine: providers initialized, starting recorder...
AsyncAudioRecorder started (rate=16000, device=...)        # sounddevice opened
Engine: recording started                                  # => state RECORDING emitted
```

**Locate the LAST `Engine:` line before the stall.** That pinpoints the culprit:

| Last visible line | Stuck on | Likely cause |
|---|---|---|
| import-time `Traceback` (IndentationError / ImportError) before any `Engine:` line | service never started | broken source; re-run `just dev` (does `reinstall` → `uv tool install -e . --force`) or fix the import. The editable install points at `src/` (see `_editable_impl_voice_to_text.pth` / `direct_url.json` in the uv tool venv), so the source tree IS what runs. |
| `...opening dotoolc...` (no "opened") | `await typer.start()` (`engine.py` ~256) | dotoolc/dotoold pipe not available in nested session; `DOTOOL_PIPE`/`XDG_RUNTIME_DIR` not set; daemon not running |
| `...activating headset...` | `await asyncio.to_thread(activate_headset_mic)` (~273) | Bluetooth mic activation blocking on a `bluetoothctl`/D-Bus call in the isolated session |
| **`...initializing providers...` then a multi-second (10s–40s+) gap with NO further `Engine:` line** | **synchronous `keyring.get_password()` inside `resolve_api_key()` (`providers/base.py` ~94), called from the provider `__init__` during provider construction** | **THE COMMON ROOT CAUSE — see Phase 2. The secret service is unreachable in the nested `dbus-run-session`, so the blocking D-Bus keyring lookup hangs, freezing the event loop before `RECORDING` is ever set.** |
| `...starting recorder...` (no "AsyncAudioRecorder started") | `await recorder.start(audio_path)` (~331) | `sounddevice` cannot open the input device in the nested Wayland session — usually raises (→ `Error` signal) but can block |
| `Engine: recording started` present, but spinner still spins | signal not delivered OR UI bug | see Phase 3 |

If the log stops mid-phase with NO exception and NO "recording started", the engine is BLOCKING on that call. If the stall is at `initializing providers` for a very long time, it is almost certainly the keyring hang (Phase 2).

## Phase 2 — The keyring hang (primary root cause)

`config.yaml` sets `voxtral.api_key_source: "keyring"` and `deepgram.api_key_source: "keyring"`. `resolve_api_key()` (`providers/base.py`) does:

```python
key = keyring_lib.get_password("voice-to-text", provider_name)  # BLOCKING D-Bus round-trip
```

This is called **synchronously** from `VoxtralProvider.__init__` / `DeepgramProvider.__init__` (and others), which `engine._run()` calls directly (not in a thread/executor). Inside the `just dev` `dbus-run-session`, the secret service (`org.freedesktop.secrets`) is unreachable, so `keyring.get_password()` **hangs for tens of seconds** (reproduced: >40s, never returned). Because it runs on the asyncio event loop, it freezes the whole engine before `recorder.start()` → `EngineState.RECORDING` is never set → `StateChanged('recording')` is never emitted → the spinner hangs.

**Confirm it:**
```bash
# In an isolated bus (mirrors the nested dev session):
cat > /tmp/keytime.py <<'PY'
import time, keyring
t=time.monotonic()
try:
    k=keyring.get_password("voice-to-text","voxtral")
    print(f"returned {k!r} in {time.monotonic()-t:.2f}s")
except Exception as e:
    print(f"FAILED in {time.monotonic()-t:.2f}s: {e!r}")
PY
timeout 40 dbus-run-session -- sh -c 'python /tmp/keytime.py'
# Expect: does NOT return within 40s -> this is the hang.
```

**Real log signature:** a `WARNING` line like `Keyring lookup failed for <provider>: [Errno 104] Connection reset by peer, falling back` followed by a long stall at `...initializing providers...` (the exception is eventually raised/caught and it falls back to the env var, but only after the long block).

**Fix (pointer, not prescription):** make the keyring lookup NON-BLOCKING and FAST-FAILING so it cannot freeze the loop:
- Run `keyring.get_password` in a worker thread with a short timeout (e.g. `concurrent.futures.ThreadPoolExecutor` + `future.result(timeout=3)` with `shutdown(wait=False)` so the orphaned thread does not re-block), OR
- `await asyncio.to_thread(...)` if the lookup is moved into an async path, AND/OR wrap the synchronous provider construction in `asyncio.to_thread(get_batch_provider, ...)` inside `engine._run` so provider init never stalls the loop.
Either way the fallback to `api_key_env` / config key already exists, so after a fast failure the env key is used and recording proceeds.

## Phase 3 — If "recording started" IS in the log but spinner still hangs

Now the fault is in signal delivery or the JS UI, not the engine. (In practice this is rare — the keyring hang above is the usual cause.)

1. **Check the extension console.** JS `console.log` goes to the shell journal / LookingGlass:
   ```bash
   journalctl --user -f | grep -i voice
   # or, inside the nested session: Alt+F2 -> lg
   ```
   Look for:
   - `VoiceToText: state changed to recording` → signal arrived but UI not updated (`setRecordingActive`/`_setRecordingUI` bug).
   - No `state changed` line at all → signal never reached the extension.

2. **Bus mismatch (common in `dev`).** Both backend and nested shell run inside the `dbus-run-session` subshell, so they SHOULD share one isolated bus. The host's `busctl`/`gdbus`/`dbus-monitor` target the HOST session bus and will NOT see the nested service. To introspect the nested bus you must run the tool with the nested bus address:
   ```bash
   DBUS_SESSION_BUS_ADDRESS=<nested-addr> gdbus introspect \
     --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText
   DBUS_SESSION_BUS_ADDRESS=<nested-addr> dbus-monitor --session \
     "interface='com.happytomatoe.VoiceToText'"
   ```

3. **Prove signal emission independently.** Start the service in a fresh isolated bus and watch for signals while triggering a recording:
   ```bash
   timeout 20 dbus-run-session -- sh -c '
     voice-to-text-dbus >/tmp/vtt.log 2>&1 &
     sleep 2
     timeout 16 dbus-monitor --session "interface='"'"'com.happytomatoe.VoiceToText'"'"'" >/tmp/vtt-mon.log 2>&1 &
     sleep 1
     gdbus call --session --dest com.happytomatoe.VoiceToText \
       --object-path /com/happytomatoe/VoiceToText \
       --method com.happytomatoe.VoiceToText.StartRecording \
       "{\"provider\":\"voxtral\",\"mode\":\"batch\",\"output_method\":\"none\"}"
     sleep 12   # long enough for the ~provider-init delay
     gdbus call --session --dest com.happytomatoe.VoiceToText \
       --object-path /com/happytomatoe/VoiceToText \
       --method com.happytomatoe.VoiceToText.StopRecording
     sleep 2'
   grep -i 'member=StateChanged\|member=AudioLevel' /tmp/vtt-mon.log
   ```
   NOTE: the real engine takes many seconds (provider init + keyring slow-fail) before `recording started`; short monitor windows miss the signal — that is expected and is itself evidence of the Phase-2 delay, not a missing signal.

4. **AudioLevel missing but state fine** → `on_audio_level` callback / `AudioLevel` signal path (`dbus_service.py` ~62-64, `engine.py` ~354-355). Meter stays flat.

## Phase 4 — Reproduce minimally (optional)

Call the backend directly and watch state/signals without the extension:

```bash
DBUS_SESSION_BUS_ADDRESS=<nested-addr> gdbus call --session \
  --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText \
  --method com.happytomatoe.VoiceToText.StartRecording \
  "{\"provider\":\"voxtral\",\"mode\":\"batch\",\"output_method\":\"none\"}"
```
With `output_method: none` you bypass `dotoolc` entirely — if the spinner now works, the hang was in the typer/headset phase, not the recorder. Use the longer monitor window from Phase 3 step 3 to actually observe `StateChanged`.

## Verification

A debug session is "done" when you can state, with log/evidence:
1. The exact `engine.py _run()` phase where execution stalls (last `Engine:` line), OR
2. That `recording started` is reached and the defect is signal-delivery/UI (with the `journalctl`/introspection evidence above).

Then propose the targeted fix — do not edit code until the stuck phase is proven by the backend log (and, for the keyring case, by the standalone `keyring.get_password` hang).
