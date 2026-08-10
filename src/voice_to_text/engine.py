"""Async recording engine — state machine for the D-Bus service.

States:
  idle       Waiting for StartRecording call
  recording  AudioRecorder is actively capturing audio
  processing Audio stopped, transcription running

Audio recording uses ``sd.InputStream`` with an ``asyncio.Queue`` to bridge
the callback thread into the async event loop.
"""

import asyncio
import contextlib
import logging
import os
import tempfile
import time as _time
import wave
from collections.abc import Callable
from enum import Enum
from typing import Any

import numpy as np
import sounddevice as sd

from voice_to_text.audio import SpeakerVolumeManager
from voice_to_text.config import ConfigManager
from voice_to_text.hybrid import HybridTranscriber
from voice_to_text.mutter_virtual_paster import MutterVirtualPaster
from voice_to_text.mutter_virtual_typer import MutterVirtualTyper
from voice_to_text.postprocess import postprocess
from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.typer import DotoolcNotFoundError, DotoolTyper
from voice_to_text.vad import SmoothedVAD

logger = logging.getLogger(__name__)


SAMPLE_RATE = 16000
BLOCK_SIZE = 2048


class EngineState(Enum):
    """State machine for the audio engine."""

    IDLE = "idle"
    RECORDING = "recording"
    PROCESSING = "processing"


class AsyncAudioRecorder:
    """Records audio using ``sd.InputStream`` (blocking callback) + ``asyncio.Queue``.

    The ``sd.InputStream`` callback runs in a sounddevice-internal thread.
    It writes audio chunks directly to the ``asyncio.Queue``, which is
    thread-safe for ``put_nowait``. The async consumer reads from the queue.
    """

    def __init__(
        self,
        device: int | None = None,
        sample_rate: int = SAMPLE_RATE,
    ):
        """Initialize the audio recorder."""
        self.device = device
        self.sample_rate = sample_rate
        self.smoothed_level: float = 0.0
        self.frame_count: int = 0
        self._stream: Any = None
        # ~2 minutes of audio buffer (1000 chunks x 2048 samples / 16kHz ~ 128s)
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=1000)
        self._wav_file = None
        self._filepath: str | None = None
        # Voice Activity Detection
        self._vad = SmoothedVAD(
            onset_frames=2,
            hangover_frames=15,
            prefill_frames=15,
            threshold=0.01,
            sample_rate=self.sample_rate,
        )

    async def start(self, filepath: str) -> None:
        """Start recording audio to a file."""
        self._filepath = filepath
        fd = os.fdopen(os.open(filepath, os.O_WRONLY | os.O_CREAT, 0o600), "wb")
        self._wav_file = wave.open(fd, "wb")  # noqa: SIM115 - file must stay open for recording duration
        self._wav_file.setnchannels(1)
        self._wav_file.setsampwidth(2)
        self._wav_file.setframerate(self.sample_rate)

        # Store event loop reference for thread-safe callback
        self._loop = asyncio.get_running_loop()

        # When no device is explicitly chosen, prefer "pipewire" so recording
        # routes through PipeWire. This (a) makes GNOME Shell's microphone /
        # privacy recording indicator appear, and (b) selects the correct input
        # on PipeWire systems. Fall back to PortAudio's default only if the
        # pipewire ALSA plugin is unavailable (e.g. non-PipeWire setups).
        # An explicitly selected device is used as-is (no silent fallback).
        candidates = ["pipewire", None] if self.device is None else [self.device]
        last_err: Exception | None = None
        opened_device: object = self.device
        for cand in candidates:
            try:
                self._stream = sd.InputStream(
                    samplerate=self.sample_rate,
                    channels=1,
                    blocksize=BLOCK_SIZE,
                    dtype="int16",
                    callback=self._audio_callback,
                    device=cand,
                )
                self._stream.start()
                opened_device = cand
                break
            except Exception as e:
                last_err = e
                self._stream = None
        else:
            raise last_err or RuntimeError("Failed to open audio input device")

        logger.info(
            "AsyncAudioRecorder started (rate=%d, device=%s)",
            self.sample_rate,
            opened_device,
        )

    def _audio_callback(self, indata: np.ndarray, frames: int, time_info, status):
        """Handle audio data from the sounddevice callback thread.

        Uses ``loop.call_soon_threadsafe`` to safely interact with the
        ``asyncio.Queue`` from the callback thread.
        """
        raw = indata.tobytes()
        if self._wav_file is not None:
            self._wav_file.writeframes(raw)
        self.frame_count += 1
        # Smoothed level for D-Bus AudioLevel signal
        float_data = indata[:, 0].astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(float_data**2)))
        # Convert to dBFS (floor at -50, ceiling at 0) for widget display
        db = 20 * np.log10(max(rms, 1e-5))
        db_normalized = max(0.0, min(1.0, (db + 50) / 50))
        self.smoothed_level = 0.7 * self.smoothed_level + 0.3 * db_normalized
        # Feed VAD with float32 samples
        self._vad.push_frame(float_data)

        def _safe_put():
            with contextlib.suppress(asyncio.QueueFull):
                self._queue.put_nowait(raw)  # drop frame if consumer is too slow

        self._loop.call_soon_threadsafe(_safe_put)

    async def read_chunk(self) -> bytes | None:
        """Await the next audio chunk (or None if stopped)."""
        return await self._queue.get()

    def stop(self) -> str | None:
        """Stop recording and return the filepath."""
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if self._wav_file:
            self._wav_file.close()
            self._wav_file = None
        filepath = self._filepath
        self._filepath = None
        # Signal consumer that no more data
        self._queue.put_nowait(None)
        return filepath

    def stop_and_delete(self) -> None:
        """Stop recording and delete the audio file."""
        filepath = self.stop()
        if filepath:
            with contextlib.suppress(OSError):
                os.unlink(filepath)


class RecordingEngine:
    """Orchestrates the full recording → transcription pipeline asynchronously.

    Attributes:
        state: Current :class:`EngineState`.
        on_audio_level: Callback invoked with a float level (0.0-1.0).
        on_error: Callback invoked with an error message string.
        on_state_change: Callback invoked with the new :class:`EngineState`.

    """

    def __init__(self):
        """Initialize the engine."""
        self.state = EngineState.IDLE
        self._recorder: AsyncAudioRecorder | None = None
        self._transcriber: HybridTranscriber | None = None
        self._batch_provider = None
        self._task: asyncio.Task | None = None
        self._cancel_event = asyncio.Event()
        self._skip_output = False
        self._typer: DotoolTyper | MutterVirtualTyper | MutterVirtualPaster | None = None
        # Initialize stop_timeout with default (will be overridden in start())
        config_mgr = ConfigManager()
        engine_cfg = config_mgr.config.get("engine", {})
        self._stop_timeout = engine_cfg.get("stop_timeout", 120)

        # Callbacks set by the D-Bus service to emit signals
        self.on_audio_level: Callable[[float], None] | None = None
        self.on_error: Callable[[str], None] | None = None
        self.on_state_change: Callable[[EngineState], None] | None = None

    async def start(self, config: dict[str, Any]) -> None:
        """Start recording and transcription."""
        if self.state != EngineState.IDLE:
            raise RuntimeError(f"Cannot start: engine is {self.state.value}")
        self._cancel_event.clear()
        # Validate and resolve stop_timeout from D-Bus config
        config_mgr = ConfigManager()
        engine_cfg = config_mgr.config.get("engine", {})
        default_timeout = engine_cfg.get("stop_timeout", 120)
        raw = config.get("stop_timeout")
        try:
            val = int(raw) if raw is not None else None
        except (TypeError, ValueError):
            val = None
        # Only accept positive integers; otherwise fall back to configured default
        self._stop_timeout = val if (val is not None and val > 0) else default_timeout
        self._task = asyncio.create_task(self._run(config))

    async def stop(self) -> None:
        """Stop recording gracefully."""
        logger.info("Stopping recording (timeout=%ds)", self._stop_timeout)

        self._cancel_event.set()
        task = self._task
        if task and not task.done():
            try:
                await asyncio.wait_for(task, timeout=self._stop_timeout)
            except (TimeoutError, asyncio.CancelledError):
                logger.warning("Recording task did not finish in time (timeout=%ds)", self._stop_timeout)
                task.cancel()
                # If the task's finally block already nulled self._task,
                # that's fine — our local reference still lets us wait
                with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                    await asyncio.wait_for(task, timeout=5.0)
        if self.state != EngineState.IDLE:
            self.state = EngineState.IDLE
            self._notify_state()

    async def cancel(self) -> None:
        """Cancel recording and discard any output."""
        logger.info("Cancelling recording")
        self._skip_output = True
        self._cancel_event.set()
        task = self._task
        if task and not task.done():
            try:
                await asyncio.wait_for(task, timeout=self._stop_timeout)
            except (TimeoutError, asyncio.CancelledError):
                task.cancel()
                with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                    await asyncio.wait_for(task, timeout=5.0)
        self._skip_output = False
        if self.state != EngineState.IDLE:
            self.state = EngineState.IDLE
            self._notify_state()

    async def _run(self, config: dict[str, Any]) -> None:  # noqa: C901, PLR0912, PLR0915
        """Full recording + transcription pipeline."""
        # Check if profiling is enabled
        config_mgr = ConfigManager()
        profiling_enabled = config_mgr.config.get("profiling", False)

        _t0 = _time.monotonic()
        timings: list[tuple[str, float]] = []  # (label, elapsed)

        def _step(label: str) -> None:
            if not profiling_enabled:
                return
            now = _time.monotonic()
            elapsed = now - _t0
            timings.append((label, elapsed))
            logger.info("[PROFIL] %.3fs total, step=%s", elapsed, label)

        try:
            # 1. Determine output method
            output_method = config.get("output_method", "mutter-virtual")
            use_typing = output_method in ("type", "mutter-virtual")
            logger.info("Engine config: output_method=%s, use_typing=%s", output_method, use_typing)
            _step("config_parsed")
            logger.info("Engine: config parsed, opening dotoolc...")

            # 2. Open dotoolc pipe early if typing
            typer: DotoolTyper | MutterVirtualTyper | MutterVirtualPaster | None = None
            if use_typing or output_method == "mutter-commit":
                try:
                    if output_method == "mutter-virtual":
                        mutter = MutterVirtualTyper()
                        await mutter.start()
                        typer = mutter
                    elif output_method == "mutter-commit":
                        mutter_paste = MutterVirtualPaster()
                        await mutter_paste.start()
                        typer = mutter_paste
                    else:
                        typer = DotoolTyper()
                        await typer.start()
                    logger.info("Output method %s initialized", output_method)
                except DotoolcNotFoundError as e:
                    logger.warning("Typing requested but dotoolc not found: %s", e)
                    if self.on_error:
                        self.on_error(f"Typing not available: {e}")
            self._typer = typer

            _step("dotoolc_opened")

            # 3. Check for debug mode (test file instead of microphone)
            # Lazy import to avoid circular dependencies in production builds
            try:
                from voice_to_text.debug import handle_debug_recording, is_debug_mode  # noqa: PLC0415
            except ImportError:

                def is_debug_mode() -> bool:
                    return False

                handle_debug_recording = None

            if is_debug_mode():
                logger.info("DEBUG MODE DETECTED: Using test file instead of microphone")
                self.state = EngineState.RECORDING
                self._notify_state()

                # handle_debug_recording is guaranteed non-None when is_debug_mode() is True
                assert handle_debug_recording is not None, (
                    "handle_debug_recording must be set when debug mode is active"
                )
                text = await handle_debug_recording(
                    config, on_level=self.on_audio_level, _cancel_event=self._cancel_event
                )

                self.state = EngineState.PROCESSING
                self._notify_state()

                # Output the result
                if text and typer:
                    await typer.stream_diff(text)
                logger.info("DEBUG MODE: Transcription complete")
                return  # Exit early, skip normal recording flow

            # 4. Set up providers
            provider = config.get("provider", "voxtral")
            mode = config.get("mode", "batch")
            language = config.get("language", "en")

            transcriber: HybridTranscriber | None = None
            batch_provider = None

            if mode in ("hybrid", "streaming"):
                config_mgr = ConfigManager()
                hybrid_cfg = config_mgr.config.get("transcription", {}).get("hybrid", {})
                streaming_name = config.get("streaming_provider") or hybrid_cfg.get("streaming_provider", "deepgram")
                if mode == "hybrid":
                    batch_name = config.get("batch_provider") or hybrid_cfg.get("batch_provider", "voxtral")
                    streaming_config = config_mgr.get_provider_config(streaming_name)
                    batch_config = config_mgr.get_provider_config(batch_name)
                    # Construct providers in a worker thread: their __init__
                    # may run blocking I/O (e.g. API key resolution).
                    streaming_provider = await asyncio.to_thread(
                        get_streaming_provider, streaming_name, streaming_config
                    )
                    batch_provider = await asyncio.to_thread(get_batch_provider, batch_name, batch_config)
                else:
                    # streaming mode — use streaming provider as both
                    streaming_config = config_mgr.get_provider_config(streaming_name)
                    streaming_provider = await asyncio.to_thread(
                        get_streaming_provider, streaming_name, streaming_config
                    )
                    batch_provider = None  # no batch in pure streaming mode
                transcriber = HybridTranscriber(streaming_provider, batch_provider or streaming_provider)  # type: ignore[arg-type]
            else:
                config_mgr = ConfigManager()
                provider_config = config_mgr.get_provider_config(provider)
                # Construct the provider in a worker thread: its __init__ may
                # run blocking I/O (e.g. API key resolution).
                batch_provider = await asyncio.to_thread(get_batch_provider, provider, provider_config)

            self._transcriber = transcriber
            self._batch_provider = batch_provider
            _step("providers_initialized")
            logger.info("Engine: providers initialized, starting recorder...")

            # 5. Record audio via InputStream + Queue
            decrease_pct = config.get("decrease_speaker_volume", 50)
            fd, audio_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)

            raw_device = config.get("device")
            device = None if raw_device in (None, "", "__system_default__") else raw_device
            recorder = AsyncAudioRecorder(
                device=device,
                sample_rate=SAMPLE_RATE,
            )
            self._recorder = recorder

            with SpeakerVolumeManager.with_decrease(decrease_pct):
                if self._cancel_event.is_set():
                    with contextlib.suppress(OSError):
                        os.unlink(audio_path)
                    return
                await recorder.start(audio_path)
                self.state = EngineState.RECORDING
                self._notify_state()
                _step("recorder_started")
                logger.info("Engine: recording started")

                # Start streaming if in hybrid mode
                if transcriber:
                    await transcriber.start_stream(language, sample_rate=recorder.sample_rate)
                    _step("stream_started")

                # Recording loop — read chunks from the queue
                # Use a short timeout so cancellation is responsive even
                # when no audio data arrives (no microphone signal etc.)
                while not self._cancel_event.is_set():
                    try:
                        chunk = await asyncio.wait_for(recorder.read_chunk(), timeout=0.1)
                    except TimeoutError:
                        continue  # no data yet, re-check cancellation
                    if chunk is None:
                        break  # stream ended

                    # Emit audio level for D-Bus signal
                    if self.on_audio_level:
                        self.on_audio_level(recorder.smoothed_level)

                    # Feed streaming provider + type incrementally
                    if transcriber and typer:
                        partial = await transcriber.on_audio_chunk(chunk)
                        if partial:
                            await typer.stream_diff(partial)
                    elif transcriber:
                        await transcriber.on_audio_chunk(chunk)

            # 6. Stop microphone before transitioning to processing
            filepath = recorder.stop()
            _step("recording_stopped")
            self.state = EngineState.PROCESSING
            self._notify_state()
            if self._skip_output:
                logger.info("Output skipped (cancel)")
                if typer and isinstance(typer, MutterVirtualPaster):
                    await typer.flush()
                if filepath:
                    with contextlib.suppress(OSError):
                        os.unlink(filepath)
                return
            if filepath:
                try:
                    postprocess_cfg = config_mgr.config.get("postprocess", {})
                    raw_custom_words = config.get("custom_words")
                    custom_words = (
                        raw_custom_words if raw_custom_words is not None else postprocess_cfg.get("custom_words", [])
                    )
                    if transcriber:
                        text = await transcriber.on_recording_stop(filepath, language, custom_words)
                    else:
                        assert batch_provider is not None
                        text = await batch_provider.transcribe_file(filepath, language, custom_words)
                    _step("transcription_done")
                    # Apply text post-processing
                    if text:
                        postprocess_cfg = config_mgr.config.get("postprocess", {})
                        if postprocess_cfg.get("enabled", True):
                            text = postprocess(
                                text,
                                lang=postprocess_cfg.get("language") or language,
                                custom_filler_words=postprocess_cfg.get("custom_filler_words"),
                            )
                    _step("postprocess_done")

                    # Check cancellation again after transcription completes
                    if self._skip_output:
                        logger.info("Output skipped (cancel) after transcription")
                        if typer and isinstance(typer, MutterVirtualPaster):
                            await typer.flush()
                        return

                    # If we were typing incrementally, apply final corrections
                    if text and typer and typer._usable:
                        logger.info(
                            "Applying final stream_diff with typer=%s, text_len=%d",
                            type(typer).__name__,
                            len(text),
                        )
                        await typer.stream_diff(text)
                        # For MutterVirtualPaster, commit the accumulated text after streaming
                        if isinstance(typer, MutterVirtualPaster):
                            await typer.flush()
                    elif text and typer and not typer._usable:
                        logger.warning("Typer is not usable, skipping stream_diff")

                    _step("output_done")

                    logger.info("Transcription completed: %d characters", len(text) if text else 0)

                finally:
                    # Clean up temp WAV file after transcription
                    with contextlib.suppress(OSError):
                        os.unlink(filepath)

        except Exception as e:
            logger.exception("Recording failed")
            if self.on_error:
                self.on_error(str(e))
        finally:
            # Log timing summary only if profiling enabled
            if profiling_enabled and timings:
                _step("done")
                logger.info("[PROFIL] STARTUP TIMING SUMMARY:")
                prev_t = 0.0
                for label, elapsed in timings:
                    delta = elapsed - prev_t
                    logger.info("[PROFIL]   %s: %.3fs (delta +%.3fs)", label, elapsed, delta)
                    prev_t = elapsed
                logger.info("[PROFIL]   TOTAL: %.3fs", timings[-1][1])

            # Close dotoolc pipe
            if self._typer:
                with contextlib.suppress(Exception):
                    await self._typer.stop()
                self._typer = None
            # Close providers
            if self._transcriber:
                with contextlib.suppress(Exception):
                    await self._transcriber.close()
            elif self._batch_provider:
                with contextlib.suppress(Exception):
                    await self._batch_provider.close()
            self.state = EngineState.IDLE
            self._notify_state()
            self._cleanup()

    def _cleanup(self):
        if self._recorder:
            with contextlib.suppress(Exception):
                self._recorder.stop_and_delete()
            self._recorder = None
        self._transcriber = None
        self._batch_provider = None
        self._task = None

    def _notify_state(self):
        if self.on_state_change:
            self.on_state_change(self.state)
