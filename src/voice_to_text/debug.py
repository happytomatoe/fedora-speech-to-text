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
import os
from typing import Any

logger = logging.getLogger(__name__)

# Debug recording duration in seconds (show audio level before using test file)
DEBUG_RECORDING_DURATION = 3


async def handle_debug_recording(config: dict[str, Any]) -> str | None:
    """Handle debug mode recording with a test file.
    
    Args:
        config: Recording configuration from D-Bus
        
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
    
    # Import here to avoid circular imports
    from voice_to_text.providers import get_batch_provider
    from voice_to_text.config import ConfigManager
    
    # Get provider config
    config_mgr = ConfigManager()
    provider = config.get("provider", "deepgram")
    provider_config = config_mgr.get_provider_config(provider)
    
    # Create provider
    batch_provider = await asyncio.to_thread(
        get_batch_provider, provider, provider_config
    )
    
    try:
        # Simulate audio level feedback for a few seconds
        # This gives visual feedback that recording started
        logger.info("DEBUG MODE: Simulating audio capture for %d seconds...", DEBUG_RECORDING_DURATION)
        
        # We'll emit fake audio levels to show the indicator is working
        # The actual recording is faked - we just need to show activity
        from voice_to_text.engine import EngineState
        
        # Note: We can't directly emit signals from here, but we log the activity
        for i in range(DEBUG_RECORDING_DURATION * 10):  # 10 updates per second
            await asyncio.sleep(0.1)
            # Log progress every second
            if i % 10 == 0:
                logger.debug("DEBUG MODE: Simulating audio capture... %ds/%ds", 
                           i // 10 + 1, DEBUG_RECORDING_DURATION)
        
        logger.info("DEBUG MODE: Audio simulation complete, transcribing test file...")
        
        # Transcribe the test file
        language = config.get("language", "en")
        text = await batch_provider.transcribe_file(debug_file, language)
        
        logger.info("DEBUG MODE: Transcription result: %s", text[:100] if text else "(empty)")
        return text
        
    finally:
        await batch_provider.close()


def is_debug_mode() -> bool:
    """Check if debug mode is enabled via environment variable."""
    return os.environ.get("VOICE_TO_TEXT_DEBUG_FILE") is not None


def get_debug_file() -> str | None:
    """Get the debug test file path if set."""
    return os.environ.get("VOICE_TO_TEXT_DEBUG_FILE")
