"""Voice-to-text speech recognition service."""

__version__ = "0.1.0"

_SOURCE_HASH = None

try:
    from voice_to_text._build_info import SOURCE_HASH  # type: ignore

    _SOURCE_HASH = SOURCE_HASH
except ImportError:
    pass


def source_hash() -> str | None:
    """Return the source build hash, or None if unavailable."""
    return _SOURCE_HASH or None
