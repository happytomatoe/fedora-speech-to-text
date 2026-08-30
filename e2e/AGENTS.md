# E2E test environment notes

QEMU-based visual regression tests for the GNOME extension. Run via `just e2e` from repo root (logs to `/tmp/fedora-speech-to-text-e2e-run.log`).

## Snapshot & prefs-gate behavior

- `just e2e` restores the `ready` snapshot when present, otherwise deploys fresh and saves one. `--no-save-snapshot` opts out; `just e2e-snapshot` is an alias.
- Preferences screenshots are gated. `e2e.ts` computes a sha256 content hash of `PREFS_SOURCES` (prefs UI, schemas, config fixture, deploy pipeline, `install.sh`) and stores it in `e2e/output/.prefs-ui-hash` (gitignored).
  - Stored hash matches → skip screenshots (~50s run instead of ~90s).
  - Hash differs → run screenshots once, store new hash.
  - **First run in a worktree** (no hash file): decision comes from `git diff main...HEAD` + working-tree diff. Clean branch skips immediately.
- Changing prefs files? You only pay the screenshot run once after the change; do NOT bypass the gate. `--no-skip-prefs` / `just e2e-prefs` exist for explicit full runs.

## Adding files under prefs sources

New files inside `gnome-ext/prefs/`, `gnome-ext/schemas/`, etc. are picked up automatically by both the hash walk and the diff matcher — no list edit needed. Editing a top-level file in `PREFS_SOURCES` (e.g. `prefs.js`, `deploy-steps.ts`) also needs no edit. Only add to `PREFS_SOURCES` when a NEW source path outside the existing list affects the rendered prefs window.

## Gotchas

- Killing QEMU mid-run can break the overlay (dead backing file). If runs fail at boot, delete `e2e/qemu-images/persistent-run/main/overlay.qcow2` and re-run `just e2e`.
- The pre-push hook runs the full e2e suite; expect pushes to take ~2-3 min.
