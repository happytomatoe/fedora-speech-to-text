# Headless CI E2E — Status

Status: **green on CI (ubuntu-ci-e2e.yml, bare-runner headless harness, 4-step
workflow) + local parity via Ubuntu 26.04 VM**

> **2026-09-02 update — VM-in-CI abandoned, bare-runner restored.** The
> QEMU-VM-in-CI experiment (`e2e/setup-ubuntu-vm.sh` + `--env ubuntu-ci`)
> never went green: it failed repeatedly at `wait-ssh` (run 33661390006) —
> the guest reached cloud-init completion, but the host never completed an
> SSH handshake. The diagnosis plan lives in
> `thoughts/shared/plans/fix-ubuntu-ci-wait-ssh.md`. Decision: CI now runs
> the proven bare-runner headless harness (below); the VM path remains
> available locally via `just ubuntu-vm-test` for parity reproduction.

> **2026-09-04 update — 4-step workflow + prefs flow green.** The harness
> split into four workflow steps (stage/boot/run/teardown) with a persistent
> dbus session exported via `GITHUB_ENV`. The preferences flow works headless
> via the service→extension `OpenPrefs` signal path, and the terminal flow is
> unified with local: ghostty+tmux runs on the runner, typed text is visible
> in pane screenshots. Latest green: run
> [33852246510](https://github.com/happytomatoe/fedora-speech-to-text/actions/runs/33852246510)
> (PR #157).

## Goal

Run the voice-to-text extension E2E test without a display: boot a real
headless GNOME Shell 50 on Ubuntu 26.04, deploy the real extension + Python
D-Bus service + Parakeet, drive one recording through D-Bus, and assert the
transcribed text reaches the extension. The same harness runs on CI and
locally, so CI failures can be reproduced with one command.

## Architecture

```
.github/workflows/ubuntu-ci-e2e.yml                  (canonical CI workflow)
├── .github/workflows/scripts/ci-e2e-stage.sh        (isolated HOME via mktemp,
│                                                     dbus-run-session, GITHUB_ENV)
├── .github/workflows/scripts/ci-e2e-boot.sh         (schemas, extension deploy,
│                                                     ghostty+tmux, shell boot,
│                                                     before-screenshot, screencast)
├── .github/workflows/scripts/ci-e2e-run.sh          (e2e/e2e.ts --env ubuntu-bare)
└── .github/workflows/scripts/ci-e2e-teardown.sh     (artifact rescue, per-cell
                                                      ffmpeg clips, suite exit code)
```

Local parity runs the SAME flow inside an Ubuntu 26.04 QEMU VM:

```
just ubuntu-vm-test        # boot (headless) → Parakeet → run → stop
just ubuntu-vm-test GUI=1  # same, with a visible Ubuntu desktop window
```

- Stage script creates an isolated `mktemp -d` tree (HOME/XDG pointed there)
  and a fresh session bus; both are exported to later steps via `GITHUB_ENV`.
- Boot script compiles GSettings schemas, deploys the real extension plus a
  tiny `poc-screenshot@local` extension that sets
  `global.context.unsafe_mode` from inside the shell (required for the
  outside-shell Screenshot call), spawns ghostty+tmux (visible typed text),
  writes service config, boots `gnome-shell --headless --wayland`, waits for
  the Wayland socket and the `com.happytomatoe.VoiceToText` bus name, and
  takes the before-screenshot.
- Run script executes the ported suite (`e2e/e2e.ts --env ubuntu-bare`, bun,
  LocalTransport over the dbus-run-session env). The matrix
  (`test-cases/` × output-methods) drives one cell per case; `--case` filters
  for dispatch runs. Cells assert typed text via the log window + capture
  file; the prefs block opens the dialog through the service's `OpenPrefs`
  D-Bus method (service emits `OpenPrefsRequested`; the in-shell extension
  calls `Main.extensionManager.openExtensionPrefs()` — no CLI, no D-Bus
  activation of `org.gnome.Shell.Extensions`, which never appears on a
  headless bus).
- Teardown runs with `if: always()`: kills the screencast holder, rescues
  results.json/logs/screenshots, splits `recording.webm` into per-cell clips
  using each cell's window.txt timestamps, and exits with the suite's saved
  exit code.

## Current state (all done)

- [x] 4-step workflow; green on CI (ubuntu-26.04 runner, GNOME 50.1)
- [x] Parakeet via prewarmed local server path (Moonshine default provider;
      Parakeet selectable via `VOX_CI_E2E_PROVIDER`)
- [x] gnome-shell headless boots (Wayland socket in 3–6 s)
- [x] Extension deploys, loads, and renders (mic indicator visible in top bar)
- [x] ghostty+tmux terminal on the runner; typed text visibly committed in
      the pane (after-screenshot)
- [x] Three-state screenshots: before (desktop), during (recording widget +
      audio-level bars), after (typed text in terminal)
- [x] Prefs P01–P03 pass headless via the OpenPrefsRequested signal path;
      prefs-open/prefs-end screenshot pair in artifacts
- [x] Per-cell artifacts: `output/cells/<cell>/` (after.png, clip.webm,
      service.log slice, window.txt)
- [x] Service restart/recovery (C01–C03) resilient: setsid + stdio detach so
      LocalTransport pipes never hang

## Known constraints / lessons

- `env --ignore-environment` in the outer script: only pass exactly the vars
  the inner steps need (a dropped `WIDTH`/`HEIGHT` cost one run).
- GITHUB_ENV is the only channel for values a later workflow *step* needs
  (e.g. `SCREENCAST_START_EPOCH` for teardown's ffmpeg splitting).
- Parakeet image bakes models into `/models`; never volume-mount it.
- `enabled-extensions` is a single GVariant string: `['uuid-a', 'uuid-b']`.
- `org.gnome.Shell.Extensions` never appears on a headless session bus —
  prefs must be opened from inside the shell (openExtensionPrefs), not via
  D-Bus activation or the gnome-extensions CLI (which exits 2 silently).
- `Main.extensionManager.openExtensionPrefs()` is the shell-side API;
  extension objects themselves do not expose `openPreferences()`.
- Every `bash -n` before pushing; scripts run under `set -euo pipefail` and
  unbound variables have killed teardown twice (AFTER_SHOT, RUN_START).
- VM parity: Ubuntu 26.04 cloud images ship no SSH host keys — generate them
  (`ssh-keygen -A`) and mask `ssh.socket` (26.04's ssh.service requires it).
