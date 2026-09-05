"""Async audio recorder for the D-Bus recording engine.

``AsyncAudioRecorder`` wraps a ``sounddevice`` ``InputStream`` whose blocking
callback runs on a sounddevice-internal thread. The callback writes audio
chunks into a thread-safe ``asyncio.Queue``; the async consumer drains the
queue and appends to a WAV file.

Split out of ``engine.py``: this module owns capture, not orchestration.
"""

import asyncio
import contextlib
import logging
import os
import wave
from typing import Any

import numpy as np
import sounddevice as sd

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
BLOCK_SIZE = 2048


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

    def _audio_callback(self, indata: np.ndarray, _frames: int, _time_info, status):
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

        if self._wav_file is not None:
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

        return filepath

    def stop_and_delete(self) -> None:
        """Stop recording and delete the audio file."""
        filepath = self.stop()
        if filepath:
            with contextlib.suppress(OSError):
                os.unlink(filepath)
