"""Voice Activity Detection (VAD) utilities.

Provides energy-based VAD with onset/hangover smoothing for clean
recording edges. No external model dependency — uses RMS energy threshold.

Design ported from Handy (src-tauri/src/audio_toolkit/vad/).
"""

from enum import Enum

import numpy as np


class VADFrame(Enum):
    """Result of pushing a frame through the VAD."""

    SPEECH = "speech"
    NOISE = "noise"


class VAD:
    """Raw energy-based voice activity detector.

    Classifies 16kHz mono float32 frames as speech or noise
    based on RMS energy exceeding a threshold.
    """

    def __init__(self, threshold: float = 0.01, sample_rate: int = 16000):
        """
        Args:
            threshold: RMS energy threshold. Speech above this level.
            sample_rate: Expected sample rate (for frame duration calc).
        """
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.frame_duration_ms = 30  # 30ms frames
        self.frame_samples = int(sample_rate * self.frame_duration_ms / 1000)

    def is_voice(self, frame: np.ndarray) -> bool:
        """Check if a frame contains voice activity.

        Args:
            frame: float32 samples (should be self.frame_samples long).

        Returns:
            True if RMS energy exceeds threshold.
        """
        if len(frame) == 0:
            return False
        rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
        return rms > self.threshold


class SmoothedVAD:
    """Smoothed VAD wrapper with onset, hangover, and prefill.

    Wraps a raw VAD (or acts as standalone) and adds temporal smoothing:
    - Onset: requires N consecutive speech frames before triggering
    - Hangover: keeps outputting speech for N frames after voice drops
    - Prefill: rolls back to include pre-speech audio
    """

    def __init__(
        self,
        inner: VAD | None = None,
        onset_frames: int = 2,
        hangover_frames: int = 15,
        prefill_frames: int = 15,
        threshold: float = 0.01,
        sample_rate: int = 16000,
    ):
        self.inner = inner or VAD(threshold=threshold, sample_rate=sample_rate)
        self.onset_frames = onset_frames
        self.hangover_frames = hangover_frames
        self.prefill_frames = prefill_frames

        self._frame_buffer: list[np.ndarray] = []
        self._hangover_counter = 0
        self._onset_counter = 0
        self._in_speech = False

    def push_frame(self, frame: np.ndarray) -> VADFrame:
        """Process one frame and return speech/noise decision.

        Args:
            frame: float32 audio samples (should match inner.frame_samples).

        Returns:
            VADFrame.SPEECH or VADFrame.NOISE.
        """
        # Buffer for prefill
        self._frame_buffer.append(frame.copy())
        if len(self._frame_buffer) > self.prefill_frames + 1:
            self._frame_buffer.pop(0)

        # Delegate to inner VAD
        is_voice = self.inner.is_voice(frame)

        if not self._in_speech and is_voice:
            # Potential start of speech
            self._onset_counter += 1
            if self._onset_counter >= self.onset_frames:
                self._in_speech = True
                self._hangover_counter = self.hangover_frames
                self._onset_counter = 0
                # Return prefill + current frame as speech
                return VADFrame.SPEECH
            return VADFrame.NOISE

        elif self._in_speech and is_voice:
            # Ongoing speech
            self._hangover_counter = self.hangover_frames
            return VADFrame.SPEECH

        elif self._in_speech and not is_voice:
            # End of speech — hangover tail
            if self._hangover_counter > 0:
                self._hangover_counter -= 1
                return VADFrame.SPEECH
            else:
                self._in_speech = False
                return VADFrame.NOISE

        else:
            # Silence — reset onset
            self._onset_counter = 0
            return VADFrame.NOISE

    def get_prefill_audio(self) -> list[np.ndarray]:
        """Get buffered prefill frames (for use when speech starts)."""
        return list(self._frame_buffer)

    @property
    def in_speech(self) -> bool:
        """Whether we're currently in a speech segment."""
        return self._in_speech

    def reset(self) -> None:
        """Clear all internal state for a new recording."""
        self._frame_buffer.clear()
        self._hangover_counter = 0
        self._onset_counter = 0
        self._in_speech = False
