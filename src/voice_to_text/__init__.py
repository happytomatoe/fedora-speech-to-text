"""Voice-to-text speech recognition service."""

import contextlib

__version__ = "0.1.0"

_SOURCE_HASH = None

# Optional generated build-info module; absence is expected in dev checkouts.
with contextlib.suppress(ImportError):
    from voice_to_text._build_info import SOURCE_HASH  # type: ignore

    _SOURCE_HASH = SOURCE_HASH


def source_hash() -> str | None:
    """Return the source build hash, or None if unavailable."""
    return _SOURCE_HASH or None
