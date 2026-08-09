#!/usr/bin/env python3
"""Generate synthetic speech-like test audio (WAV, 16kHz, 16-bit mono).

Usage:
    python scripts/generate_test_audio.py [--duration 12] [--output test.wav]

The audio contains frequency-modulated tones that simulate speech formants,
with amplitude modulation and silence gaps. Good for benchmarking providers
without needing a microphone or real speech data.
"""

import argparse
import math
import struct
import wave

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
CHANNELS = 1


def generate_syllable(t: float, duration: float, f0: float, f1: float) -> float:
    """Generate a single syllable-like tone with formant sweep."""
    progress = t / duration if duration > 0 else 0
    freq = f0 + (f1 - f0) * progress
    amp = math.sin(math.pi * progress)  # smooth attack/release
    return amp * math.sin(2 * math.pi * freq * t)


def generate_test_audio(duration_sec: float) -> bytes:
    """Generate synthetic speech-like audio."""
    num_samples = int(SAMPLE_RATE * duration_sec)
    samples = [0.0] * num_samples

    # Syllable pattern: frequency pairs (f0, f1) and durations
    syllables = [
        (0.0, 0.15, 200, 350),  # uh
        (0.15, 0.35, 280, 450),  # hmm
        (0.35, 0.55, 300, 600),  # rising tone
        (0.55, 0.70, 400, 350),  # falling tone
        (0.70, 0.90, 250, 500),  # mid rise
        (0.90, 1.10, 350, 300),  # mid fall
        (1.10, 1.30, 450, 700),  # high rise
        (1.30, 1.50, 500, 400),  # high fall
        (1.50, 1.70, 300, 550),  # another rise
        (1.70, 1.85, 350, 280),  # fall
        (1.85, 2.00, 400, 500),  # short rise
    ]

    total_pattern = 2.0  # seconds per pattern repetition

    for i in range(num_samples):
        t = i / SAMPLE_RATE
        pattern_t = t % total_pattern
        sample = 0.0

        for start, end, f0, f1 in syllables:
            if start <= pattern_t < end:
                syl_t = pattern_t - start
                syl_d = end - start
                sample += generate_syllable(syl_t, syl_d, f0, f1)

        # Add some low-frequency hum and noise floor
        sample += 0.005 * math.sin(2 * math.pi * 120 * t)
        sample += 0.003 * (2 * (t * 1000 % 1) - 1)  # noise

        # Normalize and scale
        sample = max(-1.0, min(1.0, sample * 0.6))
        samples[i] = int(sample * 32767)

    return struct.pack(f"<{num_samples}h", *samples)


def write_wav(filepath: str, samples: bytes):
    """Write raw audio samples to a WAV file."""
    with wave.open(filepath, "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(SAMPLE_WIDTH)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples)
    actual = len(samples) / (SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS)
    print(f"Wrote {filepath}: {actual:.1f}s, {SAMPLE_RATE}Hz, 16-bit mono")


def main():
    """Generate synthetic test audio and write to a WAV file."""
    parser = argparse.ArgumentParser(description="Generate synthetic test audio")
    parser.add_argument("--duration", type=float, default=10.0, help="Duration in seconds")
    parser.add_argument("--output", default="test_audio.wav", help="Output WAV path")
    args = parser.parse_args()

    print(f"Generating {args.duration}s test audio...")
    samples = generate_test_audio(args.duration)
    write_wav(args.output, samples)


if __name__ == "__main__":
    main()
