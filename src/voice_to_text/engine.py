"""Async recording engine — state machine for the D-Bus service.

States:
  idle       Waiting for StartRecording call
  recording  AudioRecorder is actively capturing audio
  processing Audio stopped, transcription running

Audio capture lives in ``recorder.py``; this module owns the recording
lifecycle and the transcription pipeline.
"""

import asyncio
import contextlib
import logging
import os
import shutil
import tempfile
import time as _time
from collections.abc import Callable
from enum import Enum
from typing import Any

from voice_to_text.audio import SpeakerVolumeManager
from voice_to_text.config import ConfigManager
from voice_to_text.dotool_typer import DotoolcNotFoundError, DotoolTyper
from voice_to_text.hybrid import HybridTranscriber
from voice_to_text.mutter_virtual_paster import MutterVirtualPaster
from voice_to_text.mutter_virtual_typer import MutterVirtualTyper
from voice_to_text.postprocess import postprocess
from voice_to_text.providers import get_batch_provider, get_streaming_provider
from voice_to_text.providers.base import BatchProvider
from voice_to_text.recorder import AsyncAudioRecorder

logger = logging.getLogger(__name__)


SAMPLE_RATE = 16000
BLOCK_SIZE = 2048
PREROLL_BUFFER_SIZE = 33  # ~4 seconds at 2048 samples/frame, 16kHz
PREROLL_MAX_FRAMES = PREROLL_BUFFER_SIZE * 3  # cap buffer growth to prevent memory issues


class EngineState(Enum):
    """State machine for the audio engine."""

    IDLE = "idle"
    RECORDING = "recording"
    PROCESSING = "processing"


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
        self._batch_provider: BatchProvider | None = None
        self._task: asyncio.Task | None = None
        self._cancel_event = asyncio.Event()
        self._skip_output = False
        self._typer: DotoolTyper | MutterVirtualTyper | MutterVirtualPaster | None = None
        self._profile_timings: list[tuple[str, float]] = []
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

    def _make_profiler(self) -> tuple[bool, Callable[[str], None]]:
        """Return (profiling_enabled, step) — step records elapsed time per label."""
        config_mgr = ConfigManager()
        profiling_enabled = config_mgr.config.get("profiling", False)
        if not profiling_enabled:
            return False, lambda label: None
        self._profile_timings = []  # (label, elapsed)
        t0 = _time.monotonic()

        def _step(label: str) -> None:
            now = _time.monotonic()
            elapsed = now - t0
            self._profile_timings.append((label, elapsed))
            logger.info("[PROFIL] %.3fs total, step=%s", elapsed, label)

        return True, _step  # type: ignore[return-value]

    async def _init_typer(
        self, config: dict[str, Any]
    ) -> DotoolTyper | MutterVirtualTyper | MutterVirtualPaster | None:
        """Create and start the output typer based on output_method config."""
        output_method = config.get("output_method", "mutter-virtual")
        logger.info("Engine config: output_method=%s", output_method)
        typer: DotoolTyper | MutterVirtualTyper | MutterVirtualPaster | None = None
        try:
            if output_method == "mutter-virtual":
                typer = MutterVirtualTyper()
                await typer.start()
            elif output_method == "mutter-commit":
                typer = MutterVirtualPaster()
                await typer.start()
            elif output_method == "type":
                typer = DotoolTyper()
                await typer.start()
            else:
                logger.warning("Unsupported output_method %r, no output will be typed", output_method)
            logger.info("Output method %s initialized", output_method)
        except DotoolcNotFoundError as e:
            logger.warning("Typing requested but dotoolc not found: %s", e)
            typer = None
            if self.on_error:
                self.on_error(f"Typing not available: {e}")
        self._typer = typer
        return typer

    async def _run_debug_mode(self, config: dict[str, Any], typer) -> None:
        """Handle debug-mode recording (test file instead of microphone)."""
        # handle_debug_recording is guaranteed importable when is_debug_mode() is True
        from voice_to_text.debug import handle_debug_recording  # noqa: PLC0415

        self.state = EngineState.RECORDING
        self._notify_state()
        text = await handle_debug_recording(config, on_level=self.on_audio_level, _cancel_event=self._cancel_event)
        self.state = EngineState.PROCESSING
        self._notify_state()
        if text and typer:
            await typer.stream_diff(text)
        logger.info("DEBUG MODE: Transcription complete")

    async def _init_transcriber(self, config: dict[str, Any]) -> tuple[HybridTranscriber | None, BatchProvider | None]:
        """Create transcriber/providers based on provider + mode config."""
        provider = config.get("provider", "voxtral")
        mode = config.get("mode", "batch")
        config_mgr = ConfigManager()

        if mode not in ("hybrid", "streaming"):
            provider_config = config_mgr.get_provider_config(provider)
            # Construct the provider in a worker thread: its __init__ may
            # run blocking I/O (e.g. API key resolution).
            batch_provider = await asyncio.to_thread(get_batch_provider, provider, provider_config)
            return None, batch_provider

        transcription_cfg = config_mgr.config.get("transcription") or {}
        hybrid_cfg = transcription_cfg.get("hybrid") or {}
        streaming_name = config.get("streaming_provider") or hybrid_cfg.get("streaming_provider", "deepgram")
        streaming_config = config_mgr.get_provider_config(streaming_name)
        if mode == "hybrid":
            batch_name = config.get("batch_provider") or hybrid_cfg.get("batch_provider", "voxtral")
            batch_config = config_mgr.get_provider_config(batch_name)
            # Construct providers in worker threads: their __init__
            # may run blocking I/O (e.g. API key resolution).
            streaming_provider = await asyncio.to_thread(get_streaming_provider, streaming_name, streaming_config)
            batch_provider = await asyncio.to_thread(get_batch_provider, batch_name, batch_config)
        else:
            # streaming mode — use streaming provider as both
            streaming_provider = await asyncio.to_thread(get_streaming_provider, streaming_name, streaming_config)
            batch_provider = None  # no batch in pure streaming mode
        transcriber = HybridTranscriber(streaming_provider, batch_provider or streaming_provider)  # type: ignore[arg-type]
        return transcriber, batch_provider

    async def _record_and_transcribe(
        self,
        config: dict[str, Any],
        engine_cfg: dict[str, Any],
        typer,
        transcriber: HybridTranscriber | None,
        batch_provider: BatchProvider | None,
        _step: Callable[[str], None],
    ) -> None:
        """Record audio, stream partials, then transcribe and output the result."""
        filepath = await self._start_recording(config, engine_cfg, transcriber, _step)
        if filepath is None:
            return

        language = config.get("language", "en")
        if self._skip_output:
            logger.info("Output skipped (cancel)")
            if typer and isinstance(typer, MutterVirtualPaster):
                await typer.flush()
            if filepath:
                with contextlib.suppress(OSError):
                    os.unlink(filepath)
            return
        if not filepath:
            return

        try:
            text = await self._transcribe(config, filepath, language, transcriber, batch_provider)
            _step("transcription_done")
            text = self._postprocess(config, text, language)
            _step("postprocess_done")

            if self._skip_output:
                logger.info("Output skipped (cancel) after transcription")
                if typer and isinstance(typer, MutterVirtualPaster):
                    await typer.flush()
                return

            await self._output_text(typer, text)
            _step("output_done")
            logger.info("Transcription completed: %d characters", len(text) if text else 0)
        finally:
            self._store_audio(filepath)

    async def _start_recording(
        self,
        config: dict[str, Any],
        engine_cfg: dict[str, Any],
        transcriber: HybridTranscriber | None,
        _step: Callable[[str], None],
    ) -> str | None:
        """Create the recorder, start it, and run the recording loop.

        Returns the stopped recorder's filepath, or None if cancelled before start.
        """
        language = config.get("language", "en")
        decrease_pct = config.get("decrease_speaker_volume", 50)
        fd, audio_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        raw_device = config.get("device")
        device = None if raw_device in (None, "", "__system_default__") else raw_device
        vad_enabled = config.get("vad_enabled", engine_cfg.get("vad_enabled", True))
        recorder = AsyncAudioRecorder(
            device=device,
            sample_rate=SAMPLE_RATE,
            vad_enabled=vad_enabled,
        )
        self._recorder = recorder

        # Enable preroll buffer for batch mode only (not streaming)
        preroll_config = config.get("preroll_enabled")
        use_preroll = preroll_config if preroll_config is not None else not transcriber
        recorder.enable_preroll(use_preroll)
        if use_preroll:
            logger.info("Preroll buffer enabled for batch mode")
        if not vad_enabled:
            logger.info("Silero VAD disabled via config")

        with SpeakerVolumeManager.with_decrease(decrease_pct):
            if self._cancel_event.is_set():
                with contextlib.suppress(OSError):
                    os.unlink(audio_path)
                return None
            await recorder.start(audio_path)
            self.state = EngineState.RECORDING
            self._notify_state()
            _step("recorder_started")
            logger.info("Engine: recording started")

            if transcriber:
                await transcriber.start_stream(language, sample_rate=recorder.sample_rate)
                _step("stream_started")

            filepath = await self._recording_loop(recorder, transcriber, self._typer)

        # Stop microphone before transitioning to processing
        _step("recording_stopped")
        self.state = EngineState.PROCESSING
        self._notify_state()
        return filepath

    async def _recording_loop(self, recorder, transcriber, typer) -> str | None:
        """Read chunks until cancellation or stream end; returns stopped recorder filepath."""
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

        return recorder.stop()

    async def _transcribe(
        self,
        config: dict[str, Any],
        filepath: str,
        language: str,
        transcriber: HybridTranscriber | None,
        batch_provider: BatchProvider | None,
    ) -> str | None:
        """Run batch or hybrid transcription on the recorded file."""
        postprocess_cfg = ConfigManager().config.get("postprocess", {})
        raw_custom_words = config.get("custom_words")
        custom_words = raw_custom_words if raw_custom_words is not None else postprocess_cfg.get("custom_words", [])
        if transcriber:
            return await transcriber.on_recording_stop(filepath, language, custom_words)
        assert batch_provider is not None
        return await batch_provider.transcribe_file(filepath, language, custom_words)

    def _postprocess(self, config: dict[str, Any], text: str | None, language: str) -> str | None:
        """Apply text post-processing if enabled."""
        if not text:
            return text
        postprocess_cfg = ConfigManager().config.get("postprocess", {})
        if not postprocess_cfg.get("enabled", True):
            return text
        return postprocess(
            text,
            lang=postprocess_cfg.get("language") or language,
            custom_filler_words=postprocess_cfg.get("custom_filler_words"),
        )

    async def _output_text(self, typer, text: str | None) -> None:
        """Apply final stream_diff / flush to the typer."""
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

    async def _close_outputs(self) -> None:
        """Close the typer and active providers, suppressing close errors."""
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

    async def _run(self, config: dict[str, Any]) -> None:
        """Full recording + transcription pipeline (orchestrator)."""
        config_mgr = ConfigManager()
        engine_cfg = config_mgr.config.get("engine", {})
        profiling_enabled, _step = self._make_profiler()

        try:
            _step("config_parsed")
            typer = await self._init_typer(config)
            _step("dotoolc_opened")

            # Check for debug mode (test file instead of microphone)
            # Lazy import to avoid circular dependencies in production builds
            try:
                from voice_to_text.debug import is_debug_mode  # noqa: PLC0415
            except ImportError:

                def is_debug_mode() -> bool:
                    return False

            if is_debug_mode():
                await self._run_debug_mode(config, typer)
                return

            transcriber, batch_provider = await self._init_transcriber(config)
            self._transcriber = transcriber
            self._batch_provider = batch_provider
            _step("providers_initialized")
            logger.info("Engine: providers initialized, starting recorder...")

            await self._record_and_transcribe(config, engine_cfg, typer, transcriber, batch_provider, _step)
        except Exception as e:
            logger.exception("Recording failed")
            if self.on_error:
                self.on_error(str(e))
        finally:
            if profiling_enabled:
                _step("done")
                self._log_profile_summary()
            await self._close_outputs()
            self.state = EngineState.IDLE
            self._notify_state()
            self._cleanup()

    def _log_profile_summary(self) -> None:
        """Log recorded profiling timings (populated by _step)."""
        if not self._profile_timings:
            return
        prev_t = 0.0
        logger.info("[PROFIL] STARTUP TIMING SUMMARY:")
        for label, elapsed in self._profile_timings:
            delta = elapsed - prev_t
            logger.info("[PROFIL]   %s: %.3fs (delta +%.3fs)", label, elapsed, delta)
            prev_t = elapsed
        logger.info("[PROFIL]   TOTAL: %.3fs", self._profile_timings[-1][1])

    def _cleanup(self):
        if self._recorder:
            with contextlib.suppress(Exception):
                self._recorder.stop_and_delete()
            self._recorder = None
        self._transcriber = None
        self._batch_provider = None
        self._task = None

    @staticmethod
    def _store_audio(filepath: str) -> None:
        """Move or delete temp audio file based on recording_action config."""
        if not filepath:
            return
        config_mgr = ConfigManager()
        audio_cfg = config_mgr.config.get("audio") or {}
        if audio_cfg.get("recording_action", "delete") == "save":
            save_dir = "/tmp/voice-to-text"
            os.makedirs(save_dir, exist_ok=True)
            try:
                shutil.move(filepath, os.path.join(save_dir, "last.wav"))
            except OSError as e:
                logger.warning("Failed to save audio to %s: %s", save_dir, e)
        else:
            with contextlib.suppress(OSError):
                os.unlink(filepath)

    def _notify_state(self):
        if self.on_state_change:
            self.on_state_change(self.state)
