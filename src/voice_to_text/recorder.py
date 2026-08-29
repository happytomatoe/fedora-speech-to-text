"""Async audio recorder for the D-Bus recording engine.

``AsyncAudioRecorder`` wraps a ``sounddevice`` ``InputStream`` whose blocking
callback runs on a sounddevice-internal thread. The callback writes audio
chunks into a thread-safe ``asyncio.Queue``; the async consumer drains the
queue, appends to a WAV file, and feeds VAD and the preroll buffer.

Split out of ``engine.py``: this module owns capture, not orchestration.
"""

import asyncio
import contextlib
import logging
import os
import tempfile
import threading
import wave
from typing import Any

import numpy as np
import sounddevice as sd

from voice_to_text.preroll import PrerollFrameMetadata, select_preroll_frames
from voice_to_text.vad import SileroVAD, SmoothedVAD, VADFrame

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
BLOCK_SIZE = 2048
PREROLL_BUFFER_SIZE = 33  # ~4 seconds at 2048 samples/frame, 16kHz
PREROLL_MAX_FRAMES = PREROLL_BUFFER_SIZE * 3  # cap buffer growth to prevent memory issues


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
        vad_enabled: bool = True,
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
        self._vad_enabled = vad_enabled
        self._vad: SmoothedVAD | None = None
        if vad_enabled:
            self._vad = SmoothedVAD(
                inner=SileroVAD(
                    threshold=0.5,
                    sample_rate=self.sample_rate,
                ),
                onset_frames=2,
                hangover_frames=15,
                prefill_frames=15,
            )
        # Preroll buffer: stores ALL frames before VAD triggers (unbounded list).
        # At 2048 samples/frame and 16kHz, each frame is ~128ms.
        # Used to select and prepend clean pre-speech audio on stop().
        self._preroll_enabled = False
        self._preroll_buffer: list[bytes] = []
        self._preroll_skipped = 0  # frames skipped from WAV (to avoid duplication)
        self._preroll_metadata: list[PrerollFrameMetadata] = []  # guarded by _preroll_lock
        self._preroll_lock = threading.Lock()

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

    def _audio_callback(self, indata: np.ndarray, frames: int, _time_info, status):
        """Handle audio data from the sounddevice callback thread.

        Uses ``loop.call_soon_threadsafe`` to safely interact with the
        ``asyncio.Queue`` from the callback thread.
        """
        raw = indata.tobytes()

        # Smoothed level for D-Bus AudioLevel signal
        float_data = indata[:, 0].astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(float_data**2)))
        # Convert to dBFS (floor at -50, ceiling at 0) for widget display
        db = 20 * np.log10(max(rms, 1e-5))
        db_normalized = max(0.0, min(1.0, (db + 50) / 50))
        self.smoothed_level = 0.7 * self.smoothed_level + 0.3 * db_normalized
        # Feed VAD with float32 samples
        vad_result = self._vad.push_frame(float_data) if self._vad is not None else None

        # Append to preroll buffer if enabled
        if self._preroll_enabled:
            with self._preroll_lock:
                # Skip writing preroll frames to WAV — they'll be prepended on stop.
                if self._wav_file is not None and self._preroll_skipped < PREROLL_BUFFER_SIZE:
                    self._preroll_skipped += 1
                elif self._wav_file is not None:
                    self._wav_file.writeframes(raw)
                # Cap buffer to prevent unbounded memory growth
                if len(self._preroll_buffer) < PREROLL_MAX_FRAMES:
                    self._preroll_buffer.append(raw)
                is_speech = vad_result == VADFrame.SPEECH if vad_result is not None else None
                self._preroll_metadata.append(
                    PrerollFrameMetadata(
                        sample_count=len(float_data),
                        is_speech=is_speech,
                        rms=rms,
                    )
                )
        elif self._wav_file is not None:
            self._wav_file.writeframes(raw)

        self.frame_count += 1

        def _safe_put() -> None:
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

        # Prepend preroll audio to WAV file if enabled
        if self._preroll_enabled and filepath:
            self._prepend_preroll_to_wav(filepath)

        # Clear preroll state
        self._preroll_skipped = 0
        self._preroll_enabled = False
        with self._preroll_lock:
            self._preroll_buffer.clear()
            self._preroll_metadata.clear()

        return filepath

    def enable_preroll(self, enabled: bool = True) -> None:
        """Enable or disable the preroll buffer."""
        self._preroll_enabled = enabled
        if not enabled:
            with self._preroll_lock:
                self._preroll_skipped = 0
                self._preroll_buffer.clear()
                self._preroll_metadata.clear()

    def enable_vad(self, enabled: bool = True) -> None:
        """Enable or disable the Silero VAD."""
        if enabled and self._vad is None:
            self._vad = SmoothedVAD(
                inner=SileroVAD(
                    threshold=0.5,
                    sample_rate=self.sample_rate,
                ),
                onset_frames=2,
                hangover_frames=15,
                prefill_frames=15,
            )
        elif not enabled:
            if self._vad is not None:
                self._vad.reset()
            self._vad = None
        self._vad_enabled = enabled

    def _prepend_preroll_to_wav(self, filepath: str) -> None:
        """Select preroll frames and prepend them to the WAV file.

        Writes to a temporary file first, then replaces the original to avoid
        data loss on I/O failure.
        """
        with self._preroll_lock:
            if not self._preroll_metadata:
                return
            metadata_snapshot = list(self._preroll_metadata)
            buffer_snapshot = list(self._preroll_buffer)
            skipped_snapshot = self._preroll_skipped

        selection = select_preroll_frames(
            metadata_snapshot,
            self.sample_rate,
        )

        logger.info(
            "Preroll selection: reason=%s, frames=%d, samples=%d, seconds=%.3f",
            selection.reason,
            selection.selected_frame_count,
            selection.included_sample_count,
            selection.included_seconds,
        )

        if selection.selected_frame_count <= 0:
            return

        # Get the selected preroll frames
        # Only prepend frames that were skipped from WAV (before _preroll_skipped).
        # Frames from _preroll_skipped onward are already in the WAV file.
        preroll_frames = buffer_snapshot[selection.start_index : skipped_snapshot]
        if not preroll_frames:
            return

        preroll_audio = b"".join(preroll_frames)

        try:
            # Read existing WAV file
            with wave.open(filepath, "rb") as wf:
                params = wf.getparams()
                original_data = wf.readframes(params.nframes)

            # Write to temp file, then replace (safe against I/O failure)
            dir_name = os.path.dirname(filepath) or "."
            fd, tmp_path = tempfile.mkstemp(suffix=".wav", dir=dir_name)
            os.close(fd)
            try:
                with wave.open(tmp_path, "wb") as wf:
                    wf.setnchannels(params.nchannels)
                    wf.setsampwidth(params.sampwidth)
                    wf.setframerate(params.framerate)
                    wf.writeframes(preroll_audio)
                    wf.writeframes(original_data)
                os.replace(tmp_path, filepath)
            except Exception:
                # Clean up temp file on failure
                with contextlib.suppress(OSError):
                    os.unlink(tmp_path)
                raise

            logger.info(
                "Prepended %.3fs of preroll audio to %s",
                selection.included_seconds,
                filepath,
            )
        except Exception as e:
            logger.warning("Failed to prepend preroll audio to WAV file: %s", e)

    def stop_and_delete(self) -> None:
        """Stop recording and delete the audio file."""
        filepath = self.stop()
        if filepath:
            with contextlib.suppress(OSError):
                os.unlink(filepath)
