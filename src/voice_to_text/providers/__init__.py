"""Transcription provider factory and registry."""

from typing import Any

from .base import BatchProvider, StreamingProvider
from .custom import CustomProvider
from .deepgram import DeepgramProvider
from .elevenlabs import ElevenLabsProvider
from .groq import GroqProvider
from .moonshine import MoonshineProvider
from .parakeet import ParakeetProvider
from .sixty import SixtyProvider
from .voxtral import VoxtralProvider

_BATCH_PROVIDERS = {
    "groq": GroqProvider,
    "deepgram": DeepgramProvider,
    "voxtral": VoxtralProvider,
    "parakeet": ParakeetProvider,
    "60db": SixtyProvider,
    "elevenlabs": ElevenLabsProvider,
    "moonshine": MoonshineProvider,
    "template": CustomProvider,
}

_STREAMING_PROVIDERS = {
    "deepgram": DeepgramProvider,
    "voxtral": VoxtralProvider,
    "60db": SixtyProvider,
    "moonshine": MoonshineProvider,
}


def _resolve_provider_class(name: str, config: dict[str, Any]) -> type[BatchProvider] | None:
    """Resolve the batch provider class for a section name.

    Built-in registry names (deepgram, template, …) map directly; custom
    config.yaml sections dispatch on their ``type`` field, so the section
    name itself can be anything.
    """
    if name in _BATCH_PROVIDERS:
        return _BATCH_PROVIDERS[name]
    type_name = config.get("type")
    if isinstance(type_name, str) and type_name in _BATCH_PROVIDERS:
        return _BATCH_PROVIDERS[type_name]
    return None


def get_batch_provider(name: str, config: dict[str, Any]) -> BatchProvider:
    """Get batch provider instance.

    Args:
        name: Provider name (config.yaml section name for custom providers).
        config: Provider configuration.

    """
    provider_cls = _resolve_provider_class(name, config)
    if provider_cls is None:
        raise ValueError(f"Batch provider '{name}' not found. Available: {list(_BATCH_PROVIDERS.keys())}")
    if provider_cls is CustomProvider:
        # CustomProvider takes the config.yaml section name for log identity.
        return CustomProvider(config, name=name)  # type: ignore[abstract]
    return provider_cls(config)  # type: ignore[abstract]


def get_streaming_provider(name: str, config: dict[str, Any]) -> StreamingProvider:
    """Get streaming provider instance.

    Args:
        name: Provider name.
        config: Provider configuration.

    """
    if name not in _STREAMING_PROVIDERS:
        raise ValueError(f"Streaming provider '{name}' not found. Available: {list(_STREAMING_PROVIDERS.keys())}")
    return _STREAMING_PROVIDERS[name](config)  # type: ignore[return-value]
