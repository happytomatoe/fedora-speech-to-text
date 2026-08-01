"""Tests for Voice Activity Detection."""

import numpy as np

from voice_to_text.vad import VAD, SmoothedVAD, VADFrame


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
