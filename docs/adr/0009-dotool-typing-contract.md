# 0009 — dotool typing contract and its limits

- Status: Accepted
- Date: 2026-11-22

## Context

`DotoolTyper` drives `dotoolc` over a pipe to type into the focused window. The output method is
selected as `type` and is the fallback when the Mutter-based methods are unavailable.

## Decisions

### 1. Pipe location

The pipe path is resolved in order: `$DOTOOL_PIPE`, then
`$XDG_RUNTIME_DIR/dotool-pipe` (falling back to `/run/user/<uid>`). The second location is the
per-user location specified by XDG. If neither exists, typing is unavailable and the engine
reports "dotool pipe not found. dotoold is not running."

### 2. `dotoolc` is installed from PATH or `~/.local/bin`

`shutil.which("dotoolc")` is the primary lookup; `~/.local/bin/dotoolc` is the fallback for
user-local installs that are not on the service's PATH.

### 3. Initial key delays are zero

After spawn, `keydelay 0` and `typedelay 0` are written to the pipe. Typing latency matters more
than per-key pacing here, and the diff algorithm already limits the number of keystrokes.

### 4. A dead pipe is detected on first write

If `drain()` raises `BrokenPipeError`/`ConnectionResetError`, the stderr is read (with a 2 s
timeout) and the error is surfaced as `DotoolcNotFoundError` with the daemon's message. There is
no separate health-check round trip before the first write.

### 5. Backslashes are escaped

dotool interprets backslashes as escape sequences, so every `\` in the text is doubled before it
is sent. Without this, paths and code snippets are mangled.

### 6. Diffs are applied line-first, then word, then character

Backspacing uses `shift+home` when a whole line can be removed, `ctrl+backspace` for whole words,
and individual backspaces for the remainder. This reduces keystrokes and therefore output latency.

## Known limitation

`_typed_text` is updated heuristically when words and lines are deleted, because the typer cannot
observe how many characters the target application actually removed. Deletions after the cursor
(`delete_line_end`) leave the tracked text stale. The correct fix is to track cursor position and
deletion results rather than assuming; tracked as an issue rather than documented as a comment.
