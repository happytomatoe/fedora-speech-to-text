"""Profiling utilities for voice-to-text engine.

Provides configurable granularity profiling with zero overhead when disabled.
"""

import logging
import time
from contextlib import contextmanager
from typing import Any

from voice_to_text.config import ConfigManager

logger = logging.getLogger(__name__)


class Profiler:
    """Configurable profiler with three granularity levels.

    Levels:
    - off: disabled, zero overhead.
    - basic: logs total processing time only.
    - detailed: logs each phase with deltas.
    """

    def __init__(self, config: dict[str, Any] | None = None):
        """Initialize the profiler."""
        self._config = config if config is not None else ConfigManager().config
        self._profiling_level = self._config.get("profiling", "off")
        self._enabled = self._profiling_level != "off"
        self._detailed = self._profiling_level == "detailed"

        self._start_time: float | None = None
        self._last_time: float | None = None
        self._phase_times: list[tuple[str, float, float]] = []  # (label, total_elapsed, delta)

    def start(self) -> None:
        """Start the profiler timer."""
        if not self._enabled:
            return
        self._start_time = time.monotonic()
        self._last_time = self._start_time
        self._phase_times.clear()

    def _log_phase(self, label: str) -> None:
        """Log a phase with delta and total elapsed."""
        if not self._enabled or self._start_time is None:
            return
        now = time.monotonic()
        total_elapsed = now - self._start_time
        delta = now - self._last_time if self._last_time is not None else 0.0
        self._last_time = now
        self._phase_times.append((label, total_elapsed, delta))

        if self._detailed:
            logger.info("[PROFIL] %s: +%.3fs (total %.3fs)", label, delta, total_elapsed)
        elif label == "total_processing_time":
            # In basic mode, only log the final total
            logger.info("[PROFIL] Total processing time: %.3fs", total_elapsed)

    @contextmanager
    def section(self, label: str):
        """Context manager for timing a code section.

        Usage:
            with profiler.section("transcription"):
                result = await provider.transcribe_file(...)
        """
        if not self._enabled:
            yield
            return

        section_start = time.monotonic()
        try:
            yield
        finally:
            if self._detailed:
                self._last_time = section_start
                self._log_phase(label)

    def phase(self, label: str) -> None:
        """Mark a phase completion point (for non-context-manager timing)."""
        if not self._enabled:
            return
        self._log_phase(label)

    def finish(self) -> float:
        """Finish profiling and return total elapsed time."""
        if not self._enabled or self._start_time is None:
            return 0.0
        total = time.monotonic() - self._start_time
        if self._detailed:
            logger.info("[PROFIL] total_processing_time: %.3fs", total)
        else:
            logger.info("[PROFIL] Total processing time: %.3fs", total)
        return total


def create_profiler(config: dict[str, Any] | None = None) -> Profiler:
    """Create a Profiler instance."""
    return Profiler(config)
