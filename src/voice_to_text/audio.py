"""Audio recording and level metering utilities."""

import logging
import re
import subprocess

import numpy as np

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
BLOCK_SIZE = 2048


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


def remove_silence(
    audio: np.ndarray,
    speech_timestamps: list[tuple[int, int]],
    sample_rate: int = 16000,
    padding_ms: int = 200,
) -> np.ndarray:
    """Remove silence from audio using speech timestamps.

    Args:
        audio: float32 audio samples
        speech_timestamps: List of (start_sample, end_sample) from VAD
        sample_rate: Audio sample rate
        padding_ms: Padding around speech segments (prevents clipping)

    Returns:
        Audio with silence removed

    """
    if not speech_timestamps:
        return np.array([], dtype=np.float32)

    padding_samples = int(padding_ms * sample_rate / 1000)
    ranges: list[tuple[int, int]] = []

    for start, end in speech_timestamps:
        padded_start = max(0, start - padding_samples)
        padded_end = min(len(audio), end + padding_samples)
        if ranges and padded_start <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], padded_end))
        else:
            ranges.append((padded_start, padded_end))

    return np.concatenate([audio[start:end] for start, end in ranges])


def merge_segments(
    timestamps: list[tuple[int, int]],
    max_gap_ms: int = 1500,
    sample_rate: int = 16000,
) -> list[tuple[int, int]]:
    """Merge speech segments with short gaps.

    Args:
        timestamps: List of (start_sample, end_sample)
        max_gap_ms: Maximum gap to merge (shorter pauses preserved)
        sample_rate: Audio sample rate

    Returns:
        Merged list of (start_sample, end_sample)

    """
    if not timestamps:
        return []

    max_gap_samples = int(max_gap_ms * sample_rate / 1000)
    merged: list[tuple[int, int]] = []

    for start, end in sorted(timestamps):
        if merged and (start - merged[-1][1]) < max_gap_samples:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    return merged


def get_audio_duration_ms(audio: np.ndarray, sample_rate: int = 16000) -> float:
    """Get audio duration in milliseconds."""
    return len(audio) / sample_rate * 1000
