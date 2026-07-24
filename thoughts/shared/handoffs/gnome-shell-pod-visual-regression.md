---
date: 2026-07-24T06:50:00+00:00
git_commit: a77bc20
branch: feat/gnome-shell-pod-visual-regression
repository: voice-to-text
topic: "GNOME Shell Pod Visual Regression Testing Implementation"
tags: [gnome-shell, visual-testing, container, podman, extension]
---

# Handoff: GNOME Shell Pod Visual Regression Testing

## Task(s)
Implementing automated visual regression testing for the GNOME Shell extension using gnome-shell-pod containers.

**Status: ~95% Complete**

- ✅ Phase 1: Containerfile (working, builds in ~5s, 800x600 resolution)
- ✅ Phase 2: Test scripts created
- ✅ Phase 3: CI workflow
- ✅ Phase 4: Justfile recipes added
- ✅ Welcome tour disabled via dconf pre-seeding
- ✅ Screen resolution 800x600
- ✅ 5 reference screenshots captured
- ✅ All tests passing (MSE < 100)
- ✅ Extension loads correctly
- ✅ Preferences dialog captured (3 pages)
- ⏳ Push to PR #57 pending

## Critical References
- `thoughts/shared/plans/gnome-shell-pod-visual-regression.md` - Original implementation plan
- `tests/gnome-tests/Containerfile` - Container build definition
- `gnome-ext/extension.js` - Extension code (indicator positions, D-Bus interface)

## Recent changes
- `tests/gnome-tests/snapshot.sh` - 5 states: indicator, prefs (3 pages), desktop
- `tests/gnome-tests/Containerfile` - Resolution 800x600
- `tests/gnome-references/` - 5 reference screenshots
- Key fix: install extension BEFORE starting GNOME Shell

## Learnings

### Container Setup
1. **Base image**: `ghcr.io/schneegans/gnome-shell-pod-rawhide` (Fedora Rawhide, GNOME 48+)
2. **Systemd as PID 1**: The container MUST run systemd as PID 1. Do NOT set `USER gnomeshell` in Dockerfile - systemd needs root.
3. **Welcome tour**: Must be disabled via dconf database pre-seeding at build time, NOT via gsettings at runtime. The key is:
   ```
   /etc/dconf/db/local.d/00-gnome-shell
   [org/gnome/shell]
   welcome-dialog-last-shown-version='4294967295'
   ```
4. **Xvfb resolution**: Configured in `/etc/systemd/system/xvfb@.service` - change `1920x1080x24` to `1280x720x24`
5. **User bus**: Must wait for user bus with `set-env.sh wait-user-bus.sh` before starting GNOME Shell
6. **Container run flags**: `--cap-add=SYS_NICE --cap-add=IPC_LOCK` required
7. **Enable extension via dconf**: `gnome-extensions enable` fails in headless mode. Use `dconf write /org/gnome/shell/enabled-extensions '["voice-to-text@happytomatoe.com"]'` instead.

### Extension Interaction (BLOCKER)
1. **Indicator is NOT a window**: The extension indicator is drawn by GNOME Shell's panel, not a separate X11 window. xdotool cannot find it as a window.
2. **Click coordinates**: The indicator is at approximately x=25, y=12 on 1280x720 screen. However, clicking there triggers GNOME's Activities/search instead of the extension.
3. **Hotkey**: Default hotkey is `<Super>w` - this triggers the extension but without a D-Bus backend running, it shows "service not available" notification.
4. **D-Bus issue**: The extension needs the Python D-Bus service running to actually record. Without it, clicking the indicator just shows an error notification.

### What Works
- Container builds and starts
- GNOME Shell runs without welcome tour
- Extension loads and indicator appears in top bar
- Screenshots can be captured via `podman cp $POD:/opt/Xvfb_screen0`

### What Doesn't Work Yet
- Clicking the extension indicator (triggers search instead)
- Opening preferences dialog via xdotool
- Getting indicator coordinates via GNOME Shell eval (gdbus connection issues)

## Artifacts

### Created Files
- `tests/gnome-tests/Containerfile` - Container definition
- `tests/gnome-tests/build-ext-zip.py` - Extension ZIP builder
- `tests/gnome-tests/build.sh` - Local container build script
- `tests/gnome-tests/find-target.sh` - Two-pass image search
- `tests/gnome-tests/generate-references.sh` - Reference screenshot generator
- `tests/gnome-tests/run-test.sh` - Visual regression test runner
- `tests/gnome-tests/snapshot.sh` - Full-screen snapshot capture
- `.github/workflows/gnome-visual-tests.yml` - CI workflow
- `.containerignore` - Build context optimization
- `tests/gnome-references/` - 4 reference screenshots

### Modified Files
- `justfile` - Added 6 new recipes (gnome-test-build, gnome-references, gnome-test, gnome-snapshot, etc.)

## Action Items & Next Steps

### Priority 1: Fix Extension Interaction
1. **Find correct click coordinates**: The indicator position may need adjustment. Try using GNOME Shell's looking glass (Alt+F2, `main ExtensionManager.lookup("voice-to-text@happytomatoe.com").stateObj._indicator.get_transformed_position()`)
2. **Alternative approach**: Instead of clicking the indicator, use the hotkey `<Super>w` to toggle recording. This works but needs the D-Bus service running.
3. **Install extension before starting GNOME Shell**: This ensures the extension is loaded when GNOME Shell starts.

### Priority 2: Capture Missing Screenshots
1. Preferences dialog - open via `gnome-extensions prefs voice-to-text@happytomatoe.com`
2. Right-click context menu on indicator
3. Recording state (needs D-Bus service or mock)

### Priority 3: Complete PR
1. Update scripts with working xdotool coordinates
2. Capture all reference screenshots
3. Push final changes to PR #57

## Other Notes

### Container Management
- To start fresh: `podman stop voice-to-text-gnome-test 2>/dev/null; podman run --rm --cap-add=SYS_NICE --cap-add=IPC_LOCK -td voice-to-text-gnome-test`
- To access container: `podman exec voice-to-text-gnome-test set-env.sh <command>`

### Key Scripts
- `set-env.sh` - Sets DBUS_SESSION_BUS_ADDRESS and DISPLAY for user commands
- `wait-user-bus.sh` - Waits for user D-Bus session bus to be ready

### GNOME Shell Eval
To get extension state, need to use gdbus:
```bash
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "JS_CODE"
```
But this has connection issues when run via `set-env.sh` due to eval expansion.

### Extension Code Reference
- `gnome-ext/indicator.js:25-100` - UI building, indicator positioning
- `gnome-ext/extension.js:40-80` - D-Bus proxy setup, hotkey registration
- `gnome-ext/schemas/org.gnome.shell.extensions.voice-to-text.gschema.xml` - Settings (hotkey default: `<Super>w`)
