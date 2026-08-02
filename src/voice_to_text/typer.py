"""
Continuous dotoolc typing engine for voice-to-text.

Keeps a persistent ``dotoolc`` (client to ``dotoold`` daemon) process open
and feeds it a stream of ``type ...\n`` and ``key backspace\n`` commands
via stdin. The process stays alive for the duration of the recording session.

``dotoolc`` (vs. ``dotool`` direct): ``dotoolc`` is a client to the ``dotoold``
daemon, which keeps virtual input devices registered — lower latency than
``dotool`` which re-registers devices on every invocation. ``dotoold`` is
assumed running (set up by ``dotool-quickstart.sh`` as a systemd user service).

References:
  - dotool docs: https://git.sr.ht/~geb/dotool
  - nerd-dictation diff algorithm: https://github.com/ideasman42/nerd-dictation
"""

import asyncio
import logging
import os
import shutil

logger = logging.getLogger(__name__)


class DotoolcNotFoundError(RuntimeError):
    """Raised when ``dotoolc`` is not found in PATH."""


class ContinuousTyper:
    """Types text via a persistent pipe to the ``dotoolc`` binary.

    Usage::

        typer = ContinuousTyper()
        await typer.start()              # open pipe (once at recording start)
        await typer.stream_type("hello")  # push text immediately
        await typer.stream_backspace(3)   # backspace last 3 chars
        ...
        await typer.stop()                # close pipe (recording done)
    """

    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._dotoolc_path: str | None = None
        self._typed_text: str = ""
        self._usable: bool = True  # set to False after first write failure
        self._pipe_path: str | None = None

    def _find_pipe_path(self) -> str | None:
        """Find the dotool pipe path, checking in order:
        1. $DOTOOL_PIPE environment variable
        2. $XDG_RUNTIME_DIR/dotool-pipe (proper per-user location per XDG spec)
        """
        # 1. Check environment variable
        env_pipe = os.environ.get("DOTOOL_PIPE")
        if env_pipe and os.path.exists(env_pipe):
            return env_pipe

        # 2. Check XDG_RUNTIME_DIR (proper location per XDG spec)
        xdg_runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        xdg_pipe = os.path.join(xdg_runtime, "dotool-pipe")
        if os.path.exists(xdg_pipe):
            return xdg_pipe

        return None

    async def start(self) -> None:
        """Start a persistent dotoolc process and keep stdin open."""
        self._dotoolc_path = shutil.which("dotoolc")
        if not self._dotoolc_path:
            # Check ~/.local/bin as fallback
            local_bin = os.path.expanduser("~/.local/bin/dotoolc")
            if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
                self._dotoolc_path = local_bin
            else:
                raise DotoolcNotFoundError(
                    "dotoolc not found in PATH or ~/.local/bin. "
                    "Install dotool: https://git.sr.ht/~geb/dotool\n"
                    "dotoolc requires dotoold running (dotool-quickstart.sh)"
                )

        # Find the pipe path
        self._pipe_path = self._find_pipe_path()
        if not self._pipe_path:
            raise DotoolcNotFoundError("dotool pipe not found. dotoold is not running.")
        logger.info("Using dotool pipe: %s", self._pipe_path)

        # Pass pipe path to dotoolc via environment
        env = os.environ.copy()
        env["DOTOOL_PIPE"] = self._pipe_path

        self._process = await asyncio.create_subprocess_exec(
            self._dotoolc_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        self._typed_text = ""

        # Send initial configuration: zero delays for snappy typing
        assert self._process.stdin is not None
        self._process.stdin.write(b"keydelay 0\ntypedelay 0\n")
        try:
            await self._process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            # dotoold not running — process started but pipe is dead
            try:
                stderr_output = await asyncio.wait_for(self._process.stderr.read(), timeout=2.0)
            except TimeoutError:
                stderr_output = b""
            error_msg = stderr_output.decode("utf-8", errors="replace").strip()
            logger.warning("dotoolc pipe broken (dotoold not running?): %s", error_msg)
            await self.stop()
            self._usable = False
            formatted_msg = (
                self._format_dotoolc_error(error_msg) if error_msg else ("dotoolc pipe broken (dotoold not running?)")
            )
            raise DotoolcNotFoundError(formatted_msg)

        # Check if dotoolc exited with error (no health check wait — errors caught by BrokenPipeError + returncode)
        if self._process.returncode is not None and self._process.returncode != 0:
            returncode = self._process.returncode
            stderr_output = await self._process.stderr.read()
            error_msg = stderr_output.decode("utf-8", errors="replace").strip()
            logger.warning("dotoolc exited with code %d: %s", returncode, error_msg)
            await self.stop()
            self._usable = False
            raise DotoolcNotFoundError(self._format_dotoolc_error(error_msg))

        logger.info("Continuous dotoolc pipe opened (pid=%d)", self._process.pid)

    def _format_dotoolc_error(self, error_msg: str) -> str:
        """Format dotoolc error with specific guidance based on the error type."""
        base_url = "https://git.sr.ht/~geb/dotool"

        if "no dotoold instance" in error_msg:
            return f"{error_msg}\n\ndotoold is not running"
        elif "does not grant write permission" in error_msg:
            return (
                f"{error_msg}\n\n"
                "Your user doesn't have permission to write to the dotool pipe.\n"
                "Add yourself to the 'input' group:\n"
                "  sudo usermod -aG input $USER\n"
                "  # Then log out and back in, or reboot"
            )
        else:
            return f"{error_msg}\n\nInstall dotool: {base_url}\ndotoolc requires dotoold running (dotool-quickstart.sh)"

    async def stream_type(self, text: str) -> None:
        """Push text instantly into the open dotoolc pipe.

        Text is written as ``type <text>\\n`` and flushed immediately.
        Handles newlines by emitting ``key enter`` between lines.
        """
        if not self._usable:
            return
        if not self._process or self._process.returncode is not None:
            logger.warning("dotoolc pipe not open, restarting...")
            await self.start()
        if not self._usable:
            return

        assert self._process is not None
        assert self._process.stdin is not None

        try:
            lines = text.split("\n")
            for i, line in enumerate(lines):
                # dotool interprets backslashes as escape sequences;
                # escape them so literal backslashes are typed
                safe = line.replace("\\", "\\\\")
                cmd = f"type {safe}\n"
                self._process.stdin.write(cmd.encode("utf-8"))
                if i < len(lines) - 1:
                    self._process.stdin.write(b"key enter\n")

            await self._process.stdin.drain()
            self._typed_text += text
        except (BrokenPipeError, ConnectionResetError) as e:
            logger.warning("dotoolc pipe broken, disabling typing: %s", e)
            self._usable = False
        except Exception as e:
            logger.error("Failed to stream text to dotoolc: %s", e)
            self._usable = False

    async def stream_backspace(self, count: int) -> None:
        """Backspace ``count`` characters via the dotoolc pipe.

        Optimized to use line-deletion (shift+home) and word-deletion (ctrl+backspace)
        shortcuts to reduce the number of keystrokes.
        """
        if not self._usable or not self._process or not self._process.stdin:
            return
        if count <= 0:
            return

        try:
            # 1. Line-level optimization: delete whole line if count is large enough
            lines = self._typed_text.split("\n")
            current_line = lines[-1]
            line_len = len(current_line)

            if line_len > 0 and count >= line_len:
                # Select to start of line and delete
                self._process.stdin.write(b"key shift+home\nkey backspace\n")

                # Update internal state: remove the last line
                if len(lines) > 1:
                    self._typed_text = "\n".join(lines[:-1])
                else:
                    self._typed_text = ""

                remaining = count - line_len
                # The newline itself counts as 1 character; delete it to move up
                if remaining > 0:
                    self._process.stdin.write(b"key backspace\n")
                    remaining -= 1
                    # Recurse to handle any remaining characters (previous lines)
                    await self.stream_backspace(remaining)
                    return

                await self._process.stdin.drain()
                return

            # 2. Word-level optimization: use ctrl+backspace for whole words
            # We can use ctrl+backspace if the segment we are deleting ends at a word boundary
            # and the whole word is within the 'count' limit.
            while count > 1:
                # Find the length of the last word in the current text
                # A word is defined as a sequence of non-space characters
                text_len = len(self._typed_text)
                if text_len == 0:
                    break

                # Find the start of the last word
                word_end = text_len
                word_start = word_end
                while word_start > 0 and self._typed_text[word_start - 1] != " ":
                    word_start -= 1

                word_len = word_end - word_start

                if word_len > 1 and word_len <= count:
                    self._process.stdin.write(b"key ctrl+backspace\n")
                    self._typed_text = self._typed_text[:word_start]
                    count -= word_len
                else:
                    # No more whole words can be deleted safely
                    break

            # 3. Fallback: individual backspaces for the remainder
            for _ in range(count):
                self._process.stdin.write(b"key backspace\n")

            if count > 0:
                self._typed_text = self._typed_text[:-count]

            await self._process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as e:
            logger.warning("dotoolc pipe broken, disabling typing: %s", e)
            self._usable = False
        except Exception as e:
            logger.error("Failed to stream backspaces to dotoolc: %s", e)
            self._usable = False

    async def stream_delete_word(self) -> None:
        """Delete the previous word using a single shortcut."""
        if not self._usable or not self._process or not self._process.stdin:
            return
        try:
            self._process.stdin.write(b"key ctrl+backspace\n")
            await self._process.stdin.drain()
            # Note: We can't accurately update _typed_text because we don't
            # know exactly how many characters the app will delete.
            # For a helper method, we just assume it's one word.
            text_len = len(self._typed_text)
            if text_len > 0:
                word_start = text_len
                while word_start > 0 and self._typed_text[word_start - 1] != " ":
                    word_start -= 1
                self._typed_text = self._typed_text[:word_start]
        except Exception as e:
            logger.error("Failed to stream delete_word: %s", e)
            self._usable = False

    async def stream_delete_line_start(self) -> None:
        """Delete from cursor to the start of the line."""
        if not self._usable or not self._process or not self._process.stdin:
            return
        try:
            self._process.stdin.write(b"key shift+home\nkey backspace\n")
            await self._process.stdin.drain()
            lines = self._typed_text.split("\n")
            if len(lines) > 1:
                self._typed_text = "\n".join(lines[:-1])
            else:
                self._typed_text = ""
        except Exception as e:
            logger.error("Failed to stream delete_line_start: %s", e)
            self._usable = False

    async def stream_delete_line_end(self) -> None:
        """Delete from cursor to the end of the line."""
        if not self._usable or not self._process or not self._process.stdin:
            return
        try:
            self._process.stdin.write(b"key shift+end\nkey backspace\n")
            await self._process.stdin.drain()
            # We don't know exactly what was deleted after the cursor
            # unless we track cursor position. For now, we leave _typed_text.
        except Exception as e:
            logger.error("Failed to stream delete_line_end: %s", e)
            self._usable = False

    async def stream_diff(self, new_text: str) -> None:
        """Diff ``new_text`` against the previously typed text and send only
        the necessary corrections (backspaces + new suffix).

        This is the nerd-dictation incremental typing algorithm:
        1. Find common prefix length between old and new text.
        2. Backspace the differing suffix.
        3. Type only the new suffix.
        """
        if new_text == self._typed_text:
            return

        old_text = self._typed_text

        # Find common prefix length
        common_len = 0
        min_len = min(len(old_text), len(new_text))
        while common_len < min_len and old_text[common_len] == new_text[common_len]:
            common_len += 1

        backspace_count = len(old_text) - common_len
        new_suffix = new_text[common_len:]

        if backspace_count > 0:
            await self.stream_backspace(backspace_count)
        if new_suffix:
            await self.stream_type(new_suffix)

    async def stop(self) -> None:
        """Close the dotoolc pipe and wait for the process to exit."""
        if self._process and self._process.stdin:
            try:
                self._process.stdin.close()
                await asyncio.wait_for(self._process.wait(), timeout=2.0)
            except TimeoutError:
                logger.warning("dotoolc did not exit after stdin close; killing")
                self._process.kill()
                await self._process.wait()
            except Exception:
                logger.exception("Failed to close dotoolc cleanly")
            finally:
                logger.info("Continuous dotoolc pipe closed")
                self._process = None
                self._typed_text = ""

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    @property
    def typed_text(self) -> str:
        return self._typed_text
