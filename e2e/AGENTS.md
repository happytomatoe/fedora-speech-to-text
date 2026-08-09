# E2E Test Instructions

## Overview

E2E tests verify the GNOME extension end-to-end: boot a QEMU VM, deploy the extension + Python service, play a test audio file, and verify the transcription result matches expected text. Visual regression via screenshots is also captured at each step.

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

1. A random test case is selected from `e2e/fixtures/test-cases.json` (each has a WAV file and expected transcription)
2. Debug mode is enabled via `VOICE_TO_TEXT_DEBUG_FILE` environment variable
3. When recording starts, debug mode simulates audio levels for 3 seconds (visual feedback)
4. Debug mode transcribes the pre-recorded WAV file using the local Parakeet provider
5. The transcription result is typed into a terminal window via dotool
6. Screenshots capture each state for visual regression testing
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

# Run tests (fresh, no snapshot) — ~85s per run
cd e2e && bun run e2e.ts

# Run tests with snapshot (fast, ~40s after first boot)
cd e2e && bun run e2e.ts --snapshot

# Or via just (uses --snapshot by default)
just qemu-e2e-update-ts   # update references
just e2e                   # run tests (~40s with snapshot)
```

**Snapshot mode**: First run deploys everything and saves a QEMU snapshot. Subsequent runs restore the snapshot, skipping deployment (~50s saved). The snapshot persists between runs using a fixed overlay in `persistent-run/main/`.

Transcription uses the local Parakeet provider (no API key needed).
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

## Key Learnings

1. **GNOME 50 removed `St.Spinner`** — Extension crashes on load. Fixed with custom GObject class using `St.Icon` + `process-working-symbolic` + Clutter rotation animation (`gnome-ext/indicator.js`).

2. **`org.gnome.Shell.Eval` is disabled in GNOME 50** — Returns `(false, '')` even with `development-tools: true`. Use `OverviewActive` D-Bus property instead for Activities state detection.

3. **Activities dismiss via D-Bus** — `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>'`. GVariant format must be `<false>` (no backslash escaping).

4. **`dismissActivities()` via `shell.exec()` kills tmux server** — The `shell.exec()` method captures screen text before/after commands and uses `waitCommand`. During Activities dismiss, gnome-shell processes the OverviewActive change, which causes screen repainting. This interferes with `shell.exec()`'s prompt detection, and somehow the tmux server dies. **Fix: use `execSync` directly** (bypassing `shell.exec()`) for the D-Bus call.

5. **dotool types into the focused window** — If Activities is open, dotool types into the Activities search bar instead of the terminal. The voice service uses dotool to type transcription results, so Activities MUST be dismissed before recording starts.

6. **tmux must be inside gnome-terminal** — `tmux new-session -d` creates a background session with no visible window. dotool can't type into it. Must use `gnome-terminal -- tmux new-session` to get a visible, focusable window.

7. **Test audio files**: `e2e/fixtures/test-*.wav` — each has expected transcription in `e2e/fixtures/test-cases.json`. A random test case is selected per run.

8. **Transcription capture**: Poll the voice service log (`/tmp/voice-service.log`) for `Transcription result:` instead of parsing tmux output. The log is the most reliable source. Fall back to tmux capture with prompt prefix stripping if log poll times out.

9. **Focus verification**: Use multiple retry attempts with longer settle waits. Activities may re-open after initial dismiss, so dismiss again right before recording. Click-to-focus may need 2-3 attempts to work reliably.

10. **Focus coordinates**: Terminal is centered at approximately (640, 400) in 1280x800 VM display.
