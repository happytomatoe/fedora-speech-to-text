"""Audio recording and level metering utilities."""

import logging
import math
import os
import re
import subprocess
import tempfile
import wave
from collections.abc import Callable

import numpy as np
import sounddevice as sd

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
BLOCK_SIZE = 2048


class AudioRecorder:
    """Records audio directly to a WAV file with level smoothing."""

    def __init__(
        self,
        device: int | None = None,
        smooth_factor: float = 0.7,
        sample_rate: int | None = None,
        block_size: int = BLOCK_SIZE,
    ):
        """Initialize the audio recorder."""
        self.device = device
        self.smooth_factor = smooth_factor
        self.sample_rate = sample_rate or SAMPLE_RATE
        self._explicit_sample_rate = sample_rate is not None
        self.block_size = block_size
        self.smoothed_level: float = 0.0
        self.frame_count: int = 0
        self.filepath: str | None = None
        self._stream: sd.InputStream | None = None
        self._wav: wave.Wave_write | None = None
        self.on_audio_data: Callable[[bytes], None] | None = None

    def start(self):
        """Start recording audio."""
        sample_rate = self.sample_rate
        if not self._explicit_sample_rate and self.device is not None:
            try:
                device_info = sd.query_devices(self.device)
                sample_rate = int(device_info["default_samplerate"])
            except Exception:
                pass
        self.sample_rate = sample_rate
        block_size = self.block_size

        fd, self.filepath = tempfile.mkstemp(suffix=".wav")
        fh = os.fdopen(fd, "wb")
        self._wav = wave.open(fh, "wb")  # noqa: SIM115 - file must stay open for recording duration
        self._wav.setnchannels(1)
        self._wav.setsampwidth(2)
        self._wav.setframerate(sample_rate)
        self.frame_count = 0

        self._stream = sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            blocksize=block_size,
            dtype="int16",
            callback=self._callback,
            device=self.device,
        )
        self._stream.start()

    def stop(self, *, delete: bool = False) -> str | None:
        """Stop recording and optionally delete the file."""
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if self._wav:
            self._wav.close()
            self._wav = None
        filepath = self.filepath
        if delete and filepath:
            try:
                os.unlink(filepath)
            except OSError:
                logger.debug("Failed to delete recording %s", filepath)
            self.filepath = None
        return filepath

    def _callback(self, indata: np.ndarray, frames: int, time_info, status):
        """Handle audio data from the sounddevice callback thread."""
        raw = indata.tobytes()
        if self._wav is not None:
            self._wav.writeframes(raw)
        self.frame_count += 1
        float_data = indata[:, 0].astype(np.float32) / 32768.0
        rms = math.sqrt(np.mean(float_data**2))
        self.smoothed_level = self.smooth_factor * self.smoothed_level + (1 - self.smooth_factor) * rms
        if self.on_audio_data is not None:
            try:
                self.on_audio_data(raw)
            except Exception:
                logger.exception("on_audio_data callback failed")


class SpeakerVolumeManager:
    """Save, decrease, and restore speaker output volume."""

    def __init__(self):
        """Initialize the speaker volume manager."""
        self._saved_volume: float | None = None

    def _get_volume(self) -> float | None:
        for cmd, parse_fn in [
            (["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"], self._parse_wpctl),
            (["pactl", "get-sink-volume", "@DEFAULT_SINK@"], self._parse_pactl),
        ]:
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=3, check=False)
                if result.returncode == 0:
                    vol = parse_fn(result.stdout)
                    if vol is not None:
                        return vol
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        return None

    def _set_volume(self, volume: float) -> bool:
        for cmd in [
            ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{volume:.2f}"],
            ["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{int(volume * 100)}%"],
        ]:
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=3, check=False)
                if result.returncode == 0:
                    return True
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        return False

    @staticmethod
    def _parse_wpctl(output: str) -> float | None:
        """Parse volume from wpctl output."""
        try:
            for token in output.split():
                part = token.strip()
                if part and part.replace(".", "", 1).lstrip("-").isdigit():
                    return float(part) if part != "0.00" else 0.0
        except (ValueError, IndexError):
            pass
        return None

    @staticmethod
    def _parse_pactl(output: str) -> float | None:
        """Parse volume from pactl output."""
        match = re.search(r"(\d+)%", output)
        if match:
            return int(match.group(1)) / 100.0
        return None

    def save(self):
        """Save the current speaker volume."""
        self._saved_volume = self._get_volume()
        if self._saved_volume is not None:
            logger.info("Saved speaker volume: %.0f%%", self._saved_volume * 100)

    def decrease(self, percent: int):
        """Decrease the speaker volume by a percentage."""
        percent = max(0, min(100, percent))
        if percent <= 0:
            return
        current = self._get_volume()
        if current is None:
            logger.warning("Could not read speaker volume, skipping decrease")
            return
        target = current * (100 - percent) / 100.0
        if self._set_volume(target):
            logger.info(
                "Decreased speaker volume: %.0f%% -> %.0f%%",
                current * 100,
                target * 100,
            )

    def restore(self):
        """Restore the saved speaker volume."""
        if self._saved_volume is None:
            return
        if self._set_volume(self._saved_volume):
            logger.info(
                "Restored speaker volume: %.0f%%",
                self._saved_volume * 100,
            )
        self._saved_volume = None

    def __enter__(self):
        """Enter the context manager."""
        return self

    def __exit__(self, *args):
        """Exit the context manager."""
        self.restore()

    @classmethod
    def with_decrease(cls, percent: int) -> "SpeakerVolumeManager":
        """Create a volume manager with decreased volume."""
        mgr = cls()
        try:
            pct = max(0, min(100, int(percent)))
        except (TypeError, ValueError):
            return mgr
        if pct > 0:
            mgr.save()
            mgr.decrease(pct)
        return mgr
