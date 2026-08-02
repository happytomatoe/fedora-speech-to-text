"""Base provider interface for transcription services."""

import asyncio
import json
import logging
import os
import subprocess
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger(__name__)


class BatchProvider(ABC):
    """Provider that transcribes complete audio files."""

    @abstractmethod
    def __init__(self, config: dict[str, Any]):
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
        pass

    @abstractmethod
    async def start_stream(self, language: str = "en", sample_rate: int = 16000) -> None:
        """Initialize a streaming session."""
        pass

    @abstractmethod
    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send an audio chunk for processing."""
        pass

    async def get_partial_result(self) -> str | None:  # noqa: S7503 - async interface
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
            raise ValueError(f"API key command timed out after {timeout:.0f}s")

        if proc.returncode != 0:
            raise ValueError(f"API key command failed (exit {proc.returncode}): {stderr.strip()}")

        api_key = stdout.strip()
        if not api_key:
            raise ValueError("API key command returned empty output")

        logger.debug("Command executed successfully")
        return api_key

    except FileNotFoundError:
        raise ValueError(f"API key command not found: {command}")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"API key command error: {e}") from e


def _resolve_key_from_env(
    env_var: str, extra_envs: tuple[str, ...]
) -> tuple[str | None, str]:
    """Try to find API key in environment variables."""
    key = os.getenv(env_var)
    if key:
        return key, f"env:{env_var}"
    for env in extra_envs:
        key = os.getenv(env)
        if key:
            return key, f"env:{env}"
    return None, "none"


def _key_fingerprint(key: str) -> str:
    """Return a masked fingerprint of the API key for logging."""
    if len(key) > 10:
        return f"{key[:6]}...{key[-4:]}"
    return f"{key[:3]}...{key[-2:]}"


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
    env_var = config.get("api_key_env", default_env)
    key, source_used = _resolve_key_from_env(env_var, extra_envs)

    # 2. Config file
    if not key:
        key = config.get("api_key")
        if key:
            source_used = "config:api_key"

    if not key:
        all_vars = (env_var,) + extra_envs
        raise ValueError(f"No API key found in environment ({all_vars}) or config")

    logger.info(
        "API key resolved: provider=%s source=%s fingerprint=%s",
        provider_name,
        source_used,
        _key_fingerprint(key),
    )

    # 4. Command substitution (!command)
    if key.startswith("!"):
        return _execute_command_for_key(key[1:])

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
        import time as _time

        import websockets

        _t0 = _time.monotonic()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        ws_headers = list(headers.items())
        self._ws = await websockets.connect(ws_url, additional_headers=ws_headers)
        self._partial_result = None
        self._finalized_text = ""
        logger.info("[PROFIL] WS connect to %s: %.3fs", ws_url.split("?")[0], _time.monotonic() - _t0)

    async def send_audio(self, audio_chunk: bytes) -> None:
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
        if self._partial_result:
            return (
                (self._finalized_text + " " + self._partial_result).strip()
                if self._finalized_text
                else self._partial_result
            )
        return self._finalized_text or None

    def _get_pending_result(self) -> str:
        """Combine finalized text with any partial result."""
        if self._partial_result:
            text = (self._finalized_text + " " + self._partial_result).strip()
        else:
            text = self._finalized_text
        self._partial_result = None
        self._finalized_text = ""
        return text

    async def _drain_close_messages(self) -> None:
        """Read final messages after sending CloseStream."""
        try:
            async with asyncio.timeout(2.0):
                while True:
                    msg = await self._ws.recv()
                    self._handle_close_message(msg)
        except TimeoutError:
            pass

    async def finalize_stream(self) -> str:
        if self._ws is None:
            return self._get_pending_result()

        try:
            await self._ws.send(json.dumps({"type": "CloseStream"}))
            await self._drain_close_messages()
        except Exception as e:
            logger.warning("Error closing %s stream: %s", self.name, e)
        finally:
            await self._close_ws()

        result = self._finalized_text
        self._ws = None
        self._partial_result = None
        self._finalized_text = ""
        return result

    async def _close_ws(self) -> None:
        """Close WebSocket, ignoring errors."""
        if self._ws is None:
            return
        try:
            await self._ws.close()
        except Exception:
            pass

    def _handle_close_message(self, msg: str) -> None:
        """Process a single WebSocket message during stream finalization."""
        if not isinstance(msg, str):
            return
        data = json.loads(msg)
        if data.get("type") != "Results":
            return
        channel = data.get("channel", {})
        alternatives = channel.get("alternatives", [{}])
        if not alternatives:
            return
        transcript = alternatives[0].get("transcript", "")
        if transcript:
            self._finalized_text = (self._finalized_text + " " + transcript).strip()

    def _handle_stream_message(self, msg: str) -> None:
        """Process a single streaming message (partial/final transcript)."""
        if not isinstance(msg, str):
            return
        data = json.loads(msg)
        msg_type = data.get("type", "unknown")
        if msg_type == "Results":
            logger.debug("%s Results: %s", self.name, msg)
            channel = data.get("channel", {})
            alternatives = channel.get("alternatives", [{}])
            transcript = alternatives[0].get("transcript", "") if alternatives else ""
            if data.get("is_final", False) and transcript:
                self._finalized_text = (self._finalized_text + " " + transcript).strip()
                self._partial_result = None
            elif transcript:
                self._partial_result = transcript
        elif msg_type == "Error":
            logger.error("%s stream error: %s", self.name, data.get("message"))

    async def _process_messages(self) -> None:
        """Process pending WebSocket messages (non-blocking)."""
        if self._ws is None:
            return
        try:
            async with asyncio.timeout(0.01):
                while True:
                    msg = await self._ws.recv()
                    self._handle_stream_message(msg)
        except (TimeoutError, asyncio.CancelledError):  # noqa: UP041
            pass
        except Exception as e:
            logger.warning("Error processing %s messages: %s", self.name, e)
            self._ws = None
