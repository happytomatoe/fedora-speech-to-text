"""Transcription provider factory and registry."""

from typing import Any

from .base import BatchProvider, StreamingProvider
from .deepgram import DeepgramProvider
from .elevenlabs import ElevenLabsProvider
from .groq import GroqProvider
from .moonshine import MoonshineProvider
from .parakeet import ParakeetProvider
from .sixty import SixtyProvider
from .template import TemplateProvider
from .voxtral import VoxtralProvider

_BATCH_PROVIDERS = {
    "groq": GroqProvider,
    "deepgram": DeepgramProvider,
    "voxtral": VoxtralProvider,
    "parakeet": ParakeetProvider,
    "60db": SixtyProvider,
    "elevenlabs": ElevenLabsProvider,
    "moonshine": MoonshineProvider,
    "template": TemplateProvider,
}

_STREAMING_PROVIDERS = {
    "deepgram": DeepgramProvider,
    "voxtral": VoxtralProvider,
    "60db": SixtyProvider,
    "moonshine": MoonshineProvider,
}


def get_batch_provider(name: str, config: dict[str, Any]) -> BatchProvider:
    """Get batch provider instance.

    Args:
        name: Provider name.
        config: Provider configuration.

    """
    if name not in _BATCH_PROVIDERS:
        raise ValueError(f"Batch provider '{name}' not found. Available: {list(_BATCH_PROVIDERS.keys())}")
    return _BATCH_PROVIDERS[name](config)  # type: ignore[abstract]


def get_streaming_provider(name: str, config: dict[str, Any]) -> StreamingProvider:
    """Get streaming provider instance.

    Args:
        name: Provider name.
        config: Provider configuration.

    """
    if name not in _STREAMING_PROVIDERS:
        raise ValueError(f"Streaming provider '{name}' not found. Available: {list(_STREAMING_PROVIDERS.keys())}")
    return _STREAMING_PROVIDERS[name](config)  # type: ignore[return-value]
