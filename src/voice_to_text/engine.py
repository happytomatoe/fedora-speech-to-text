"""
Async recording engine — state machine for the D-Bus service.

States:
  idle       Waiting for StartRecording call
  recording  AudioRecorder is actively capturing audio
  processing Audio stopped, transcription running

Audio recording uses ``sd.InputStream`` with an ``asyncio.Queue`` to bridge
the callback thread into the async event loop.
"""

import asyncio
import logging
import os
import tempfile
from collections.abc import Callable
from enum import Enum
from typing import Any

import numpy as np
import sounddevice as sd

from voice_to_text.audio import SpeakerVolumeManager
from voice_to_text.config import ConfigManager
from voice_to_text.hybrid import HybridTranscriber
from voice_to_text.mutter_virtual_typer import MutterVirtualTyper
from voice_to_text.postprocess import postprocess
from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.typer import ContinuousTyper, DotoolcNotFoundError
from voice_to_text.vad import SmoothedVAD

logger = logging.getLogger(__name__)

CLIPBOARD_CMDS = [
    ["wl-copy", "--type", "text/plain"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
]


def _copy_to_clipboard(text: str) -> bool:
    """Copy text to system clipboard via wl-copy/xclip/xsel."""
    import subprocess

    for cmd in CLIPBOARD_CMDS:
        try:
            proc = subprocess.run(cmd, input=text.encode(), timeout=5.0)
            if proc.returncode == 0:
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    logger.warning("No clipboard tool found (tried: wl-copy, xclip, xsel)")
    return False



SAMPLE_RATE = 16000
BLOCK_SIZE = 2048


class EngineState(Enum):
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
        self.device = device
        self.sample_rate = sample_rate
        self.smoothed_level: float = 0.0
        self.frame_count: int = 0
        self._stream: Any = None
        # ~2 minutes of audio buffer (1000 chunks × 2048 samples ÷ 16kHz ≈ 128s)
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
        import wave

        self._filepath = filepath
        self._wav_file = await asyncio.to_thread(wave.open, filepath, "wb")
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
            except Exception as e:  # noqa: BLE001 - try next candidate
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
        """Called from the sounddevice callback thread — put data into queue.

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
        self.smoothed_level = 0.7 * self.smoothed_level + 0.3 * rms
        # Feed VAD with float32 samples
        self._vad.push_frame(float_data)

        def _safe_put():
            try:
                self._queue.put_nowait(raw)
            except asyncio.QueueFull:
                pass  # drop frame if consumer is too slow

        self._loop.call_soon_threadsafe(_safe_put)

    async def read_chunk(self) -> bytes | None:
        """Await the next audio chunk (or None if stopped)."""
        return await self._queue.get()

    def stop(self) -> str | None:
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
        filepath = self.stop()
        if filepath:
            try:
                os.unlink(filepath)
            except OSError:
                pass


class RecordingEngine:
    """Orchestrates the full recording → transcription pipeline asynchronously.

    Attributes:
        state: Current :class:`EngineState`.
        on_audio_level: Callback invoked with a float level (0.0-1.0).
        on_error: Callback invoked with an error message string.
        on_state_change: Callback invoked with the new :class:`EngineState`.
    """

    def __init__(self):
        self.state = EngineState.IDLE
        self._recorder: AsyncAudioRecorder | None = None
        self._transcriber: HybridTranscriber | None = None
        self._batch_provider = None
        self._task: asyncio.Task | None = None
        self._cancel_event = asyncio.Event()
        self._typer: ContinuousTyper | MutterVirtualTyper | None = None
        # Initialize stop_timeout with default (will be overridden in start())
        config_mgr = ConfigManager()
        engine_cfg = config_mgr.config.get("engine", {})
        self._stop_timeout = engine_cfg.get("stop_timeout", 120)

        # Callbacks set by the D-Bus service to emit signals
        self.on_audio_level: Callable[[float], None] | None = None
        self.on_error: Callable[[str], None] | None = None
        self.on_state_change: Callable[[EngineState], None] | None = None

    async def start(self, config: dict[str, Any]) -> None:  # noqa: S7503 - async interface
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
                try:
                    await asyncio.wait_for(task, timeout=5.0)
                except (TimeoutError, asyncio.CancelledError):
                    pass
        if self.state != EngineState.IDLE:
            self.state = EngineState.IDLE
            self._notify_state()

    async def _run(self, config: dict[str, Any]) -> None:
        """Full recording + transcription pipeline."""
        import time as _time

        config_mgr = ConfigManager()
        profiling_enabled = config_mgr.config.get("profiling", False)
        _t0 = _time.monotonic()
        timings: list[tuple[str, float]] = []

        def _step(label: str) -> None:
            if not profiling_enabled:
                return
            now = _time.monotonic()
            elapsed = now - _t0
            timings.append((label, elapsed))
            logger.info("[PROFIL] %.3fs total, step=%s", elapsed, label)

        try:
            output_method = config.get("output_method", "mutter-virtual")
            use_typing = output_method in ("type", "mutter-virtual")
            logger.info("Engine config: output_method=%s, use_typing=%s", output_method, use_typing)
            _step("config_parsed")

            typer = await self._setup_typer(output_method)
            _step("dotoolc_opened")

            if await self._handle_debug_mode(config, typer, output_method):
                return

            language = config.get("language", "en")
            transcriber, batch_provider = await self._init_providers(config)
            self._transcriber = transcriber
            self._batch_provider = batch_provider
            _step("providers_initialized")

            filepath = await self._record_audio(config, transcriber, typer, language, _step)
            if filepath:
                self.state = EngineState.PROCESSING
                self._notify_state()
                try:
                    await self._transcribe_and_output(
                        filepath, config, transcriber, batch_provider, typer, output_method, language
                    )
                    _step("transcription_done")
                finally:
                    try:
                        os.unlink(filepath)
                    except OSError:
                        pass

        except Exception as e:
            logger.exception("Recording failed")
            if self.on_error:
                self.on_error(str(e))
        finally:
            if profiling_enabled and timings:
                self._log_timings(timings)
            await self._cleanup_resources()

    async def _setup_typer(self, output_method: str) -> ContinuousTyper | MutterVirtualTyper | None:
        """Initialize and start the typer based on output method."""
        if output_method not in ("type", "mutter-virtual"):
            return None

        try:
            if output_method == "mutter-virtual":
                typer = MutterVirtualTyper()
                await typer.start()
            else:
                typer = ContinuousTyper()
                await typer.start()
            logger.info("Continuous dotoolc pipe opened for recording session")
            self._typer = typer
            return typer
        except DotoolcNotFoundError as e:
            logger.warning("Typing requested but dotoolc not found: %s", e)
            if self.on_error:
                self.on_error(f"Typing not available: {e}")
            self._typer = None
            return None

    async def _handle_debug_mode(
        self, config: dict[str, Any], typer: ContinuousTyper | MutterVirtualTyper | None, output_method: str
    ) -> bool:
        """Handle debug mode. Returns True if debug mode was used (caller should return)."""
        try:
            from voice_to_text.debug import handle_debug_recording, is_debug_mode
        except ImportError:
            return False

        if not is_debug_mode():
            return False

        logger.info("DEBUG MODE DETECTED: Using test file instead of microphone")
        self.state = EngineState.RECORDING
        self._notify_state()

        assert handle_debug_recording is not None
        text = await handle_debug_recording(config, on_level=self.on_audio_level, _cancel_event=self._cancel_event)

        self.state = EngineState.PROCESSING
        self._notify_state()

        if text and typer:
            await typer.stream_diff(text)
        elif text and output_method == "clipboard":
            await asyncio.to_thread(_copy_to_clipboard, text)
        logger.info("DEBUG MODE: Transcription complete")
        return True

    async def _record_audio(
        self,
        config: dict[str, Any],
        transcriber: HybridTranscriber | None,
        typer: ContinuousTyper | MutterVirtualTyper | None,
        language: str,
        _step: Callable[[str], None],
    ) -> str | None:
        """Record audio and return the filepath, or None if cancelled."""
        decrease_pct = config.get("decrease_speaker_volume", 50)
        fd, audio_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        raw_device = config.get("device")
        device = None if raw_device in (None, "", "__system_default__") else raw_device
        recorder = AsyncAudioRecorder(device=device, sample_rate=SAMPLE_RATE)
        self._recorder = recorder

        with SpeakerVolumeManager.with_decrease(decrease_pct):
            if self._cancel_event.is_set():
                try:
                    os.unlink(audio_path)
                except OSError:
                    pass
                return None

            await recorder.start(audio_path)
            self.state = EngineState.RECORDING
            self._notify_state()
            _step("recorder_started")
            logger.info("Engine: recording started")

            if transcriber:
                await transcriber.start_stream(language, sample_rate=recorder.sample_rate)
                _step("stream_started")

            await self._recording_loop(recorder, transcriber, typer)

        return recorder.stop()

    async def _recording_loop(
        self,
        recorder: AsyncAudioRecorder,
        transcriber: HybridTranscriber | None,
        typer: ContinuousTyper | MutterVirtualTyper | None,
    ) -> None:
        """Read audio chunks and feed to providers."""
        while not self._cancel_event.is_set():
            try:
                chunk = await asyncio.wait_for(recorder.read_chunk(), timeout=0.1)
            except TimeoutError:
                continue
            if chunk is None:
                break

            if self.on_audio_level:
                self.on_audio_level(recorder.smoothed_level)

            if transcriber and typer:
                partial = await transcriber.on_audio_chunk(chunk)
                if partial:
                    await typer.stream_diff(partial)
            elif transcriber:
                await transcriber.on_audio_chunk(chunk)

    def _log_timings(self, timings: list[tuple[str, float]]) -> None:
        """Log profiling timing summary."""
        logger.info("[PROFIL] STARTUP TIMING SUMMARY:")
        prev_t = 0.0
        for label, elapsed in timings:
            delta = elapsed - prev_t
            logger.info("[PROFIL]   %s: %.3fs (delta +%.3fs)", label, elapsed, delta)
            prev_t = elapsed
        logger.info("[PROFIL]   TOTAL: %.3fs", timings[-1][1])

    async def _cleanup_resources(self) -> None:
        """Clean up typer, providers, and reset state."""
        if self._typer:
            try:
                await self._typer.stop()
            except Exception:
                pass
            self._typer = None

        if self._transcriber:
            try:
                await self._transcriber.close()
            except Exception:
                pass
        elif self._batch_provider:
            try:
                await self._batch_provider.close()
            except Exception:
                pass

        self.state = EngineState.IDLE
        self._notify_state()
        self._cleanup()

    async def _init_providers(self, config: dict[str, Any]) -> tuple[HybridTranscriber | None, Any]:
        """Initialize transcription providers based on config."""
        provider = config.get("provider", "voxtral")
        mode = config.get("mode", "batch")

        transcriber: HybridTranscriber | None = None
        batch_provider = None

        config_mgr = ConfigManager()

        if mode in ("hybrid", "streaming"):
            hybrid_cfg = config_mgr.config.get("transcription", {}).get("hybrid", {})
            streaming_name = config.get("streaming_provider") or hybrid_cfg.get("streaming_provider", "deepgram")
            if mode == "hybrid":
                batch_name = config.get("batch_provider") or hybrid_cfg.get("batch_provider", "voxtral")
                streaming_config = config_mgr.get_provider_config(streaming_name)
                batch_config = config_mgr.get_provider_config(batch_name)
                streaming_provider = await asyncio.to_thread(
                    get_streaming_provider, streaming_name, streaming_config
                )
                batch_provider = await asyncio.to_thread(get_batch_provider, batch_name, batch_config)
            else:
                streaming_config = config_mgr.get_provider_config(streaming_name)
                streaming_provider = await asyncio.to_thread(
                    get_streaming_provider, streaming_name, streaming_config
                )
                batch_provider = None
            transcriber = HybridTranscriber(streaming_provider, batch_provider or streaming_provider)  # type: ignore[arg-type]
        else:
            provider_config = config_mgr.get_provider_config(provider)
            batch_provider = await asyncio.to_thread(get_batch_provider, provider, provider_config)

        return transcriber, batch_provider

    async def _transcribe_and_output(
        self,
        filepath: str,
        config: dict[str, Any],
        transcriber: HybridTranscriber | None,
        batch_provider: Any,
        typer: ContinuousTyper | MutterVirtualTyper | None,
        output_method: str,
        language: str,
    ) -> None:
        """Handle transcription, post-processing, and output."""
        config_mgr = ConfigManager()
        postprocess_cfg = config_mgr.config.get("postprocess", {})
        raw_custom_words = config.get("custom_words")
        custom_words = (
            raw_custom_words if raw_custom_words is not None else postprocess_cfg.get("custom_words", [])
        )
        raw_threshold = config.get("custom_words_threshold")
        custom_words_threshold = (
            raw_threshold
            if raw_threshold is not None
            else postprocess_cfg.get("custom_words_threshold", 0.5)
        )

        if transcriber:
            text = await transcriber.on_recording_stop(filepath, language, custom_words)
        else:
            assert batch_provider is not None
            text = await batch_provider.transcribe_file(filepath, language, custom_words)

        if text and postprocess_cfg.get("enabled", True):
            text = postprocess(
                text,
                lang=postprocess_cfg.get("language") or language,
                custom_words=custom_words,
                custom_words_threshold=custom_words_threshold,
                custom_filler_words=postprocess_cfg.get("custom_filler_words"),
            )

        if text and typer and typer._usable:
            await typer.stream_diff(text)
        elif text and typer and not typer._usable:
            logger.warning("Typer is not usable, skipping stream_diff")

        if text and output_method == "clipboard":
            await asyncio.to_thread(_copy_to_clipboard, text)

        logger.info("Transcription completed: %d characters", len(text) if text else 0)
    def _cleanup(self):
        if self._recorder:
            try:
                self._recorder.stop_and_delete()
            except Exception:
                pass
            self._recorder = None
        self._transcriber = None
        self._batch_provider = None
        self._task = None

    def _notify_state(self):
        if self.on_state_change:
            self.on_state_change(self.state)
