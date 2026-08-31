# POC Plan: Headless GNOME Shell on GitHub Actions Runner

**Status:** In progress. Branch: `poc/headless-shell-screenshot-2`. PR: created from this branch.
**Goal:** Run a real GNOME Shell session directly on a GitHub-hosted runner
(no VM, no container, no KVM) and take a screenshot of the running desktop.
Foundation for a structural-assertion E2E suite (docs/e2e-ci-options.md, Option 3).

**Reference implementation:** CopyQ's extension test
(https://github.com/hluk/CopyQ/blob/master/utils/github/test-linux-gnome-extension.sh)
— apt-installs gnome-shell, boots it headless inside `dbus-run-session`, verifies via D-Bus.
All on plain `ubuntu-latest`. No VM.

## What exists (already committed on this branch)

- `.github/workflows/poc-headless-shell.yml`:
  1. apt: gnome-shell, gnome-shell-common, glib2.0-bin, dbus, xvfb, mesa libs
  2. isolated env (clean HOME/XDG dirs) + `dbus-run-session`
  3. `gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x720`
  4. Wayland socket wait (60s), screenshot via org.gnome.Shell.Screenshot D-Bus API
  5. artifact upload

## Debug log so far

| Run | Failure | Fix |
|---|---|---|
| 1 | `GLib-GIO-ERROR: No GSettings schemas installed` | tried installing schema packages — didn't help |
| 2 | same error | **root cause:** `env --ignore-environment` wipes `XDG_DATA_DIRS` → GIO finds no schema dirs. CopyQ hits the same and fixes it by compiling schemas into the isolated `$XDG_DATA_HOME/glib-2.0/schemas` with `glib-compile-schemas --targetdir=...` |
| 3 | fix committed: set `XDG_DATA_DIRS=$XDG_DATA_HOME:...:/usr/share` + compile schemas | **run pending** (was interrupted locally; next push triggers) |

## Remaining steps

1. **Verify run 3 goes green.** If schemas error persists, add explicit
   `GSETTINGS_SCHEMA_DIR` or compile `/usr/share/glib-2.0/schemas` in place.
2. **If gnome-shell crashes after schemas fix** (likely next: missing
   `gnome-session`-provided bits, dconf backend, or GL renderer issues):
   - add `GSETTINGS_BACKEND=keyfile` (CopyQ does this)
   - add `MESA_LOADER_DRIVER_OVERRIDE=swrast` / check llvmpipe present
   - capture `journalctl`/stderr to artifact for diagnosis
3. **Confirm screenshot artifact** is a real rendered frame (human check +
   `file` output, size > blank-frame threshold).
4. **Stretch (if time):** install our extension, enable via gsettings,
   poll `org.freedesktop.DBus.NameHasOwner` for our D-Bus name (CopyQ pattern),
   screenshot with the extension's indicator visible.

## Success criteria

- [ ] Workflow green on ubuntu-latest
- [ ] gnome-shell stays alive without GDM/logind
- [ ] Screenshot artifact shows a rendered GNOME Shell frame
- [ ] Total runtime < 5 min

## Explicitly out of scope

- Pixel-exact regression (Ubuntu rendering ≠ Fedora golden references)
- Audio/PipeWire/transcription path
- Parakeet, extension deployment via install.sh
