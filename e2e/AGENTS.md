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
3. Debug mode transcribes the pre-recorded WAV file (`e2e/fixtures/test-audio.wav`) using Deepgram API
4. The transcription result is typed into a terminal window
5. Screenshots capture each state for visual regression testing
## How Screenshots Work

1. Container runs GNOME Shell on Xvfb (`/opt/Xvfb_screen0` is the framebuffer)
2. Screenshots captured via: `podman cp <container>:/opt/Xvfb_screen0 - | tar xf - --to-command "convert xwd:- output.png"` (ImageMagick)
3. **Extension icon location**: The microphone/recording indicator is in the **top-right corner** of the GNOME top bar
4. Audio level captured with crop: `convert xwd:- -crop 80x25+655+2 +repage output.png` (top-right panel area for extension indicator)
5. **Preferences**: Captured via Eval + Shell.Screenshot from inside gnome-shell process. GNOME 47 runs extension prefs in-process via Clutter. We use `org.gnome.Shell.Eval` to call `Shell.Screenshot` which captures the composited output. `--unsafe-mode` is enabled via systemd drop-in to allow Eval access. Falls back to verification-only (window exists + geometry) if Eval screenshot fails.
6. Comparison: `compare -metric MSE reference.png actual.png diff.png` — MSE < 100 = pass

## Running Tests

```bash
# Update reference screenshots
./e2e/scripts/snapshot.sh --update

# Run tests against references
./e2e/scripts/snapshot.sh

# Requires: DEEPGRAM_API_KEY env var for transcription
export DEEPGRAM_API_KEY=your_key_here
```

## Container Setup

- Base image: `ghcr.io/schneegans/gnome-shell-pod-41` (Fedora 41, GNOME 47)
- Display: `:100` (to avoid conflicts with host)
- User: `gnomeshell` (UID 1000)
- Python: 3.13 via uv venv
- Services: D-Bus service for voice-to-text transcription

## Important Notes

- **Do NOT play audio through the container** — it will come out of your speakers
- **Do NOT try to fix PipeWire loopback** — it's not needed for visual testing
- **Do NOT add microphone tests** — the audio level meter shows empty by design
- The transcription test uses a pre-recorded file, not live audio
- **Preferences screenshots**: Captured via Eval + Shell.Screenshot from inside gnome-shell. GNOME 47 runs extension prefs in-process via Clutter. We use `org.gnome.Shell.Eval` to call `Shell.Screenshot` which captures the composited output. Falls back to verification-only if Eval fails. `--unsafe-mode` enabled via systemd drop-in (Eval guarded by `global.context.unsafe_mode` since GNOME 41).
