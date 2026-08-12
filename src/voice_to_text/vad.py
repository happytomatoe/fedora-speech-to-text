"""Voice Activity Detection (VAD) utilities.

Provides Silero neural VAD with onset/hangover smoothing for clean
recording edges. Uses Silero's ~2MB ONNX model that understands speech
patterns, not just volume. Falls back to energy-based VAD if Silero
is unavailable.
"""

import os
import subprocess
from enum import Enum

import numpy as np
from onnxruntime import InferenceSession, SessionOptions  # type: ignore[import-untyped]

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
STATE_SHAPE = (2, 1, 128)


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
        """Initialize the VAD.

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


class SileroVAD:
    """Neural voice activity detector using Silero's ONNX model.

    Classifies 16kHz mono float32 frames as speech or noise
    using a ~2MB neural network that understands speech patterns.
    """

    def __init__(
        self,
        threshold: float = 0.5,
        sample_rate: int = 16000,
        onnx_threads: int = 2,
    ) -> None:
        """Initialize Silero VAD.

        Args:
            threshold: Speech probability threshold (0-1). Higher = less sensitive.
            sample_rate: Audio sample rate (must be 16000).
            onnx_threads: ONNX Runtime intra-op threads.

        """
        if sample_rate != SAMPLE_RATE:
            raise ValueError("SileroVAD requires 16kHz audio")

        self.threshold = threshold
        self.sample_rate = sample_rate
        self.frame_samples = FRAME_SAMPLES  # Silero requires exactly 512 samples
        self.frame_duration_ms = 32  # 32ms at 16kHz

        # Download model if needed
        target_dir = os.path.expanduser("~/.cache/voice-to-text/")
        os.makedirs(target_dir, exist_ok=True)
        model_path = os.path.join(target_dir, "silero_vad.onnx")

        if not os.path.exists(model_path):
            model_url = "https://github.com/snakers4/silero-vad/raw/v5.0/files/silero_vad.onnx"
            try:
                subprocess.run(["wget", "-q", "-O", model_path, model_url], check=True)
            except (subprocess.CalledProcessError, FileNotFoundError) as e:
                raise RuntimeError(f"Failed to download Silero model: {e}") from e

        # Load model
        opts = SessionOptions()
        opts.intra_op_num_threads = onnx_threads
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3

        self._model = InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
        self._context = np.zeros(CONTEXT_SAMPLES, dtype=np.float32)
        self._state = np.zeros(STATE_SHAPE, dtype=np.float32)

    def _preprocess(self, audio: np.ndarray) -> np.ndarray:
        """Add context samples and ensure correct shape."""
        audio_with_context = np.concatenate([self._context, audio]).astype(np.float32)
        self._context = audio[-CONTEXT_SAMPLES:].copy()
        return audio_with_context.reshape(1, -1)

    def is_voice(self, frame: np.ndarray) -> bool:
        """Check if a frame contains voice activity.

        Args:
            frame: float32 samples (must be 512 samples for optimal performance).

        Returns:
            True if Silero model predicts speech probability > threshold.

        """
        if len(frame) == 0:
            return False

        # Resample to FRAME_SAMPLES if needed (e.g., 2048 samples from engine)
        if len(frame) != FRAME_SAMPLES:
            if len(frame) > FRAME_SAMPLES:
                frame = frame[:FRAME_SAMPLES]
            else:
                frame = np.pad(frame, (0, FRAME_SAMPLES - len(frame)))

        audio_input = self._preprocess(frame)

        outputs = self._model.run(
            None,
            {
                "input": audio_input,
                "state": self._state,
                "sr": np.array(SAMPLE_RATE, dtype=np.int64),
            },
        )
        probability = float(outputs[0].reshape(-1)[0])
        self._state = outputs[1]  # Update state for next call

        return probability > self.threshold


class SmoothedVAD:
    """Smoothed VAD wrapper with onset, hangover, and prefill.

    Wraps a raw VAD (or acts as standalone) and adds temporal smoothing:
    - Onset: requires N consecutive speech frames before triggering
    - Hangover: keeps outputting speech for N frames after voice drops
    - Prefill: rolls back to include pre-speech audio
    """

    def __init__(  # noqa: PLR0913, PLR0917
        self,
        inner: VAD | SileroVAD | None = None,
        onset_frames: int = 2,
        hangover_frames: int = 15,
        prefill_frames: int = 15,
        threshold: float = 0.01,
        sample_rate: int = 16000,
    ) -> None:
        """Initialize the smoothed VAD."""
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
