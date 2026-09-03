# Local bare-runner E2E results (pre-CI baseline)

Harness: `.github/workflows/scripts/ci-e2e-headless.sh` (same script CI runs), branch `poc/ci-headless-e2e` @ `404ee9d`.
Environment: Fedora host, nested GNOME Shell (headless), Parakeet on `localhost:5092`, `/dev/uinput` present.
12 harness iterations; every fix committed individually. Latest full log: `/tmp/bare-e2e-verify.log`.

## Final local state (run 12)

| Suite | Row | Status | Notes |
|---|---|---|---|
| matrix (5 wav × mutter-commit) | 5 cells | ✅ PASS | typed text matches expected per case |
| matrix (5 wav × mutter-virtual) | 5 cells | ✅ PASS | |
| matrix (5 wav × type/dotool) | 5 cells | ✅ PASS | requires `/dev/uinput` + `DOTOOL_PIPE` |
| hotkey/ui | H01-H02 | ❌ FAIL | "no recording evidence in log" — dotool `super+w` press not observed by nested shell |
| hotkey/ui | P01 prefs-window-opens | ✅ PASS | via `OpenExtensionPrefs` D-Bus |
| config | C07 config-exists-parses | ✅ PASS | |
| config | C08 config-perms-600 | ✅ PASS | harness now writes 0600 |
| config | C01-C03 config-reload-restart | ✅ PASS | |
| error | E02 api-error-logged | ✅ PASS | patches `parakeet.http_endpoint` (provider section wins) |
| error | E06 service-down-clean-error | ❌ FAIL | probe still hits a live service; restart race not fully closed |
| deferred skips | H03-H05, P02/P03/P05/P06, C04-C06, E01/E03/E05/E07 | ⏭ SKIP | planned, reasons recorded in results.json |

**Totals: 20 PASS / 2 FAIL / 14 SKIP.**

## Fixes landed during local verification

- `535c4b7` staging excludes qcow2/node_modules/output/vm-run (6.2 GB tmpfs blowup)
- `395d9d7` reuse healthy Parakeet on :5092 (local port conflict)
- `e4d835a`/`30babe4`/`c64efc0` dotoold PATH + `DOTOOL_PIPE` — unblocked `type` method
- `2ffc291`/`380d4ed` E06 restore ordering, C08 chmod 600
- `2881ea4` E02 patches provider section (config precedence)
- `3fadf43` H01 hotkey matches schema default `<Super>w`
- `91f83b2` P01 via `OpenExtensionPrefs` D-Bus
- `d047861`/`87a73c8`/`404ee9d` E06 probe-before-restore + SIGKILL + bus-name-gone wait (still racing — open)

## Open items for CI focus

1. **E06 race** — probe must land while the bus name is genuinely absent; SIGTERM/SIGKILL + poll still lands on a live owner on some runs.
2. **H01-H02** — dotool `super+w` produces no recording evidence; needs mutter keybinding registration check in nested shell.
3. Both are matrix-independent; CI run should be treated as the primary signal for the 20 passing rows.
