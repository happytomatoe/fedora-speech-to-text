"""Preroll buffer selection — find optimal cut point in pre-recording audio.

Ported from RealtimeSTT (MIT license) and simplified for single-VAD metadata.
Scans backward from speech onset to find a clean silence boundary, preventing
first-word clipping in batch transcription.
"""

import math
from dataclasses import dataclass, field
from typing import Any

REASON_BELOW_MINIMUM = "below_minimum"
REASON_EMPTY_BUFFER = "empty_buffer"
REASON_FALLBACK_FULL_PREROLL = "fallback_full_preroll"
REASON_STABLE_SILENCE_FOUND = "stable_silence_found"
REASON_UNCERTAIN = "uncertain"

DEFAULT_MIN_SILENCE_MS = 200.0
DEFAULT_GUARD_MS = 160.0
DEFAULT_MAX_GAP_MS = 80.0
DEFAULT_MIN_INCLUDED_MS = 600.0
DEFAULT_NOISE_FLOOR_MULTIPLIER = 2.5
DEFAULT_ENERGY_MARGIN_RMS = 0.005


@dataclass(frozen=True)
class PrerollFrameMetadata:
    """Metadata for one frame in the pre-recording buffer."""

    sample_count: int
    is_speech: bool | None  # None = unknown (no VAD history)
    rms: float | None = None


@dataclass(frozen=True)
class PrerollSelection:
    """Describes a selected pre-recording buffer tail and diagnostics."""

    start_index: int
    selected_frame_count: int
    included_sample_count: int
    included_seconds: float
    reason: str
    diagnostics: dict[str, Any] = field(default_factory=dict)


def select_preroll_frames(  # noqa: PLR0913, PLR0917, PLR0911
    frame_metadata: list[PrerollFrameMetadata],
    sample_rate: int,
    min_silence_ms: float = DEFAULT_MIN_SILENCE_MS,
    guard_ms: float = DEFAULT_GUARD_MS,
    max_gap_ms: float = DEFAULT_MAX_GAP_MS,
    min_included_ms: float = DEFAULT_MIN_INCLUDED_MS,
    energy_silence_rms: float | None = None,
    noise_floor_multiplier: float = DEFAULT_NOISE_FLOOR_MULTIPLIER,
    energy_margin_rms: float = DEFAULT_ENERGY_MARGIN_RMS,
) -> PrerollSelection:
    """Select a conservative tail from pre-recording frame metadata.

    The selector uses VAD metadata captured while audio flowed forward through
    the recorder. It never runs a second VAD pass. Energy is only a supporting
    signal for frames already marked non-speech or unknown; it cannot turn a
    VAD speech frame into silence or create a speech onset by itself.

    Args:
        frame_metadata: Prebuffer frame metadata in chronological order.
        sample_rate: Audio sample rate in samples per second.
        min_silence_ms: Required contiguous silence before speech onset.
        guard_ms: Audio to keep before speech onset, in milliseconds.
        max_gap_ms: Short VAD false gaps to merge into one speech run.
        min_included_ms: Minimum selected pre-roll tail, in milliseconds.
        energy_silence_rms: Optional absolute RMS ceiling for silence.
        noise_floor_multiplier: Multiplier applied to the local noise floor.
        energy_margin_rms: RMS margin added to the adaptive noise threshold.

    Returns:
        A PrerollSelection describing selected frame indices, exact sample
        count, seconds, reason, and diagnostics.

    Raises:
        ValueError: If sample_rate is not positive.

    """
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")

    frames = list(frame_metadata or ())
    total_sample_count = _sum_samples(frames)
    if not frames or total_sample_count <= 0:
        return _empty_selection()

    max_gap_samples = _milliseconds_to_samples(max_gap_ms, sample_rate)
    min_silence_samples = _milliseconds_to_samples(min_silence_ms, sample_rate)
    guard_samples = _milliseconds_to_samples(guard_ms, sample_rate)
    min_included_samples = _milliseconds_to_samples(min_included_ms, sample_rate)

    base_diagnostics: dict[str, Any] = {
        "totalSampleCount": total_sample_count,
        "frameCount": len(frames),
        "speechSampleCount": _speech_sample_count(frames),
        "minSilenceSamples": min_silence_samples,
        "guardSamples": guard_samples,
        "minIncludedSamples": min_included_samples,
        "maxGapSamples": max_gap_samples,
    }

    if total_sample_count <= min_included_samples:
        return _full_selection(
            frames,
            sample_rate,
            REASON_BELOW_MINIMUM,
            {**base_diagnostics, "fallbackDetail": "buffer_not_above_minimum"},
        )

    onset_index = _find_merged_speech_onset_index(frames, max_gap_samples)
    base_diagnostics["speechOnsetIndex"] = onset_index

    if onset_index is None:
        return _full_selection(
            frames,
            sample_rate,
            REASON_UNCERTAIN,
            {**base_diagnostics, "fallbackDetail": "no_speech_onset"},
        )

    if onset_index <= 0:
        return _full_selection(
            frames,
            sample_rate,
            REASON_FALLBACK_FULL_PREROLL,
            {**base_diagnostics, "fallbackDetail": "onset_at_buffer_start"},
        )

    energy_threshold_rms, noise_floor_rms = _energy_threshold_rms(
        frames[:onset_index],
        energy_silence_rms=energy_silence_rms,
        noise_floor_multiplier=noise_floor_multiplier,
        energy_margin_rms=energy_margin_rms,
    )

    (
        silence_start_index,
        stable_silence_samples,
        effective_onset_index,
        pre_speech_tail_samples,
    ) = _stable_silence_before_onset(frames, onset_index, energy_threshold_rms)

    onset_sample = _sample_offset_for_index(frames, onset_index)
    effective_onset_sample = _sample_offset_for_index(frames, effective_onset_index)
    diagnostics = {
        **base_diagnostics,
        "stableSilenceStartIndex": silence_start_index,
        "stableSilenceSamples": stable_silence_samples,
        "stableSilenceSeconds": stable_silence_samples / float(sample_rate),
        "effectiveSpeechOnsetIndex": effective_onset_index,
        "effectiveSpeechOnsetSample": effective_onset_sample,
        "effectiveSpeechOnsetSeconds": effective_onset_sample / float(sample_rate),
        "preSpeechTailSamples": pre_speech_tail_samples,
        "preSpeechTailSeconds": pre_speech_tail_samples / float(sample_rate),
        "energyThresholdRms": energy_threshold_rms,
        "noiseFloorRms": noise_floor_rms,
        "speechOnsetSample": onset_sample,
    }

    if stable_silence_samples < min_silence_samples:
        return _full_selection(
            frames,
            sample_rate,
            REASON_UNCERTAIN,
            {**diagnostics, "fallbackDetail": "stable_silence_too_short"},
        )

    latest_by_guard = effective_onset_sample - guard_samples
    latest_by_minimum = total_sample_count - min_included_samples
    selection_start_sample = min(latest_by_guard, latest_by_minimum)

    if selection_start_sample <= 0:
        return _full_selection(
            frames,
            sample_rate,
            REASON_BELOW_MINIMUM,
            {**diagnostics, "fallbackDetail": "guard_or_minimum_consumes_buffer"},
        )

    start_index = _index_for_sample_offset(frames, selection_start_sample)
    included_sample_count = _sum_samples(frames[start_index:])
    return PrerollSelection(
        start_index=start_index,
        selected_frame_count=len(frames) - start_index,
        included_sample_count=included_sample_count,
        included_seconds=included_sample_count / float(sample_rate),
        reason=REASON_STABLE_SILENCE_FOUND,
        diagnostics={**diagnostics, "selectionStartSample": selection_start_sample},
    )


def _empty_selection() -> PrerollSelection:
    """Build an empty pre-roll selection result."""
    return PrerollSelection(
        start_index=0,
        selected_frame_count=0,
        included_sample_count=0,
        included_seconds=0.0,
        reason=REASON_EMPTY_BUFFER,
        diagnostics={"totalSampleCount": 0, "frameCount": 0},
    )


def _full_selection(
    frames: list[PrerollFrameMetadata],
    sample_rate: int,
    reason: str,
    diagnostics: dict[str, Any],
) -> PrerollSelection:
    """Build a pre-roll selection that keeps all frames."""
    total_sample_count = _sum_samples(frames)
    return PrerollSelection(
        start_index=0,
        selected_frame_count=len(frames),
        included_sample_count=total_sample_count,
        included_seconds=total_sample_count / float(sample_rate),
        reason=reason,
        diagnostics=diagnostics,
    )


def _find_merged_speech_onset_index(
    frames: list[PrerollFrameMetadata],
    max_gap_samples: int,
) -> int | None:
    """Find the first merged speech onset frame.

    Merges short VAD false gaps (silence frames < max_gap_samples) into
    one continuous speech run.
    """
    current_start_index: int | None = None
    current_gap_samples = 0
    latest_run_start_index: int | None = None

    for index, frame in enumerate(frames):
        if _is_speech_frame(frame):
            if current_start_index is None or current_gap_samples > max_gap_samples:
                current_start_index = index
            current_gap_samples = 0
            latest_run_start_index = current_start_index
        elif current_start_index is not None:
            current_gap_samples += _frame_sample_count(frame)

    return latest_run_start_index


def _stable_silence_before_onset(
    frames: list[PrerollFrameMetadata],
    onset_index: int,
    energy_threshold_rms: float | None,
) -> tuple[int, int, int, int]:
    """Check for stable silence before the speech onset.

    Returns:
        (silence_start_index, stable_silence_samples,
         effective_onset_index, pre_speech_tail_samples)

    """
    pre_speech_tail_samples = 0
    effective_onset_index = onset_index
    index = onset_index - 1

    # Keep quiet consonant lead-ins that still carry useful speech energy.
    # Treat those frames as a pre-speech tail to keep, then search for
    # stable silence before that tail.
    while index >= 0 and not _is_stable_silence_frame(frames[index], energy_threshold_rms):
        pre_speech_tail_samples += _frame_sample_count(frames[index])
        effective_onset_index = index
        index -= 1

    stable_silence_samples = 0
    silence_start_index = index + 1

    while index >= 0:
        frame = frames[index]
        if not _is_stable_silence_frame(frame, energy_threshold_rms):
            break
        stable_silence_samples += _frame_sample_count(frame)
        silence_start_index = index
        index -= 1

    return (
        silence_start_index,
        stable_silence_samples,
        effective_onset_index,
        pre_speech_tail_samples,
    )


def _is_stable_silence_frame(frame: PrerollFrameMetadata, energy_threshold_rms: float | None) -> bool:
    """Check whether a frame is stable silence."""
    is_speech = frame.is_speech
    if is_speech is True:
        return False

    rms = frame.rms
    has_rms = rms is not None

    if has_rms and energy_threshold_rms is not None:
        try:
            is_low_energy = float(rms) <= energy_threshold_rms
        except (TypeError, ValueError):
            is_low_energy = False
    else:
        is_low_energy = is_speech is False

    if is_speech is False:
        return is_low_energy
    return has_rms and is_low_energy


def _is_speech_frame(frame: PrerollFrameMetadata) -> bool:
    """Check whether a frame contains speech."""
    return frame.is_speech is True


def _energy_threshold_rms(
    frames: list[PrerollFrameMetadata],
    energy_silence_rms: float | None,
    noise_floor_multiplier: float,
    energy_margin_rms: float,
) -> tuple[float | None, float | None]:
    """Compute the RMS threshold used for silence checks."""
    rms_values: list[float] = []
    for frame in frames:
        if frame.rms is None:
            continue
        try:
            rms = float(frame.rms)
        except (TypeError, ValueError):
            continue
        if rms >= 0:
            rms_values.append(rms)

    absolute_threshold = None if energy_silence_rms is None else max(0.0, float(energy_silence_rms))

    if not rms_values:
        return absolute_threshold, None

    sorted_values = sorted(rms_values)
    floor_count = max(1, math.ceil(len(sorted_values) * 0.2))
    noise_floor = sum(sorted_values[:floor_count]) / float(floor_count)
    adaptive_threshold = noise_floor * max(0.0, float(noise_floor_multiplier)) + max(0.0, float(energy_margin_rms))

    if absolute_threshold is None:
        return adaptive_threshold, noise_floor
    return min(absolute_threshold, adaptive_threshold), noise_floor


def _sample_offset_for_index(frames: list[PrerollFrameMetadata], index: int) -> int:
    """Return the sample offset for a frame index."""
    return _sum_samples(frames[:index])


def _index_for_sample_offset(frames: list[PrerollFrameMetadata], sample_offset: int) -> int:
    """Return the frame index for a sample offset."""
    running_sample_count = 0
    for index, frame in enumerate(frames):
        running_sample_count += _frame_sample_count(frame)
        if running_sample_count > sample_offset:
            return index
    return len(frames)


def _sum_samples(frames: list[PrerollFrameMetadata]) -> int:
    """Return the total sample count for a frame sequence."""
    return sum(_frame_sample_count(frame) for frame in frames)


def _speech_sample_count(frames: list[PrerollFrameMetadata]) -> int:
    """Return the sample count covered by speech metadata."""
    sample_count = 0
    for frame in frames:
        if frame.is_speech is True:
            sample_count += _frame_sample_count(frame)
    return sample_count


def _frame_sample_count(frame: PrerollFrameMetadata) -> int:
    """Return the sample count for one frame."""
    return max(0, int(frame.sample_count))


def _milliseconds_to_samples(milliseconds: float, sample_rate: int) -> int:
    """Convert milliseconds to sample count."""
    return max(0, math.ceil(float(milliseconds) * float(sample_rate) / 1000.0))
