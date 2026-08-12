"""Tests for preroll buffer selection algorithm."""

from voice_to_text.preroll import (
    REASON_BELOW_MINIMUM,
    REASON_EMPTY_BUFFER,
    REASON_FALLBACK_FULL_PREROLL,
    REASON_STABLE_SILENCE_FOUND,
    REASON_UNCERTAIN,
    PrerollFrameMetadata,
    select_preroll_frames,
)

SAMPLE_RATE = 16000


def frame(is_speech: bool | None, rms: float | None, frame_ms: int = 30) -> PrerollFrameMetadata:
    """Create a test frame with given speech state and RMS."""
    return PrerollFrameMetadata(
        sample_count=int(SAMPLE_RATE * frame_ms / 1000),
        is_speech=is_speech,
        rms=rms,
    )


def frames(count: int, is_speech: bool | None, rms: float | None, frame_ms: int = 30) -> list[PrerollFrameMetadata]:
    """Create multiple test frames."""
    return [frame(is_speech, rms, frame_ms=frame_ms) for _ in range(count)]


def sample_count(metadata: list[PrerollFrameMetadata]) -> int:
    """Get total sample count from metadata."""
    return sum(item.sample_count for item in metadata)


class TestPrerollSelection:
    def test_clear_long_silence_before_speech_trims_to_conservative_minimum(self):
        """Long silence before speech should be trimmed, keeping ~0.6s minimum."""
        metadata = frames(30, False, 5.0) + frames(8, True, 300.0)

        selection = select_preroll_frames(metadata, SAMPLE_RATE)

        assert selection.reason == REASON_STABLE_SILENCE_FOUND
        assert selection.start_index > 0
        assert selection.included_seconds >= 0.60
        assert selection.included_sample_count < sample_count(metadata)

    def test_no_clear_silence_keeps_full_preroll(self):
        """Without clear silence boundary, keep full preroll."""
        metadata = frames(5, False, 5.0) + frames(30, True, 300.0)

        selection = select_preroll_frames(metadata, SAMPLE_RATE)

        assert selection.reason == REASON_UNCERTAIN
        assert selection.start_index == 0
        assert selection.included_sample_count == sample_count(metadata)

    def test_short_vad_false_gap_inside_speech_is_not_boundary(self):
        """Short VAD false gaps should be merged into one speech run."""
        metadata = frames(20, True, 280.0) + frames(2, False, 5.0) + frames(20, True, 300.0)

        selection = select_preroll_frames(
            metadata,
            SAMPLE_RATE,
            max_gap_ms=80.0,
        )

        assert selection.reason == REASON_FALLBACK_FULL_PREROLL
        assert selection.diagnostics["fallbackDetail"] == "onset_at_buffer_start"

    def test_energy_refinement_only_helps_clear_silence(self):
        """Energy refinement should only trim clear silence, not uncertain energy."""
        clear_low_energy = frames(12, None, 5.0) + frames(10, True, 300.0)
        uncertain_energy = frames(12, None, 120.0) + frames(10, True, 180.0)

        selected = select_preroll_frames(
            clear_low_energy,
            SAMPLE_RATE,
            energy_silence_rms=50.0,
            min_included_ms=300.0,
        )
        fallback = select_preroll_frames(
            uncertain_energy,
            SAMPLE_RATE,
            energy_silence_rms=50.0,
            min_included_ms=300.0,
        )

        assert selected.reason == REASON_STABLE_SILENCE_FOUND
        assert selected.included_sample_count < sample_count(clear_low_energy)
        assert fallback.reason == REASON_UNCERTAIN
        assert fallback.included_sample_count == sample_count(uncertain_energy)

    def test_high_energy_pre_speech_tail_is_kept_after_stable_silence(self):
        """Quiet consonant lead-ins before speech should be kept."""
        metadata = frames(100, False, 5.0) + frames(10, None, 160.0) + frames(8, True, 300.0)

        selection = select_preroll_frames(
            metadata,
            SAMPLE_RATE,
            min_silence_ms=80.0,
            guard_ms=80.0,
            min_included_ms=300.0,
        )

        assert selection.reason == REASON_STABLE_SILENCE_FOUND
        assert selection.diagnostics["preSpeechTailSeconds"] >= 0.19
        assert selection.included_sample_count < sample_count(metadata)
        assert selection.start_index <= 100

    def test_empty_and_short_buffers_are_safe(self):
        """Empty and very short buffers should return safe fallbacks."""
        empty = select_preroll_frames([], SAMPLE_RATE)
        short = select_preroll_frames(
            frames(8, False, 5.0) + frames(2, True, 300.0),
            SAMPLE_RATE,
        )

        assert empty.reason == REASON_EMPTY_BUFFER
        assert empty.included_sample_count == 0
        assert short.reason == REASON_BELOW_MINIMUM
        assert short.selected_frame_count == 10

    def test_included_seconds_matches_selected_samples_exactly(self):
        """Included seconds must exactly match selected sample count."""
        metadata = frames(60, False, 5.0, frame_ms=10) + frames(
            20,
            True,
            300.0,
            frame_ms=10,
        )

        selection = select_preroll_frames(metadata, SAMPLE_RATE)

        assert selection.reason == REASON_STABLE_SILENCE_FOUND
        assert selection.included_sample_count / float(SAMPLE_RATE) == selection.included_seconds
        assert sample_count(metadata[selection.start_index :]) == selection.included_sample_count

    def test_parameters_can_be_swept_without_server_state(self):
        """Different parameter combinations should all produce valid results."""
        metadata = frames(35, False, 5.0) + frames(10, True, 300.0)
        cases = [
            {"min_silence_ms": 150.0, "guard_ms": 120.0, "max_gap_ms": 40.0, "min_included_ms": 550.0},
            {"min_silence_ms": 200.0, "guard_ms": 160.0, "max_gap_ms": 80.0, "min_included_ms": 600.0},
            {"min_silence_ms": 250.0, "guard_ms": 180.0, "max_gap_ms": 100.0, "min_included_ms": 650.0},
        ]

        for case in cases:
            selection = select_preroll_frames(
                metadata,
                SAMPLE_RATE,
                **case,
            )

            assert selection.reason == REASON_STABLE_SILENCE_FOUND
            assert selection.included_seconds >= case["min_included_ms"] / 1000.0

    def test_default_regression_does_not_fall_to_tiny_preroll(self):
        """Default parameters should not produce unexpectedly small preroll."""
        metadata = frames(30, False, 5.0) + frames(8, True, 300.0)

        selection = select_preroll_frames(metadata, SAMPLE_RATE)

        assert selection.included_seconds >= 0.60
        assert selection.included_seconds > 0.08

    def test_negative_sample_rate_raises(self):
        """Negative sample rate should raise ValueError."""
        import pytest

        with pytest.raises(ValueError, match="sample_rate must be positive"):
            select_preroll_frames([], -1)

    def test_speech_at_buffer_start(self):
        """Speech starting at buffer start should fallback to full preroll."""
        # Need enough frames to exceed min_included_ms (600ms = 9600 samples)
        metadata = frames(30, True, 300.0) + frames(5, False, 5.0)

        selection = select_preroll_frames(metadata, SAMPLE_RATE)

        assert selection.reason == REASON_FALLBACK_FULL_PREROLL
        assert selection.diagnostics["fallbackDetail"] == "onset_at_buffer_start"

    def test_all_silence_no_speech(self):
        """All silence with no speech should return uncertain."""
        # Need enough frames to exceed min_included_ms (600ms = 9600 samples)
        metadata = frames(50, False, 5.0)

        selection = select_preroll_frames(metadata, SAMPLE_RATE)

        assert selection.reason == REASON_UNCERTAIN
        assert selection.diagnostics["fallbackDetail"] == "no_speech_onset"
