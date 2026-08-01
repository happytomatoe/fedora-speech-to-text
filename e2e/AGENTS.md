# E2E Test Instructions

## Overview

E2E tests verify the GNOME extension's visual appearance using screenshot comparison. They do NOT test audio functionality.

## What We Test

- Desktop with extension indicator (mic icon in top bar)
- Preferences dialog screenshot (captured via Shell.Screenshot, not xwd)
- Recording state with notification
- Recording indicator with audio level meter
- Transcription result typed into terminal

## What We Do NOT Test

- **Audio levels** — The meter is expected to be EMPTY (gray background). We do not play audio or test audio levels.
- **Microphone** — No microphone is needed or used.
- **PipeWire loopback** — Not used for visual testing.
- **Actual audio playback** — Audio plays only through the file-to-transcription path, not through speakers.

## How Audio Works

1. Debug mode is enabled via `VOICE_TO_TEXT_DEBUG_FILE` environment variable
2. When recording starts, debug mode simulates audio levels for 3 seconds (visual feedback)
3. Debug mode transcribes the pre-recorded WAV file (`e2e/fixtures/test-audio.wav`) using the local Parakeet provider
4. The transcription result is typed into a terminal window
5. Screenshots capture each state for visual regression testing
## How Screenshots Work

1. E2E tests run on a **QEMU VM** (not a container). The VM boots Fedora with GNOME Shell on a virtual display.
2. Screenshots are captured via the **QEMU monitor** (`screendump` command) through a Unix socket, then converted from PPM to PNG.
3. **Extension icon location**: The microphone/recording indicator is in the **top-right corner** of the GNOME top bar.
4. **Preferences**: Captured via `org.gnome.Shell.Eval` → `Shell.Screenshot` from inside gnome-shell. GNOME 47 runs extension prefs in-process via Clutter. `--unsafe-mode` is enabled via dconf to allow Eval access. Falls back to verification-only (window exists + geometry) if Eval screenshot fails.
5. Comparison: `compare -metric MSE reference.png actual.png diff.png` — MSE < 100 = pass.

## Running Tests

```bash
# Update reference screenshots
cd e2e && bun run e2e.ts --update

# Run tests against references
cd e2e && bun run e2e.ts

# Or via just
just qemu-e2e-update-ts   # update references
just e2e                   # run tests
```

Transcription uses the local Parakeet provider (no API key needed).

## VM Setup

- **Base image**: `e2e/qemu-images/base.qcow2` (QEMU qcow2 image with Fedora + GNOME Shell)
- **SSH**: port 2222, user `testuser`, key `e2e/qemu-images/id_ed25519`
- **Python**: 3.13 via uv venv (deployed to VM via SSH)
- **Extension**: installed to VM via SSH rsync
- **Services**: D-Bus service for voice-to-text transcription (started inside VM)
- **Framework**: TypeScript + bun (`e2e.ts`), uses `@microsoft/shell-use` for SSH/PTY interaction and `ssh2` for deployment

## Important Notes

- **Do NOT play audio through the VM** — it will come out of your speakers
- **Do NOT try to fix PipeWire loopback** — it's not needed for visual testing
- **Do NOT add microphone tests** — the audio level meter shows empty by design
- The transcription test uses a pre-recorded file, not live audio
- **Preferences screenshots**: Captured via Eval + Shell.Screenshot from inside gnome-shell. GNOME 47 runs extension prefs in-process via Clutter. We use `org.gnome.Shell.Eval` to call `Shell.Screenshot` which captures the composited output. Falls back to verification-only if Eval fails. `--unsafe-mode` enabled via dconf (Eval guarded by `global.context.unsafe_mode` since GNOME 41).
