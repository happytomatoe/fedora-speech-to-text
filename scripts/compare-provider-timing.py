#!/usr/bin/env python3
"""Compare timing between Parakeet and Moonshine providers."""

import asyncio
import sys
import time
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from voice_to_text.providers import get_batch_provider


async def test_provider_timing(provider_name: str, audio_file: str, runs: int):
    """Test timing for a specific provider."""
    print(f"\n=== Testing {provider_name} ===")

    # Create provider
    if provider_name == "parakeet":
        config = {"http_endpoint": "http://localhost:5092"}
    elif provider_name == "moonshine":
        config = {"model": "medium", "language": "en"}
    else:
        print(f"Unknown provider: {provider_name}")
        return []

    provider = get_batch_provider(provider_name, config)

    timings = []
    for i in range(runs):
        print(f"  Run {i + 1}/{runs}...", end=" ", flush=True)

        start = time.perf_counter()
        try:
            result = await provider.transcribe_file(audio_file, language="en")
            end = time.perf_counter()
            elapsed_ms = (end - start) * 1000
            timings.append(elapsed_ms)
            print(f"{elapsed_ms:.0f}ms - '{result[:50]}...'")
        except Exception as e:
            end = time.perf_counter()
            elapsed_ms = (end - start) * 1000
            print(f"{elapsed_ms:.0f}ms - ERROR: {e}")
            timings.append(elapsed_ms)

    await provider.close()
    return timings


async def main():
    """Run the main comparison."""
    audio_file = "e2e/fixtures/test-01-weather.wav"

    if not Path(audio_file).exists():
        print(f"❌ Audio file not found: {audio_file}")
        return

    print(f"Audio file: {audio_file}")
    print(f"File size: {Path(audio_file).stat().st_size} bytes")

    # Test Parakeet
    parakeet_timings = await test_provider_timing("parakeet", audio_file, runs=5)

    # Test Moonshine
    moonshine_timings = await test_provider_timing("moonshine", audio_file, runs=5)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    if parakeet_timings:
        avg_parakeet = sum(parakeet_timings) / len(parakeet_timings)
        min_parakeet = min(parakeet_timings)
        max_parakeet = max(parakeet_timings)
        print(f"Parakeet:  avg={avg_parakeet:.0f}ms, min={min_parakeet:.0f}ms, max={max_parakeet:.0f}ms")

    if moonshine_timings:
        avg_moonshine = sum(moonshine_timings) / len(moonshine_timings)
        min_moonshine = min(moonshine_timings)
        max_moonshine = max(moonshine_timings)
        print(f"Moonshine: avg={avg_moonshine:.0f}ms, min={min_moonshine:.0f}ms, max={max_moonshine:.0f}ms")

    if parakeet_timings and moonshine_timings:
        avg_parakeet = sum(parakeet_timings) / len(parakeet_timings)
        avg_moonshine = sum(moonshine_timings) / len(moonshine_timings)
        speedup = avg_parakeet / avg_moonshine if avg_moonshine > 0 else float("inf")
        print(f"\nSpeedup: {speedup:.2f}x {'faster' if speedup > 1 else 'slower'} with Moonshine")

    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
