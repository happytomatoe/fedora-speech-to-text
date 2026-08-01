"""Debug mode for testing with pre-recorded audio files.

This module provides debug functionality for testing transcription
without requiring a microphone. It's only available in debug/e2e builds
and should be removed from production Containerfiles.

Usage:
    Set VOICE_TO_TEXT_DEBUG_FILE=/path/to/test.wav environment variable.
    When recording starts, it will:
    1. Show audio level for 3 seconds (visual feedback)
    2. Use the specified file for transcription
    3. Type the result
"""

import asyncio
import logging
import math
import os
from typing import Any, Callable

# Lazy imports to avoid circular dependencies
# These are resolved at runtime when handle_debug_recording is called
_get_batch_provider = None
_ConfigManager = None


def _lazy_imports():
    """Import provider dependencies lazily to avoid circular imports."""
    global _get_batch_provider, _ConfigManager
    if _get_batch_provider is None:
        from voice_to_text.providers import get_batch_provider
        from voice_to_text.config import ConfigManager
        _get_batch_provider = get_batch_provider
        _ConfigManager = ConfigManager

logger = logging.getLogger(__name__)

# Debug recording duration in seconds (show audio level before using test file)
DEBUG_RECORDING_DURATION = 3


async def handle_debug_recording(
    config: dict[str, Any],
    on_level: "Callable[[float], None] | None" = None,
) -> str | None:
    """Handle debug mode recording with a test file.

    Args:
        config: Recording configuration from D-Bus
        on_level: Optional callback to emit audio levels (0.0-1.0)

    Returns:
        Transcription text if successful, None otherwise
    """
    debug_file = os.environ.get("VOICE_TO_TEXT_DEBUG_FILE")
    if not debug_file:
        return None

    if not os.path.exists(debug_file):
        logger.error("Debug file not found: %s", debug_file)
        raise FileNotFoundError(f"Debug file not found: {debug_file}")

    logger.info("DEBUG MODE: Using test file %s instead of microphone", debug_file)
    logger.info("DEBUG MODE: Will show audio level for %d seconds", DEBUG_RECORDING_DURATION)

    # Lazy import to avoid circular dependencies
    _lazy_imports()

    # Get provider config
    config_mgr = _ConfigManager()
    provider = config.get("provider", "voxtral")
    provider_config = config_mgr.get_provider_config(provider)

    # Create provider
    batch_provider = await asyncio.to_thread(
        _get_batch_provider, provider, provider_config
    )

    try:
        # Simulate audio level feedback for a few seconds
        # This gives visual feedback that recording started
        logger.info("DEBUG MODE: Simulating audio capture for %d seconds...", DEBUG_RECORDING_DURATION)


        # Emit fake audio levels to show the indicator is working
        level = 0.0
        for i in range(DEBUG_RECORDING_DURATION * 10):  # 10 updates per second
            await asyncio.sleep(0.1)
            # Ramp up, hold, then ramp down
            progress = i / (DEBUG_RECORDING_DURATION * 10)
            if progress < 0.2:
                level = progress * 2.5  # ramp up 0 -> 0.5
            elif progress < 0.8:
                # Deterministic waveform using sin wave for visual variety
                level = 0.4 + 0.15 * math.sin(progress * 60)  # hold ~0.5 with sine wave
            else:
                level = max(0, (1.0 - progress) * 2.5)  # ramp down 0.5 -> 0

            level = max(0.0, min(1.0, level))
            if on_level:
                on_level(level)

            # Log progress every second
            if i % 10 == 0:
                logger.debug(
                    "DEBUG MODE: Simulating audio capture... %ds/%ds (level=%.2f)",
                    i // 10 + 1,
                    DEBUG_RECORDING_DURATION,
                    level,
                )

        # Final level reset
        if on_level:
            on_level(0.0)

        logger.info("DEBUG MODE: Audio simulation complete, transcribing test file...")

        # Transcribe the test file
        language = config.get("language", "en")
        text = await batch_provider.transcribe_file(debug_file, language)

        # Apply post-processing (same as normal pipeline)
        if text:
            postprocess_cfg = config_mgr.config.get("postprocess", {})
            if postprocess_cfg.get("enabled", True):
                from voice_to_text.postprocess import postprocess

                text = postprocess(
                    text,
                    lang=postprocess_cfg.get("language") or language,
                )

            # Apply custom word corrections (same as normal pipeline)
            raw_custom_words = config.get("custom_words")
            custom_words = (
                raw_custom_words if raw_custom_words is not None
                else postprocess_cfg.get("custom_words", [])
            )
            if custom_words:
                from voice_to_text.postprocess import apply_custom_words
                raw_threshold = config.get("custom_words_threshold")
                custom_words_threshold = (
                    raw_threshold if raw_threshold is not None
                    else postprocess_cfg.get("custom_words_threshold", 0.5)
                )
                text = apply_custom_words(
                    text,
                    custom_words=custom_words,
                    custom_words_threshold=custom_words_threshold,
                )

        logger.info("DEBUG MODE: Transcription result: %s", text[:100] if text else "(empty)")
        return text

    finally:
        await batch_provider.close()


def is_debug_mode() -> bool:
    """Check if debug mode is enabled via environment variable."""
    debug_file = os.environ.get("VOICE_TO_TEXT_DEBUG_FILE")
    return bool(debug_file)


def get_debug_file() -> str | None:
    """Get the debug test file path if set."""
    return os.environ.get("VOICE_TO_TEXT_DEBUG_FILE")
