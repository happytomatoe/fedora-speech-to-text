# POC Plan: Headless GNOME Shell on GitHub Actions Runner

**Goal:** Prove we can run a real GNOME Shell session directly on a GitHub-hosted
runner (no VM, no container) and take a screenshot of the running desktop.
This is the foundation for a future structural-assertion E2E suite
(see `docs/e2e-ci-options.md`, Option 3).

**Reference implementation:** CopyQ's extension test
(https://github.com/hluk/CopyQ/blob/master/utils/github/test-linux-gnome-extension.sh)
— installs gnome-shell via apt, boots it headless in a `dbus-run-session`,
verifies via D-Bus. All on plain `ubuntu-latest`.

## Steps

### 1. Workflow: `.github/workflows/poc-headless-shell.yml`
- Trigger: `workflow_dispatch` + `pull_request` (paths: this workflow + plan file,
  so it runs on this PR but doesn't slow every future PR).
- `runs-on: ubuntu-latest`, timeout 15 min.
- Steps:
  1. Install `gnome-shell gnome-shell-common glib2.0-bin dbus xvfb` via apt
     (no VM, no QEMU, no KVM needed).
  2. Create an isolated environment (clean `$HOME`, `XDG_*` dirs) and enter
     `dbus-run-session`.
  3. Launch `gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x720`.
  4. Wait for the Wayland socket to appear (poll up to 60s).
  5. Verify gnome-shell process is alive and owns a D-Bus name.
  6. Take a screenshot of the running desktop.
  7. Upload screenshot + logs as workflow artifacts.

### 2. Screenshot method
Primary: GNOME Shell's D-Bus screenshot API:
```
gdbus call --session \
  --dest org.gnome.Shell.Screenshot \
  --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot \
  true false /tmp/poc-screenshot.png
```
Fallback (if the API is locked down in headless mode): read the virtual
monitor framebuffer, or `gnome-screenshot` / PipeWire ScreenCast.

### 3. Success criteria
- [ ] Workflow runs green on GitHub-hosted runner
- [ ] gnome-shell boots headless without GDM/logind
- [ ] Screenshot artifact contains a rendered GNOME Shell frame
      (verified by human inspection + file size > blank-frame threshold)
- [ ] Total runtime < 5 min

### 4. What this POC does NOT cover (future work)
- Extension install/enable + D-Bus interaction (CopyQ shows the pattern)
- PipeWire/audio bootstrap for the transcription flow
- Pixel-exact visual regression (impossible on Ubuntu runner; structural
  assertions only)
- Parakeet transcription inside the runner

## Risks
- gnome-shell may require packages beyond the three above (mesa/llvmpipe deps) —
  apt will pull them; watch for missing `libgbm`.
- The Screenshot D-Bus API may be restricted (`--unsafe-mode` needed in some
  versions) — fallback documented above.
- ubuntu-latest has no `gnome-session`; we launch gnome-shell directly, which
  CopyQ proves works.
