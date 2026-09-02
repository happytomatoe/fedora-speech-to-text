# Headless CI E2E — Status

Status: **green on CI (ubuntu-ci-e2e.yml, bare-runner headless harness) + local parity via Ubuntu 26.04 VM**

> **2026-09-02 update — VM-in-CI abandoned, bare-runner restored.** The
> QEMU-VM-in-CI experiment (`e2e/setup-ubuntu-vm.sh` + `--env ubuntu-ci`)
> never went green: it failed repeatedly at `wait-ssh` (run 33661390006) —
> the guest reached cloud-init completion, but the host never completed an
> SSH handshake. The diagnosis plan lives in
> `thoughts/shared/plans/fix-ubuntu-ci-wait-ssh.md`. Decision: CI now runs
> the proven bare-runner headless harness (below); the VM path remains
> available locally via `just ubuntu-vm-test` for parity reproduction.

## Goal

Run the voice-to-text extension E2E test without a display: boot a real
headless GNOME Shell 50 on Ubuntu 26.04, deploy the real extension + Python
D-Bus service + Parakeet, drive one recording through D-Bus, and assert the
transcribed text reaches the extension. The same harness runs on CI and
locally, so CI failures can be reproduced with one command.

## Architecture

```
.github/workflows/ubuntu-ci-e2e.yml             (canonical CI workflow)
└── .github/workflows/scripts/ci-e2e-headless.sh        (outer: isolation env,
    │                              Parakeet container, dbus-run-session)
    └── .github/workflows/scripts/ci-e2e-headless-inner.sh  (inner: schemas,
        │                          extension deploy, shell boot, waits)
        └── ci-e2e/e2e.ts       (bun test runner: gdbus drive + assert)
```

Local parity runs the SAME harness inside an Ubuntu 26.04 QEMU VM:

```
just ubuntu-vm-test        # boot (headless) → Parakeet → run → stop
just ubuntu-vm-test GUI=1  # same, with a visible Ubuntu desktop window
```

- Outer script stages the repo into an isolated `mktemp -d` tree (HOME/XDG
  pointed there), expects Parakeet healthy on localhost:5092, then runs the
  inner script inside `dbus-run-session`.
- Inner script compiles GSettings schemas, deploys the real extension plus a
  tiny `poc-screenshot@local` extension that sets
  `global.context.unsafe_mode` from inside the shell (required for the
  outside-shell Screenshot call), writes service config, boots
  `gnome-shell --headless --wayland`, waits for the Wayland socket and the
  `com.happytomatoe.VoiceToText` bus name.
- Test runner (`ci-e2e/e2e.ts`, bun, zero D-Bus deps — `gdbus` subprocess +
  `gdbus monitor`): calls `StartRecording` with debug-WAV mode
  (`VOICE_TO_TEXT_DEBUG_FILE`), polls the typed-text capture file
  (`VOX_CI_E2E_TEXT_FILE`), asserts results, exits nonzero on failure.
- Debug mode transcribes `ci-e2e/fixture.wav` (test-03-hello.wav, 2.76 s,
  "Good morning.") through the real Parakeet HTTP endpoint on localhost:5092.
- In the VM, Parakeet runs on the host; a socat relay forwards the VM's
  localhost:5092 to the host via the QEMU gateway (10.0.2.2). See
  `e2e-vm/run-parity.sh`.

## Current state (all done)

- [x] Harness + bun test runner; green on CI (ubuntu-26.04 runner, GNOME 50.1)
- [x] Parakeet container boots, health-checks in ~6 s
- [x] gnome-shell headless boots (Wayland socket in 3–6 s)
- [x] Extension deploys, loads, and renders (indicator visible in top bar)
- [x] Service starts; D-Bus StartRecording driven from the test runner
- [x] Transcription flows: Parakeet returns "Good morning."
- [x] Screenshot permission via `poc-screenshot@local` (unsafe_mode)
- [x] Local Ubuntu 26.04 VM parity: `just ubuntu-vm-test` exit 0, full
      transcription assertion PASS, screenshot shows desktop + mic indicator
- [x] knip: `ci-e2e/e2e.ts` registered as an entry point

## Known constraints / lessons

- `env --ignore-environment` in the outer script: only pass exactly the vars
  the inner script needs (a dropped `WIDTH`/`HEIGHT` cost one run).
- Parakeet image bakes models into `/models`; never volume-mount it.
- `enabled-extensions` is a single GVariant string: `['uuid-a', 'uuid-b']`.
- Inner/outer split exists because of quoting constraints; keep edits
  `bash -n`-checked before pushing.
- VM parity: Ubuntu 26.04 cloud images ship no SSH host keys — generate them
  (`ssh-keygen -A`) and mask `ssh.socket` (26.04's ssh.service requires it).
