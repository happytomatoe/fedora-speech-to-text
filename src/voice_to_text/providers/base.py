"""Base provider interface for transcription services."""

import asyncio
import contextlib
import json
import logging
import os
import subprocess
from abc import ABC, abstractmethod
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Shared HTTP client — created once at import time, reused across all providers.
# This avoids the ~300ms cost of creating a new client per recording.
_shared_client: httpx.AsyncClient | None = None


def get_shared_client() -> httpx.AsyncClient:
    """Get or create the shared HTTP client (lazy initialization)."""
    global _shared_client  # noqa: PLW0603
    if _shared_client is None:
        _shared_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10, read=120, write=10, pool=5),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _shared_client


async def close_shared_client() -> None:
    """Close the shared HTTP client on service shutdown."""
    global _shared_client  # noqa: PLW0603
    if _shared_client is not None:
        await _shared_client.aclose()
        _shared_client = None


# API key fingerprint threshold
_API_KEY_MIN_LEN = 10


class BatchProvider(ABC):
    """Provider that transcribes complete audio files."""

    @abstractmethod
    def __init__(self, config: dict[str, Any]):
        """Initialize the batch provider."""
        pass

    @abstractmethod
    async def transcribe_file(
        self, audio_path: str, language: str = "en", custom_words: list[str] | None = None
    ) -> str:
        """Transcribe audio file (batch processing)."""

    @abstractmethod
    async def close(self) -> None:
        """Close provider resources (e.g. HTTP clients)."""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the provider name."""
        pass


class StreamingProvider(ABC):
    """Provider that transcribes audio in real-time via streaming.

    Subclasses that use the default `get_partial_result` should set:
        _partial_result: str | None
        _finalized_text: str
    Subclasses that override `get_partial_result` may not need these.
    """

    _partial_result: str | None
    _finalized_text: str

    @abstractmethod
    def __init__(self, config: dict[str, Any]):
        """Initialize the streaming provider."""
        pass

    @abstractmethod
    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Initialize a streaming session."""
        pass

    @abstractmethod
    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send an audio chunk for processing."""
        pass

    async def get_partial_result(self) -> str | None:
        """Get latest partial transcript (may change)."""
        if self._partial_result:
            return (
                (self._finalized_text + " " + self._partial_result).strip()
                if self._finalized_text
                else self._partial_result
            )
        return self._finalized_text or None

    @abstractmethod
    async def finalize_stream(self) -> str:
        """End stream and return final transcript."""

    @abstractmethod
    async def close(self) -> None:
        """Close provider resources (e.g. HTTP clients)."""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the provider name."""
        pass


def _execute_command_for_key(command: str, *, timeout: float = 10) -> str:
    """Execute shell command, return stdout as API key."""
    logger.info("Executing API key command")
    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
            proc.communicate()
            raise ValueError(f"API key command timed out after {timeout:.0f}s") from None

        if proc.returncode != 0:
            raise ValueError(f"API key command failed (exit {proc.returncode}): {stderr.strip()}")

        api_key = stdout.strip()
        if not api_key:
            raise ValueError("API key command returned empty output")

        logger.debug("Command executed successfully")
        return api_key

    except FileNotFoundError as e:
        raise ValueError(f"API key command not found: {command}") from e
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"API key command error: {e}") from e


class AsyncKeyMixin:
    """Mixin for providers that support async API key resolution.

    Generic - works with any provider that uses resolve_api_key().
    """

    _api_key_future: asyncio.Future[str] | None = None
    _pending_key_command: str | None = None  # !!command string for deferred resolution
    api_key: str
    _config: dict[str, Any]

    def _init_async_key(self, key_or_future: str | asyncio.Future[str]) -> None:
        """Initialize async key storage.

        If key_or_future is a "!!command" string, store it for deferred
        future creation in _ensure_api_key (runs in main async context).
        """
        if isinstance(key_or_future, asyncio.Future):
            self._api_key_future = key_or_future
            self._pending_key_command = None
            self.api_key = ""  # placeholder
        elif isinstance(key_or_future, str) and key_or_future.startswith("!!"):
            # Deferred: store command, create Future later in async context
            self._pending_key_command = key_or_future[2:]  # strip leading !!
            self._api_key_future = None
            self.api_key = ""  # placeholder
        else:
            self._api_key_future = None
            self._pending_key_command = None
            self.api_key = key_or_future

    async def _ensure_api_key(self) -> str:
        """Ensure API key is resolved, awaiting future if needed.

        Creates the Future from pending !!command in the main async context.
        """
        # Create future from pending !!command (now in async context)
        if self._pending_key_command is not None:
            logger.info("Starting async API key resolution: %s", self._pending_key_command)
            self._api_key_future = _execute_command_for_key_async(self._pending_key_command)
            self._pending_key_command = None
        if self._api_key_future is not None:
            self.api_key = await await_api_key(self._api_key_future)
            self._api_key_future = None
        return self.api_key


def _execute_command_for_key_async(command: str, *, timeout: float = 10) -> asyncio.Future[str]:
    """Execute shell command in background, return Future for API key.

    Returns a Future that resolves to the API key string.
    The Future can be awaited or checked with .done() / .result().
    """
    loop = asyncio.get_event_loop()
    return loop.run_in_executor(None, _execute_command_for_key, command)


async def await_api_key(key_or_future: str | asyncio.Future[str]) -> str:
    """Await an API key Future, or return the string directly.

    Generic helper for ALL providers.
    """
    if isinstance(key_or_future, str):
        return key_or_future
    return await key_or_future


def resolve_api_key(
    config: dict[str, Any],
    default_env: str,
    extra_envs: tuple[str, ...] = (),
    provider_name: str | None = None,
) -> str:
    """Resolve API key from environment variable or config.

    Resolution order (env > config):
    1. Environment variable (via api_key_env or default_env)
    2. Config file api_key field (supports !command substitution)

    Raises ValueError if not found.
    """
    source_used = "none"
    env_var = config.get("api_key_env", default_env)
    key = os.getenv(env_var)
    if not key:
        for env in extra_envs:
            key = os.getenv(env)
            if key:
                break
    if key:
        source_used = f"env:{env_var or extra_envs}"
    # 2. Config file
    if not key:
        key = config.get("api_key")
        if key:
            source_used = "config:api_key"

    if not key:
        all_vars = (*extra_envs, config.get("api_key_env", default_env))
        raise ValueError(f"No API key found in environment ({all_vars}) or config")
    # Log key fingerprint for debugging (first 6 + last 4 chars)
    fingerprint = f"{key[:6]}...{key[-4:]}" if len(key) > _API_KEY_MIN_LEN else f"{key[:3]}...{key[-2:]}"
    logger.info("API key resolved: provider=%s source=%s fingerprint=%s", provider_name, source_used, fingerprint)

    # 4. Command substitution (!command or !!command)
    if key and key.startswith("!!"):
        # Async mode: return raw command string; Future created later in async context
        command = key[2:]  # strip leading !!
        logger.info("API key command will run in background: %s", command)
        return key  # return "!!command" as-is for deferred resolution
    elif key and key.startswith("!"):
        # Sync mode (existing behavior)
        command = key[1:]  # strip leading !
        return _execute_command_for_key(command)

    return key


class WebSocketStreamingProvider(StreamingProvider):
    """Shared WebSocket streaming logic for providers using the Deepgram-compatible protocol.

    Subclasses implement: __init__, transcribe_file, start_stream (URL/headers), name.

    Uses the ``websockets`` async library (replaces legacy websocket-client).
    """

    _partial_result: str | None
    _finalized_text: str
    _ws: Any  # websockets.WebSocketClientProtocol | None

    def _init_ws_state(self) -> None:
        self._partial_result = None
        self._finalized_text = ""
        self._ws = None

    async def _connect_ws(self, ws_url: str, headers: dict[str, str]) -> None:
        """Open a persistent WebSocket connection."""
        import time as _time  # noqa: PLC0415

        import websockets  # noqa: PLC0415

        _t0 = _time.monotonic()
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        ws_headers = list(headers.items())
        self._ws = await websockets.connect(ws_url, additional_headers=ws_headers)
        self._partial_result = None
        self._finalized_text = ""
        logger.info("[PROFIL] WS connect to %s: %.3fs", ws_url.split("?", maxsplit=1)[0], _time.monotonic() - _t0)

    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send an audio chunk to the WebSocket."""
        if self._ws is None:
            raise RuntimeError("Stream not started. Call start_stream() first.")
        try:
            await self._ws.send(audio_chunk)
            await self._process_messages()
        except Exception as e:
            logger.warning("Error sending audio to %s stream: %s", self.name, e)
            self._ws = None
            raise RuntimeError("Streaming connection lost") from e

    async def get_partial_result(self) -> str | None:
        """Get the latest partial transcript."""
        if self._partial_result:
            return (
                (self._finalized_text + " " + self._partial_result).strip()
                if self._finalized_text
                else self._partial_result
            )
        return self._finalized_text or None

    async def finalize_stream(self) -> str:
        """Finalize the streaming session and return the complete text."""
        if self._ws is None:
            result = (
                (self._finalized_text + " " + self._partial_result).strip()
                if self._partial_result
                else self._finalized_text
            )
            self._partial_result = None
            self._finalized_text = ""
            return result

        try:
            await self._ws.send(json.dumps({"type": "CloseStream"}))
            await asyncio.wait_for(self._drain_final_transcripts(), timeout=2.0)
        except TimeoutError as e:
            logger.debug("Timeout draining %s stream during close: %s", self.name, e)
        except Exception as e:
            logger.warning("Error closing %s stream: %s", self.name, e)
        finally:
            if self._ws is not None:
                with contextlib.suppress(Exception):
                    await self._ws.close()

        result = self._finalized_text
        self._ws = None
        self._partial_result = None
        self._finalized_text = ""
        return result

    async def _drain_final_transcripts(self) -> None:
        """Collect remaining final transcripts until the server closes the stream."""
        assert self._ws is not None
        while True:
            msg = await self._ws.recv()
            if not isinstance(msg, str):
                continue
            data = json.loads(msg)
            if data.get("type", "") != "Results":
                continue
            channel = data.get("channel") or {}
            alternatives = channel.get("alternatives") or []
            transcript = alternatives[0].get("transcript", "") if alternatives else ""
            if transcript:
                self._finalized_text = (self._finalized_text + " " + transcript).strip()

    async def _process_messages(self) -> None:
        if self._ws is None:
            return

        try:
            async with asyncio.timeout(0.01):
                while True:
                    msg = await self._ws.recv()
                    if isinstance(msg, str):
                        data = json.loads(msg)
                        msg_type = data.get("type", "unknown")
                        if msg_type == "Results":
                            logger.debug("Deepgram Results: %s", msg)
                            channel = data.get("channel", {})
                            alternatives = channel.get("alternatives", [{}])
                            transcript = alternatives[0].get("transcript", "") if alternatives else ""
                            is_final = data.get("is_final", False)
                            if is_final and transcript:
                                self._finalized_text = (self._finalized_text + " " + transcript).strip()
                                self._partial_result = None
                            elif transcript:
                                self._partial_result = transcript
                        elif msg_type == "Error":
                            logger.error("%s stream error: %s", self.name, data.get("message"))
        except (TimeoutError, asyncio.CancelledError):
            pass
        except Exception as e:
            logger.warning("Error processing %s messages: %s", self.name, e)
            self._ws = None
