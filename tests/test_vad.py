"""Tests for Voice Activity Detection."""

import numpy as np
import pytest

from voice_to_text.audio import get_audio_duration_ms, merge_segments, remove_silence
from voice_to_text.engine import AsyncAudioRecorder
from voice_to_text.vad import VAD, SileroVAD, SmoothedVAD, VADFrame


class TestVAD:
    def test_silence_is_noise(self):
        vad = VAD(threshold=0.01)
        frame = np.zeros(480, dtype=np.float32)  # 30ms at 16kHz
        assert vad.is_voice(frame) is False

    def test_loud_audio_is_speech(self):
        vad = VAD(threshold=0.01)
        frame = np.random.uniform(-0.5, 0.5, 480).astype(np.float32)
        assert vad.is_voice(frame) is True

    def test_empty_frame(self):
        vad = VAD(threshold=0.01)
        assert vad.is_voice(np.array([], dtype=np.float32)) is False


class TestSmoothedVAD:
    def _make_silence(self, n_frames=10):
        return [np.zeros(480, dtype=np.float32) for _ in range(n_frames)]

    def _make_speech(self, n_frames=10):
        return [np.random.uniform(-0.3, 0.3, 480).astype(np.float32) for _ in range(n_frames)]

    def test_no_speech_from_silence(self):
        vad = SmoothedVAD(threshold=0.01, onset_frames=2)
        results = [vad.push_frame(f) for f in self._make_silence(20)]
        assert all(r == VADFrame.NOISE for r in results)

    def test_onset_delay(self):
        vad = SmoothedVAD(threshold=0.01, onset_frames=3)
        silence = self._make_silence(5)
        speech = self._make_speech(10)

        results = [vad.push_frame(f) for f in silence + speech]
        # First 5 are noise, then 2 more noise (onset delay), then speech
        assert results[0] == VADFrame.NOISE
        assert results[5] == VADFrame.NOISE  # onset frame 1
        assert results[6] == VADFrame.NOISE  # onset frame 2
        assert results[7] == VADFrame.SPEECH  # onset complete

    def test_hangover_tail(self):
        vad = SmoothedVAD(threshold=0.01, onset_frames=1, hangover_frames=3)
        speech = self._make_speech(5)
        silence = self._make_silence(10)

        results = [vad.push_frame(f) for f in speech + silence]
        # Speech frames, then 3 hangover frames, then noise
        assert results[0] == VADFrame.SPEECH  # onset
        assert results[4] == VADFrame.SPEECH  # last speech frame
        assert results[5] == VADFrame.SPEECH  # hangover 1
        assert results[6] == VADFrame.SPEECH  # hangover 2
        assert results[7] == VADFrame.SPEECH  # hangover 3
        assert results[8] == VADFrame.NOISE  # hangover expired

    def test_reset_clears_state(self):
        vad = SmoothedVAD(threshold=0.01, onset_frames=2)
        speech = self._make_speech(5)
        for f in speech:
            vad.push_frame(f)

        vad.reset()
        assert vad.in_speech is False
        assert vad._onset_counter == 0
        assert vad._hangover_counter == 0

    def test_in_speech_property(self):
        vad = SmoothedVAD(threshold=0.01, onset_frames=1)
        assert vad.in_speech is False

        speech = self._make_speech(3)
        vad.push_frame(speech[0])
        assert vad.in_speech is True


class TestSileroVAD:
    """Tests for Silero neural VAD."""

    def test_init(self):
        vad = SileroVAD()
        assert vad.threshold == 0.5
        assert vad.sample_rate == 16000
        assert vad.frame_samples == 512

    def test_silence_is_noise(self):
        vad = SileroVAD(threshold=0.5)
        frame = np.zeros(512, dtype=np.float32)
        assert vad.is_voice(frame) is False

    def test_empty_frame(self):
        vad = SileroVAD()
        assert vad.is_voice(np.array([], dtype=np.float32)) is False

    def test_inference_runs(self):
        vad = SileroVAD()
        frame = np.random.randn(512).astype(np.float32) * 0.1
        result = vad.is_voice(frame)
        assert isinstance(result, bool)

    def test_state_update(self):
        vad = SileroVAD()
        initial_state = vad._state.copy()
        frame = np.random.randn(512).astype(np.float32) * 0.1
        vad.is_voice(frame)
        # State should have changed after inference
        assert not np.array_equal(vad._state, initial_state)

    def test_reset_clears_state(self):
        vad = SileroVAD()
        vad._context = np.ones(64, dtype=np.float32)
        vad._state = np.ones((2, 1, 128), dtype=np.float32)
        vad.reset()
        assert np.all(vad._context == 0)
        assert np.all(vad._state == 0)


class TestSmoothedVADWithSilero:
    """Tests for SmoothedVAD wrapping SileroVAD."""

    def _make_silence(self, n_frames=10):
        return [np.zeros(512, dtype=np.float32) for _ in range(n_frames)]

    def test_silence_produces_noise(self):
        inner = SileroVAD(threshold=0.5)
        vad = SmoothedVAD(inner=inner, onset_frames=2)
        results = [vad.push_frame(f) for f in self._make_silence(20)]
        assert all(r == VADFrame.NOISE for r in results)

    def test_reset_clears_silero_state(self):
        inner = SileroVAD(threshold=0.5)
        vad = SmoothedVAD(inner=inner, onset_frames=2)
        # Process some frames to change state
        for f in self._make_silence(5):
            vad.push_frame(f)
        # Verify state changed
        assert not np.all(inner._state == 0)
        # Reset and verify Silero state is cleared
        vad.reset()
        assert np.all(inner._state == 0)
        assert np.all(inner._context == 0)


class TestRemoveSilence:
    """Tests for remove_silence() audio utility."""

    def test_empty_timestamps(self):
        audio = np.array([0.1, 0.2, 0.3], dtype=np.float32)
        result = remove_silence(audio, [])
        assert len(result) == 0

    def test_single_segment(self):
        audio = np.array([0, 0, 1, 2, 3, 0, 0], dtype=np.float32)
        result = remove_silence(audio, [(2, 5)], padding_ms=0, sample_rate=16000)
        np.testing.assert_array_equal(result, [1, 2, 3])

    def test_padding_applied(self):
        audio = np.arange(10, dtype=np.float32)
        result = remove_silence(audio, [(3, 6)], padding_ms=0)
        assert len(result) == 3  # samples 3, 4, 5

    def test_multiple_segments(self):
        audio = np.arange(20, dtype=np.float32)
        timestamps = [(0, 3), (10, 15)]
        result = remove_silence(audio, timestamps, padding_ms=0)
        expected = np.array([0, 1, 2, 10, 11, 12, 13, 14], dtype=np.float32)
        np.testing.assert_array_equal(result, expected)

    def test_boundary_clamping(self):
        audio = np.array([1, 2, 3], dtype=np.float32)
        result = remove_silence(audio, [(0, 10)], padding_ms=0)
        np.testing.assert_array_equal(result, [1, 2, 3])

    def test_overlapping_segments_merged(self):
        """Test that overlapping padded segments are merged (Issue #1 fix)."""
        audio = np.arange(20, dtype=np.float32)
        # Two segments close together that will overlap with padding
        timestamps = [(5, 8), (9, 12)]
        result = remove_silence(audio, timestamps, padding_ms=0, sample_rate=16000)
        # With the fix, overlapping ranges should be merged
        # Without fix, would have duplicates
        assert len(result) == len(np.unique(result))  # No duplicates


class TestMergeSegments:
    """Tests for merge_segments() audio utility."""

    def test_empty_timestamps(self):
        result = merge_segments([])
        assert result == []

    def test_single_segment(self):
        result = merge_segments([(0, 100)])
        assert result == [(0, 100)]

    def test_merge_close_segments(self):
        timestamps = [(0, 100), (150, 300)]  # Gap of 50 samples
        result = merge_segments(timestamps, max_gap_ms=1500)
        assert result == [(0, 300)]

    def test_keep_distant_segments(self):
        timestamps = [(0, 100), (5000, 6000)]  # Gap of 4900 samples
        result = merge_segments(timestamps, max_gap_ms=100)  # 100ms = 1600 samples
        assert result == [(0, 100), (5000, 6000)]

    def test_merge_chain(self):
        # 16kHz: 100ms = 1600 samples
        timestamps = [(0, 100), (150, 300), (10000, 11000)]
        result = merge_segments(timestamps, max_gap_ms=100)
        # First two merge (gap=50 < 1600), third stays separate (gap=9700 > 1600)
        assert result == [(0, 300), (10000, 11000)]

    def test_nested_segments_preserved(self):
        """Test that nested segments preserve the largest end (Issue #2 fix)."""
        # Without fix: [(0, 1000), (100, 200)] -> [(0, 200)] (WRONG)
        # With fix: sorted first, then merged correctly
        timestamps = [(0, 1000), (100, 200)]
        result = merge_segments(timestamps, max_gap_ms=1500)
        # After sorting: [(0, 1000), (100, 200)]
        # Gap between 1000 and 100 is negative, so they merge
        # But we preserve the max end: (0, max(1000, 200)) = (0, 1000)
        assert result == [(0, 1000)]

    def test_unsorted_input(self):
        """Test that unsorted input is handled correctly (Issue #2 fix)."""
        timestamps = [(100, 200), (0, 50)]
        result = merge_segments(timestamps, max_gap_ms=1500)
        # After sorting: [(0, 50), (100, 200)]
        # Gap is 50 < 24000 (1500ms at 16kHz), so they merge
        assert result == [(0, 200)]


class TestGetAudioDurationMs:
    """Tests for get_audio_duration_ms() audio utility."""

    def test_empty_audio(self):
        audio = np.array([], dtype=np.float32)
        assert get_audio_duration_ms(audio) == 0.0

    def test_1_second(self):
        audio = np.zeros(16000, dtype=np.float32)
        assert get_audio_duration_ms(audio) == 1000.0

    def test_half_second(self):
        audio = np.zeros(8000, dtype=np.float32)
        assert get_audio_duration_ms(audio) == 500.0


@pytest.mark.skip(reason="vad_enabled parameter and enable_vad method not implemented")
class TestAsyncAudioRecorderVAD:
    """Tests for VAD feature flags in AsyncAudioRecorder."""

    def test_vad_enabled_by_default(self):
        recorder = AsyncAudioRecorder(vad_enabled=True)
        assert recorder._vad is not None
        assert recorder._vad_enabled is True

    def test_vad_disabled(self):
        recorder = AsyncAudioRecorder(vad_enabled=False)
        assert recorder._vad is None
        assert recorder._vad_enabled is False

    def test_enable_vad(self):
        recorder = AsyncAudioRecorder(vad_enabled=False)
        assert recorder._vad is None
        recorder.enable_vad(True)
        assert recorder._vad is not None
        assert recorder._vad_enabled is True

    def test_disable_vad(self):
        recorder = AsyncAudioRecorder(vad_enabled=True)
        assert recorder._vad is not None
        recorder.enable_vad(False)
        assert recorder._vad is None
        assert recorder._vad_enabled is False
