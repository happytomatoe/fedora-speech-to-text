# E2E Sleep Elimination via AT-SPI + Observable Polls

## Overview

Replace fixed `Bun.sleep()` calls in the E2E test suite with observable polls (file existence, AT-SPI accessibility-tree state) and cut the prefs screenshot count from 5 to 3. Target: ~9-12s off the 112s baseline.

## Current State Analysis

**Baseline:** 112s wall-clock. Timing tree from last full run:
- restore-snapshot: 14.3s, deploy-extension: 19.9s, test-flow: 65.7s (of which preferences-screenshots: 32.1s), vm-shutdown: 6.6s

**Sleep inventory (verified, hot path only):**

| Location | Sleep | Purpose | Replace? |
|---|---|---|---|
| `e2e.ts:655` (`captureScreenshot`) | 500ms | "wait for file to be written" after `qemu.screendump` | ✅ HMP screendump is synchronous — `_execute()` waits for the `(qemu)` prompt before resolving. Poll file-exists as belt-and-suspenders |
| `e2e.ts:891` (`capturePrefs`) | 500ms | same pattern | ✅ same fix |
| `e2e.ts:872` | **3000ms** | wait for prefs window to appear after `gnome-extensions prefs &` | ✅ AT-SPI wait-for-window |
| `e2e.ts:879-986` | 8 × 300-1000ms | settle after each dotool click/scroll before screendump | ✅ AT-SPI state polls (see Approach) — frame-diff only as fallback |
| `e2e.ts:1217` | 20s | shutdown watchdog | ⚠️ keep — safety net, never on happy path |
| `lib/shell.ts:163-326` | ~10 × 100-500ms | dotool settle waits | ⚠️ out of scope this pass (follow-up) |

**Key discoveries:**
- `QemuMonitor._execute()` (`lib/qemu.ts:150`) is request/response — command completion is guaranteed at resolve time. The 500ms screendump sleeps are pure paranoia.
- AT-SPI needs **no VM preparation**: `at-spi2-core` is stock Fedora, the bus DBus-auto-activates on the session bus (`org.a11y.Bus` → `at-spi-bus-launcher` → `atspi2-registryd`), and the test already exports `XDG_RUNTIME_DIR=/run/user/$(id -u)` in every `deployer.exec` (e2e.ts:867+). Verified on host Fedora 44: bus auto-runs, `python3-gobject` provides `gi.repository.Atspi` bindings.
- Existing extension names (checked): `indicator.js:25` "Voice to Text", `indicator.js:95` "Preferences", `audio-level-widget.js:61` "Cancel recording". Prefs widgets (`prefs/custom-words-row.js`, `hotkey-row.js`, `prefs.js`) set none — but GTK **auto-derives** AT-SPI names from `label:`/`title:`, so the tree exposes "Add Word…" (Unicode ellipsis, `custom-words-row.js:92`), "Add", "Cancel", "Enter a word or phrase:" for free. Explicit `accessible_name` needed only where Gtk can't derive one (verify against live tree during dev).
- AT-SPI replaces dotool for clicks and typing (Phase 2): buttons via `doAction("press")`, "type E2E" via `Text.SetTextContents` on the entry — no coordinates, no key synthesis. Fallbacks: `findAtspiExtents` + dotool click for actionless widgets; dotool type if entry blocks a11y text writes.
- dotool **stays** for: `wheel` scroll (no AT-SPI scroll API; single invocation with 3-screenshot plan) and `key Escape`/`key alt+F4` (no global key injection on Wayland for external clients).
- Intermediate scroll screenshots (`prefs-scrolled-1/2`) are redundant coverage (bottom capture shows everything they show) and the flakiest references — half-scrolled states depend on scroll physics.
- **⚠️ GTK4 a11y gating (verify first):** stock GNOME ships `toolkit-accessibility = false`; GTK4 apps may not register their tree on the a11y bus until `gsettings set org.gnome.desktop.interface toolkit-accessibility true` is set, and registration happens at app startup (enable before launching prefs). If live tree comes back empty, this is why. (Source: gtk-a11y-mcp docs; confirmed pattern for GTK4/AT-SPI.)
- Prior work on this branch: `cache=unsafe` (`90355db`), pane-poll focus check (`ea89ae0`), dotool-install-parallel (`ba41019`, orthogonal).

## Desired End State

- All hot-path fixed sleeps in `runPreferencesTests` and both capture helpers replaced with polls that exit as soon as the observable is true.
- Accessibility names verified/added in `gnome-ext/prefs/` so the tree exposes stable semantic names for polling.
- Prefs screenshots reduced 5 → 3: `prefs-main` (top), `prefs-bottom` (single `wheel -50` scroll to page end), `prefs-after-add`.
- One measured E2E run shows per-span improvement vs baseline; `preferences-screenshots` span drops from 32.1s to ~20-24s.

### Verification
- `grep -c "Bun.sleep" e2e/e2e.ts`: no sleeps left in `runPreferencesTests` or `capturePrefs`/`captureScreenshot` (watchdog at 1217 exempt).
- Full `just e2e` run passes; timing tree shows preferences-screenshots span reduced ≥ 8s vs baseline.
- `lib/atspi.ts` queries return expected element names ("Add Word…", "Add") from a running VM's tree.
- Exactly 3 prefs screenshots produced; reference-copy list (`e2e.ts:798`) matches; two retired reference PNGs removed.

## What We're NOT Doing

- Offline/qemu-nbd deploy of extension or Python service (deploy is part of what's tested)
- Snapshot-baking the extension (tests must always exercise current code)
- Eliminating the GDM restart (GNOME 50 Wayland has no programmatic reload; confirmed by research)
- Parallel VMs (matrix-only win, not single-run)
- `lib/shell.ts` dotool settle sleeps (follow-up pass)
- Watchdog/backoff sleeps (safety, not latency)
- Resizing the prefs window / full-window-no-scroll capture (AT-SPI can't take screenshots — pixels are the compositor's job; single-scroll-to-bottom achieves the coverage instead)

## Post-plan follow-ups (researched, deferred)

- **QEMU fast snapshot load:** upstream merged lazy-RAM-load for `mapped-ram` snapshots (userfaultfd page faults on demand) — restore resumes near-instantly instead of blocking on full RAM image. Our restore-snapshot span is 14.3s; likely the biggest remaining win. Requires recent QEMU + mapped-ram migration wiring (not savevm/loadvm). Spike separately after Phase 3.
- **dogtail** (Python AT-SPI test framework) could replace the hand-rolled tree walk if predicate count grows beyond ~10; skipped now (extra VM dep, 4 simple queries).
- **GNOME's own CI approach** (shell in container + mocked D-Bus services, per gnome-shell blog) is the no-VM end of the spectrum — big infra rewrite, out of scope.

## Implementation Approach

Three independent changes, bundled into one measured E2E run. AT-SPI interaction goes through `deployer.exec` running short inline Python heredocs — no new VM-side daemon. Element location → read extents → dotool click at real coordinates (reuses existing input path; avoids depending on widgets exposing AT-SPI `doAction`).

**AT-SPI is a D-Bus protocol** — Python/PyGObject is only our client (alternatives: GJS `imports.gi.Atspi`, raw `busctl` on `org.a11y.Bus`; not used). 

**State polls, not frame-diff:** after each interaction, poll the tree for the expected *semantic* state:

| Interaction | AT-SPI state polled |
|---|---|
| Launch prefs window | window node for the extension exists |
| Click terminal to focus (0.5,0.5 click) | `Component.grabFocus()` on terminal window node + poll `ACTIVE` state — no mouse |
| Click "Add Word…" row | dialog with "Enter a word or phrase:" entry exists |
| Type "E2E" | entry's text value == "E2E" (AT-SPI exposes text content) |
| Click "Add" | custom words list contains row "E2E" |
| Scroll to bottom | known bottom row's `Showing` state == true |

Frame-diff (screendump bytes differ from previous) kept only as documented fallback for states AT-SPI doesn't expose.

**Why polling over event listeners:** listeners would fire instantly but need a resident Python process on the VM holding the listener across interactions. Polling keeps every check a stateless one-shot SSH exec. Upgrade path if query count grows: resident script reading commands from stdin (amortizes python startup to ~10-50ms/query).

## Phase 1: Screendump poll (safest, biggest ratio)

### Overview
Replace both 500ms post-screendump sleeps with an exists-and-nonempty poll.

### Changes Required

#### 1. `e2e.ts:655` captureScreenshot
```ts
await pollFileExists(ppmPath, 2000);
```
#### 2. `e2e.ts:891` capturePrefs
Same helper. Add helper in `lib/poll.ts`:
```ts
export async function pollFileExists(path: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!existsSync(path) || statSync(path).size === 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`file never appeared: ${path}`);
    await Bun.sleep(25);
  }
}
```
Happy path: first check passes, ~0ms spent.

### Success Criteria

#### Automated Verification:
- [ ] `bunx tsc --noEmit`: no new errors in touched files
- [ ] One E2E run: all screenshots produced, zero `file never appeared` errors
- [ ] Per-span timing: capture-related spans reduced ~0.4s × 6+ captures

#### Manual Verification:
- [ ] Eyeball 2-3 screenshots for correct content (not truncated/black)

## Phase 2: AT-SPI prefs rework + screenshot reduction

### Overview
AT-SPI replaces the 3000ms window wait, all coordinate clicks, and all settle sleeps. Screenshot count 5 → 3.

### Changes Required

#### 1. Accessibility names prep (`gnome-ext/prefs/`)
- Query live tree during dev; confirm auto-derived names for "Add Word…", "Add", "Enter a word or phrase:"
- Add explicit `set_accessible_name()` only for widgets Gtk can't auto-name (likely custom-words rows); keep names stable E2E-facing strings

#### 2. New TS helper: `lib/atspi.ts`
```ts
export async function waitForAtspiState(deployer, predicate: string, timeoutMs: number): Promise<string>
// polls: deployer.exec("python3 - <<'PY' ...tree walk, eval predicate, print result PY")
// predicate e.g. 'window named ~Voice to Text~ exists' — returns match info or throws on timeout
export async function findAtspiExtents(deployer, namePattern: string): Promise<{x,y,width,height}>
```
Poll interval 250ms (SSH round-trip dominates; don't pile up queries).

#### 3. `runPreferencesTests` rework (`e2e.ts:860-990`)
- 3000ms → `waitForAtspiState(...window exists..., 10000)`
- Each `mouseto <fraction>` click → `doAction("press")` on the button node (fallback: `findAtspiExtents` + dotool click if no press action)
- `type E2E` → `Text.SetTextContents("E2E")` on the entry node (fallback: click via extents + dotool type)
- Each settle sleep → `waitForAtspiState` per the state table (Approach section)
- Screenshots: keep `prefs-main`; **drop `prefs-scrolled-1/2`**; single `wheel -50` → `prefs-bottom` (replaces scrolled-3); keep `prefs-after-add`
- Update `prefsNames` (`e2e.ts:798`) to `["prefs-main", "prefs-bottom", "prefs-after-add"]`; `git rm` the two retired reference PNGs
- Keep Escape-key and alt+F4 paths

#### 4. Skill documentation
New section in `.agents/skills/atspi-nested-shell/SKILL.md`: querying the **E2E VM's** tree over SSH (vs host-side nested shell), XDG_RUNTIME_DIR/session-bus specifics, pointer to `lib/atspi.ts`.

### Success Criteria

#### Automated Verification:
- [ ] `bunx tsc --noEmit`: no new errors
- [ ] `just gnome-ext-check` passes
- [ ] Exactly 3 prefs PNGs in output dir; `compareWithReference` passes for all 3
- [ ] No `mouseto 0.` coordinate literals remain in `runPreferencesTests`
- [ ] No `Bun.sleep` in prefs flow (except watchdog)

#### Manual Verification:
- [ ] Live tree query shows expected names before wiring predicates (dev-time sanity)
- [ ] prefs-after-add screenshot shows "E2E" row added

## Phase 3: Measured validation

### Overview
Single E2E run, per-span comparison vs baseline.

### Success Criteria

#### Automated Verification:
- [ ] `just e2e` green (exit 0, transcription verified, screenshots captured)
- [ ] Timing table committed: baseline vs new, per-span
- [ ] If regression in any span: revert that phase's commit, re-measure, record result

## Testing Strategy

### Automated
- `just gnome-ext-check`, `bunx tsc --noEmit` for type/lint sanity
- Full `just e2e` as the acceptance gate (it *is* the test suite)

### Manual
- Live-tree query against running VM during dev (confirm names before wiring predicates)
- Eyeball the 3 prefs screenshots (top/bottom content, Add-Word dialog state)

## Performance Considerations

- AT-SPI tree walks over SSH cost ~200-500ms per query (python startup + D-Bus). Query budget: 1 window-wait + ~4 state/extent queries — not one per interaction.
- Frame-diff fallback costs one screendump per iteration — cap at 2s.
- Poll intervals: 25ms local file checks, 250ms SSH-round-trip polls. Interval matches check cost.

## Risks

- AT-SPI tree may be **empty entirely** if GTK4 a11y gating applies (see ⚠️ above): enable `toolkit-accessibility` before prefs launch; verify tree non-empty as first dev step of Phase 2.
- VM image may lack `python3-gobject` (near-certain present — gnome-shell runtime dep). Fallback: raw `busctl` calls on `org.a11y.Bus`.
- Widget names may differ from expected ("Add Word..." vs "Add Word…"): ellipsis char, translation, version drift. Predicates use regex; confirm against live tree first.
- AT-SPI may not expose `Showing` on the bottom row if the widget tree nests it deeper than expected — fallback: poll text value of last visible entry.

## References

- Baseline timing: session notes 2026-08-30 (112s tree)
- Host-side AT-SPI pattern: `.agents/skills/atspi-nested-shell/scripts/atspi-query.sh`
- Synchronous screendump: `e2e/lib/qemu.ts:150` (`_execute` request/response)
- Extension names today: `gnome-ext/indicator.js:25,95`, `gnome-ext/prefs/custom-words-row.js:92,118,134,136`
- Reference-copy list to update: `e2e/e2e.ts:798`
- Prior plan style: `thoughts/shared/plans/e2e-runtime-under-40s.md`
