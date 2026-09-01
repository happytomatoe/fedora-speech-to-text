# TODO — e2e-ubuntu-ci

## Parity with real user interaction

- [ ] **Use real hotkey instead of D-Bus StartRecording/StopRecording calls.**
  Current `shell.sendHotkey()` (ported from e2e/lib/shell.ts) calls the
  extension's D-Bus methods directly — a human user presses
  Super+Space (or whatever the hotkey binding is) and the extension's
  hotkey handler fires. For true user parity the Ubuntu E2E suite should:
  1. Trigger the GNOME shortcut via `gsettings`/`xdotool`/`dotool key`
     (dotool is already installed in the VM) so the signal path is:
     real keypress → mutter → GNOME Shell keybinding → extension → D-Bus
     StartRecording — exactly what a user gets.
  2. Keep the D-Bus call path as an explicit fallback flag
     (`--dbus-hotkey`) for isolating failures (is it the keybinding or
     the pipeline?).
- [ ] Same for screenshots: prefer real user-visible paths over debug hooks
  where practical.

## Remaining port work

- [ ] Fix leftover double `DBUS_SESSION_BUS_ADDRESS` export in
  `e2e.ts` runTestFlow (screencast holder launch) — second export wins,
  first is dead code; delete one.
- [ ] `run.sshPort` mutation in `main()` for `--use-existing` is a hack
  (`(run as any).sshPort`) — make RunContext accept an explicit port.
- [ ] Verify `shell.dbusScreenshot` exists — captureScreenshot references it
  for the `--use-existing` path; ShellHelper only has startScreencast/
  stopScreencast today, need to add a Screenshot D-Bus wrapper.
- [ ] Add just recipes: `ubuntu-ci-e2e` (run suite, passthrough args),
  `ubuntu-ci-e2e-setup` (download pinned resolute cloud image, customize
  golden image, generate ssh key) — reuse/port `e2e-vm/setup-vm.sh`.
- [ ] First real run: `just ubuntu-ci-e2e -- --use-existing` against the
  running parity VM, then a fresh-mode boot to prove CI parity.
- [ ] CI workflow wiring (workflow that runs the suite on ubuntu-26.04
  runner with nested QEMU — image download + KVM availability check).
