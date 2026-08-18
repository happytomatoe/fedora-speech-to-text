"""Tests for audio recording and level metering."""

import os
import wave
from unittest.mock import patch

import numpy as np

from voice_to_text.audio import BLOCK_SIZE, SAMPLE_RATE, AudioRecorder


class TestAudioRecorder:
    def test_records_audio_to_wav(self):
        with patch("voice_to_text.audio.sd.InputStream"):
            recorder = AudioRecorder()
            recorder.start()

            cb = recorder._callback
            chunk = np.zeros((BLOCK_SIZE, 1), dtype=np.int16)
            cb(chunk, BLOCK_SIZE, None, None)

            chunk = np.ones((BLOCK_SIZE, 1), dtype=np.int16) * 1000
            cb(chunk, BLOCK_SIZE, None, None)

            filepath = recorder.stop()

        assert filepath is not None
        with wave.open(filepath, "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getsampwidth() == 2
            assert wav.getframerate() == SAMPLE_RATE
            assert wav.getnframes() == BLOCK_SIZE * 2

        os.unlink(filepath)

    def test_frame_count(self):
        with patch("voice_to_text.audio.sd.InputStream"):
            recorder = AudioRecorder()
            recorder.start()

            cb = recorder._callback
            for _ in range(5):
                cb(np.zeros((BLOCK_SIZE, 1), dtype=np.int16), BLOCK_SIZE, None, None)

            filepath = recorder.stop()
            assert recorder.frame_count == 5

        assert filepath is not None
        os.unlink(filepath)

    def test_smoothed_level(self):
        with patch("voice_to_text.audio.sd.InputStream"):
            recorder = AudioRecorder()
            recorder.start()

            cb = recorder._callback
            cb(np.zeros((BLOCK_SIZE, 1), dtype=np.int16), BLOCK_SIZE, None, None)

            first = recorder.smoothed_level
            cb(np.ones((BLOCK_SIZE, 1), dtype=np.int16) * 30000, BLOCK_SIZE, None, None)

            filepath = recorder.stop()
            assert first < recorder.smoothed_level

        assert filepath is not None
        os.unlink(filepath)

    def test_uses_configured_sample_rate(self):
        with patch("voice_to_text.audio.sd.InputStream") as mock_stream:
            recorder = AudioRecorder(sample_rate=48000, block_size=1024)
            recorder.start()

            _, kwargs = mock_stream.call_args
            assert kwargs["samplerate"] == 48000
            assert kwargs["blocksize"] == 1024

            filepath = recorder.stop()

        assert filepath is not None
        with wave.open(filepath, "rb") as wav:
            assert wav.getframerate() == 48000

        os.unlink(filepath)

    def test_stop_can_delete_temp_file(self):
        with patch("voice_to_text.audio.sd.InputStream"):
            recorder = AudioRecorder()
            recorder.start()
            filepath = recorder.filepath
            recorder.stop(delete=True)

        assert filepath is not None
        assert recorder.filepath is None
        assert not os.path.exists(filepath)

    def test_callback_ignores_writes_after_stop(self):
        with patch("voice_to_text.audio.sd.InputStream"):
            recorder = AudioRecorder()
            recorder.start()
            filepath = recorder.filepath
            cb = recorder._callback
            recorder.stop()
            cb(np.zeros((BLOCK_SIZE, 1), dtype=np.int16), BLOCK_SIZE, None, None)

        assert filepath is not None
        os.unlink(filepath)
