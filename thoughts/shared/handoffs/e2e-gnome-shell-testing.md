---
date: 2026-07-24T11:15:00+00:00
git_commit: ed0e72d
branch: feat/gnome-shell-pod-visual-regression
repository: voice-to-text
topic: "E2E GNOME Shell Visual Regression Testing"
tags: [e2e, visual-testing, container, podman, gnome-shell, dbus]
---

# Handoff: E2E GNOME Shell Visual Regression Testing

## Task(s)
Implementing automated visual regression testing for the GNOME Shell extension using gnome-shell-pod containers, including E2E testing with the D-Bus service.

**Status: ~85% Complete**

- ✅ Container builds with Python D-Bus service dependencies
- ✅ Extension installs correctly (before GNOME Shell starts)
- ✅ 4 snapshot states captured at 800x600
- ✅ Polling-based waiting (no fixed sleeps)
- ✅ Snapshot comparison with MSE threshold
- 🔄 E2E recording test (D-Bus service starts but container build fails on Python path)
- ❌ Push to PR #57 (git auth issue in toolbox)

## Critical References
- `tests/e2e/Containerfile` - Container build definition
- `tests/e2e/snapshot.sh` - Main test script with polling
- `tests/e2e/voice-to-text.conf` - E2E test config for Deepgram
- `gnome-ext/extension.js` - Extension code (indicator, D-Bus interface)

## Recent changes
- `tests/gnome-tests/` → `tests/e2e/` - Renamed folder
- `tests/e2e/Containerfile` - Added Python deps (dbus-next, httpx, sounddevice, numpy)
- `tests/e2e/snapshot.sh` - Rewrote with polling, 4 states
- `tests/e2e/build-ext-zip.sh` - New bash script replacing Python version
- `tests/e2e/voice-to-text.conf` - New config for E2E tests
- `justfile` - Added e2e-build, e2e-references, e2e-test, e2e-update recipes

## Learnings

### Container Setup
1. **Extension MUST be installed BEFORE starting GNOME Shell** - If installed after, it doesn't load properly
2. **Use dconf to enable extension** - `gnome-extensions enable` fails in headless mode
3. **Polling > Fixed sleeps** - Use `poll_until()` helper for reliable waits
4. **800x600 works** - Mutter minimum is 640x480, but 800x600 avoids layout issues

### Python in Container
1. **Path is `/usr/lib/python3.13/site-packages/`** - Not `/usr/lib/python3/site-packages/`
2. **numpy fails to build via pip** - Use `dnf install python3-numpy` instead
3. **dbus-next works with Python 3.13** - Python 3.15 has breaking changes

### D-Bus Service
1. **Service file location**: `/home/gnomeshell/.local/share/dbus-1/services/`
2. **Config location**: `/home/gnomeshell/.config/voice-to-text/config.yaml`
3. **API key via env var**: Set `DEEPGRAM_API_KEY` in container

### Visual Regression
1. **MSE < 100 threshold** - Tolerant of timestamp changes, catches real regressions
2. **Timestamps change every run** - Consider masking for pixel-perfect matching
3. **Extension indicator at x=695, y=12** on 800x600 screen

## Artifacts
- `tests/e2e/Containerfile` - Container definition (needs fix: Python path)
- `tests/e2e/snapshot.sh` - Main test script with polling
- `tests/e2e/build-ext-zip.sh` - Extension ZIP builder
- `tests/e2e/voice-to-text.conf` - E2E test config
- `tests/gnome-references/` - Reference screenshots (empty, need to regenerate)
- `justfile` - Updated with e2e-* recipes

## Action Items & Next Steps

### Priority 1: Fix Container Build
1. Fix Python site-packages path in Containerfile (line 30)
2. Test container builds successfully
3. Run `just e2e-references` to generate reference images

### Priority 2: Complete E2E Test
1. Start D-Bus service in container
2. Test recording via gdbus call
3. Capture recording state screenshot
4. Test transcription typed into GNOME search

### Priority 3: Push to PR #57
1. Commit all changes
2. Push to origin/feat/gnome-shell-pod-visual-regression
3. Update PR description with E2E testing info

## Other Notes

### Container Management
```bash
# Build container
podman build -t voice-to-text-e2e -f tests/e2e/Containerfile .

# Run container
podman run --rm --cap-add=SYS_NICE --cap-add=IPC_LOCK -td voice-to-text-e2e

# Run E2E tests
just e2e-references  # Generate references
just e2e-test        # Run tests
```

### Snapshot States (4 total)
1. Desktop with extension indicator
2. Preferences dialog - top
3. Preferences dialog - bottom (scrolled)
4. Transcription typed into GNOME search

### D-Bus Service Commands
```bash
# Get status
gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.GetStatus

# Start recording
gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StartRecording '{"provider": "deepgram", "output_method": "search"}'

# Stop recording
gdbus call --session --dest com.happytomatoe.VoiceToText --object-path /com/happytomatoe/VoiceToText --method com.happytomatoe.VoiceToText.StopRecording
```
