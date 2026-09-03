# Finish CI Headless E2E Implementation Plan

## Overview

Complete the `poc/ci-headless-e2e` PR (#157): stabilize the single-test CI run to fully green, verify the caching wins, unify the CI and local E2E flows on ghostty + tmux, and wrap the PR for merge. All work lands in this PR.

## Current State Analysis

- Workflow runs as 4 steps (stage / boot / run / teardown) with a persistent dbus session across steps via `GITHUB_ENV` (`.github/workflows/scripts/ci-e2e-{stage,boot,run,teardown}.sh`)
- Bare mode cells are matrix-driven: `e2e/fixtures/test-cases.json` entries carry `output-method`; `--case` runs exactly one file+method cell (commit ab0a45e)
- `awalsh128/cache-apt-pkgs-action` caches installed apt state (commit 8522e63); first run populates, subsequent runs restore. PulseAudio postinst state recreated manually (commit af1f3ea)
- Moonshine model cached at `/home/runner/moonshine-model` via `MOONSHINE_VOICE_CACHE` (commit 7db7397)
- Known flake: prefs P01-P03 fail in the first suite phase (AT-SPI frame lookup timeout) while the identical P01 check passes in the later hotkey phase — timing/ordering, not a product bug
- Notification banners (unsafe-mode warning) suppressed via `gsettings set org.gnome.desktop.notifications show-banners false` in boot — unverified in a run
- CI and local flows differ: local uses ghostty+tmux with dotool typing and `capture-pane` verification; CI has no terminal and verifies via capture files

## Desired End State

- `gh workflow run ubuntu-ci-e2e -f cases=test-01` completes green (transcription cell + prefs + config + error rows), ~2 min wall clock, with screenshots and per-cell artifacts in the upload
- Apt install step ~10-15s on cache hits; total setup under ~1.5 min
- CI bare mode and local VM mode share the same verification shape: ghostty+tmux terminal, dotool/AT-SPI typing, `tmux capture-pane` as primary text check
- PR #157 description reflects final evidence + timings; review threads resolved; docs updated

### Key Discoveries

- dconf never persists under the split workflow's bare `dbus-daemon` — `GSETTINGS_BACKEND=keyfile` is required or extensions silently don't enable (commit 8388ba3)
- Cached apt installs skip postinst: group membership, runtime dirs, and ldconfig/fontconfig triggers must be recreated manually
- The suite's per-cell poll waits the full 90s window; single-cell runs mask this, full-matrix runs would not — early-exit on match is the fix if matrix runs return
- `e2e/lib/deploy-steps.ts` provisioning is local-VM only (`main()` returns before VM setup for `ubuntu-bare`); its installs are hard requirements there

## What We're NOT Doing

- Container-image CI (rejected: ~15-25s extra saving over the apt action does not justify setup/maintenance cost)
- Parallel test execution / VM fan-out (deferred; matrix hardware exists in `test-matrix.json` for later)
- SSH key rotation (in git history; user action, out of PR scope)
- Full-matrix (15-cell) CI runs — single-test dispatch covers verification; matrix cost analysis is follow-up

## Implementation Approach

Fix and verify incrementally against `cases=test-01` runs (each ~4 min on CI), keeping every fix a separate commit so failures bisect cleanly. Then the ghostty unification as the last functional change, since it touches both boot script and suite.

## Phase 1: Stabilize green single-test run

### Overview

Get `test-01` fully green including P01-P03, with clean screenshots.

### Changes Required

1. `e2e/e2e.ts` (first-phase prefs block, ~line 1215)
   - Retry the P01 AT-SPI frame lookup once with a short delay, or extend `waitForAtspiNode` timeout for the first lookup only (the later identical lookup passes, so a one-shot retry suffices)

2. Verify (no code): notification suppression (`show-banners false`) keeps the unsafe-mode banner out of `after.png`

### Success Criteria

#### Automated Verification
- [ ] `gh workflow run ubuntu-ci-e2e -f cases=test-01` → conclusion success
- [ ] `results.json`: transcription cell pass, P01/P02/P03 pass, E02 pass
- [ ] Artifact contains before.png + after.png + per-cell after.png, no notification banner in the image

## Phase 2: Verify caches pay off

### Overview

Confirm the two caches hit and record real numbers.

### Changes Required

None (measurement only). If apt cache misses repeatedly, check the `version` bump semantics of cache-apt-pkgs-action.

### Success Criteria

#### Automated Verification
- [ ] Back-to-back run: "Install GNOME Shell + harness dependencies" step ≤ 20s
- [ ] Boot step shows Moonshine model loaded from `/home/runner/moonshine-model` with no download
- [ ] Timing table recorded in PR description

## Phase 3: Unify CI + local flows on ghostty + tmux

### Overview

Same verification shape everywhere: terminal window on the headless desktop, text lands visibly, `tmux capture-pane` reads it back.

### Changes Required

1. `.github/workflows/ubuntu-ci-e2e.yml` — add `ghostty` to the cached packages list
2. `.github/workflows/scripts/ci-e2e-boot.sh` — make the ghostty+tmux block unconditional; focus via `Atspi.generate_mouse_event` (python3-gi already installed) instead of dotool, so no uinput dependency
3. `e2e/e2e.ts` bare mode — after each transcription, read `tmux capture-pane -t ci-e2e -p` as the primary typed-text check; keep capture-file + shell-log grep as secondary evidence
4. `e2e/lib/deploy-steps.ts` — no change (already requires ghostty+tmux on local)

### Success Criteria

#### Automated Verification
- [ ] `test-01` run green with the cell's `after.png` showing the typed text inside a ghostty terminal
- [ ] Local flow unchanged: existing VM e2e recipes still pass (`just e2e-fedora-local` smoke)

#### Manual Verification
- [ ] Visual check of after.png: panel indicator + terminal + typed text

## Phase 4: PR wrap-up

### Overview

Make #157 merge-ready.

### Changes Required

- PR description: replace stale evidence table (Parakeet references, old script names) with current architecture (4 steps, matrix cells, caches) + timing table
- `docs/CI-E2E-STATUS.md`: refresh for the new flow (LOCAL-RESULTS.md was removed)
- Resolve open review threads (cubic) on latest commits
- Commit this plan file
- `complete_goal` with artifact-verified evidence

### Success Criteria

- [ ] Zero unresolved review threads
- [ ] CI green on HEAD
- [ ] Docs match reality

## Testing Strategy

- Every fix: one `cases=test-01` dispatch, artifact inspection (results.json + PNGs)
- Phase 3 additionally: local VM smoke run to prove the shared flow didn't regress local
- Full-matrix run once at the end (all 5 cases) as the final evidence run — acceptable at ~15 × 90s poll worst case only if poll early-exit lands; otherwise keep single-case evidence

## References

- Prior plan: `thoughts/shared/plans/wire-unified-e2e-to-ci-matrix.md`
- Workflow: `.github/workflows/ubuntu-ci-e2e.yml`
- Suite: `e2e/e2e.ts` (`runBareMode`)
- PR: https://github.com/happytomatoe/fedora-speech-to-text/pull/157
