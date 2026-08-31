# Handoff: openQA POC — audio-file test blocked on qcow2/btrfs COW layering bug

**Date**: 2026-08-31
**Branch**: `feat/openqa`
**Last working commit**: `cba41bd fix(openqa): bake GDM custom.conf for true autologin`

## Objective

Run the openQA POC (`e2e/openqa-poc/tests/transcribe.pm`) on the host machine
(no podman) to boot `golden-gnome-deps.qcow2`, auto-login as `testuser`, and
reach the GNOME desktop. The test then checks for a baked audio file and (in
later phases) is supposed to exercise the voice-to-text pipeline.

End state (verification contract): `result-transcribe.json` says `"result": "ok"`.

## Progress

Phases 1-3 of the test pass consistently (in ~230 s of the 300 s timeout):

1. **GDM comes up** — `wait_serial 'localhost login:'` matches.
2. **Auto-login as testuser** — dconf + GDM custom.conf baked into the image
   suppress the greeter and land directly on the desktop. Both `login-screen`
   and `desktop` needles handled.
3. **GNOME welcome tour dismissed** — the balloon needle is in
   `needles/welcome-tour.json`; the test clicks "Skip" via `type_string`
   followed by `send_key 'tab', 'ret'`.
4. **Baked-marker check** passes — `/var/tmp/voice-bake-src/.baked-marker`
   is visible to the SUT (uid 1000, gid 1000, mode 0644).

The test then dies at step 78 (line 78 of `tests/transcribe.pm`):

```perl
assert_script_run "test -s ${audio_file}", 5;
```

with exit code 1. `find / -name test-audio.wav` from the SUT returns nothing.

## Blocker — root cause

**The qcow2 COW overlay does not properly layer a btrfs filesystem on top of
the golden image.** The SUT sees a frozen snapshot of the base's btrfs state
from when the overlay was first created, ignoring any writes made to the base
image after that point.

### Evidence

| Where | `/opt` mtime | Notes |
| --- | --- | --- |
| Base image (`golden-gnome-deps-autologin.qcow2`) | Aug 30 (after upload) | `guestfish -i stat /opt` |
| Overlay qcow2 (with backing chain visible) | **Jan 16 2025** | `guestfish -a overlay -a base` |
| SUT (running) | **Jan 16 2025** | `ls -la /opt` via `assert_script_run` |

The SUT's `findmnt -T /` correctly shows `/dev/vda4[/root]` (btrfs default
subvol = `@root`, id 256). The btrfs UUID matches the base. The btrfs
generation is not advancing with the base image.

### Other things ruled out

- **btrfs subvol default mismatch (not the root cause)**: btrfs default
  subvol is `@home` (id 257), so `virt-customize --upload` lands in the
  wrong subvol. Worked around by using `guestfish` with
  `mount btrfsvol:/dev/sda4/root /` + `upload` — file is verified present in
  `@root` of the base image. SUT still doesn't see it.
- **btrfs subvol `[/root]` permissions**: SUT can `stat /opt` fine; only
  the file content is invisible.
- **SELinux**: `virt-customize` runs `SELinux relabelling` and the file
  shows correct uid/gid/mode (1000:1000, 0644). SUT's `ls -la /opt` shows
  it as `root:root 0755` (the original dir).
- **Overlay too small**: the default overlay was 5 GiB (truncating the 10.9
  GiB btrfs partition). Fixed by setting `HDDSIZEGB_1=20` in
  `vars.template.json` — overlay is now 20 GiB. SUT still doesn't see the
  file. **Resized the disk but the btrfs tree still shows Jan 16 2025.**
- **`.workdir` overlay was re-used**: not the cause — each test creates a
  fresh overlay (`Formatting '.../hd0-overlay0' ...` in isotovideo.log).
- **Btrfs generation freeze across qcow2 layers**: this is the real cause.
  qemu-img COW works at the qcow2 block level, but btrfs has its own
  internal COW at the extent level. When the base's btrfs is modified
  after the overlay is created, the kernel-mounted btrfs from the overlay
  does not see the new extents in the base.

## What's been tried

1. `virt-customize --upload file.wav:/opt/test-audio.wav` — silently lands
   in `@home` subvol. SUT's `/opt` doesn't see it.
2. `virt-customize --upload file.wav:/home/testuser/test-audio.wav` — same
   problem (wrong subvol).
3. `virt-customize --upload file.wav:/var/tmp/test-audio.wav` — same
   problem.
4. `guestfish ... -m btrfsvol:/dev/sda4/root /` then `upload` to
   `/opt/test-audio.wav` — file verified in `@root` via `stat`. SUT still
   doesn't see it.
5. Same trick to `/var/tmp/voice-bake-src/test-audio.wav` (a path the SUT
   has already touched, in `@var`). SUT still doesn't see it.
6. `HDDSIZEGB_1=20` to grow the overlay from 5 GiB → 20 GiB (was
   truncating the 10.9 GiB btrfs partition). SUT still doesn't see it.
7. Fresh copy of base → `golden-gnome-deps-working.qcow2` with file
   embedded — not yet tested. **This is the current hypothesis to try.**

## What's left to do

1. **Test the fresh-copy hypothesis**: copy base → working.qcow2, upload
   file to working.qcow2 via `guestfish btrfsvol` mount, set
   `run-host.sh` to use working.qcow2, run the test.
   - If working: the pattern is "maintain a working copy of the base, bake
     files into it, discard between runs". This needs a small script that
     does `cp base working.qcow2 && guestfish ... upload` before each
     test.
   - If not working: the qcow2 + btrfs layering issue is fundamental and
     needs a different approach.
2. **Alternative approaches if (1) doesn't work**:
   - Use `btrfs send/receive` to create a real btrfs snapshot of the base
     (bypasses qcow2 COW).
   - Convert the working copy to a **raw** image (`qemu-img convert -O raw`)
     so there is no qcow2 COW at all.
   - Patch `os-autoinst` to skip the overlay and use HDD_1 directly. The
     relevant code is in `/usr/lib/os-autoinst/OpenQA/Qemu/Proc.pm`
     `configure_blockdevs` — the `if (defined $backing_file)` branch
     always creates an overlay.
   - Use `qemu-img snapshot -c` (internal qcow2 snapshot) on the base
     image before each test, so the SUT writes to the snapshot, not an
     external overlay. Restore via `qemu-img snapshot -d` after the test.
3. **Once the audio file is visible**: extend `transcribe.pm` to actually
   exercise the voice-to-text pipeline (the original goal). The current
   test only checks the file exists.
4. **Cleanup**: revert the `run-host.sh` change that points at
   `golden-gnome-deps-working.qcow2` (currently the script looks for that
   file). Decide on a permanent naming scheme and whether to keep
   `HDDSIZEGB_1=20` (recommended — 5 GiB overlay truncates the btrfs
   partition).

## Files modified (uncommitted)

```
e2e/openqa-poc/needles/desktop.json
e2e/openqa-poc/needles/desktop.png
e2e/openqa-poc/run-host.sh           # points at working.qcow2
e2e/openqa-poc/tests/transcribe.pm   # debug btrfs commands; reverted
e2e/openqa-poc/vars.template.json    # HDDSIZEGB_1=20, port 2290, TEST_VOICE_DEBUG_FILE
e2e/openqa-poc/needles/welcome-tour.json    (untracked)
e2e/openqa-poc/needles/welcome-tour.png     (untracked)
e2e/openqa-poc/qemu-images -> /home/l/qemu-images  (untracked symlink)
```

## Environment notes

- Host: `/home/l/git/fedora-speech-to-text`, host qemu images at
  `/home/l/qemu-images/`. The script was updated to find
  `${POC_DIR}/../qemu-images` (relative to the script). A symlink at
  `e2e/openqa-poc/qemu-images` was added to bridge the layout.
- Workdir: `e2e/openqa-poc/.workdir` (falls back from `/tmp` which is only
  5.9 GiB free — not enough for HDDSIZEGB+20%).
- Run command: `bash /home/l/.run-openqa-test.sh` (300 s timeout via
  `timeout 300 isotovideo`).
- tmux session `openqa10` (named `test`) is left running for follow-up
  runs. `tmux -L openqa10 capture-pane -t test -p` to read its log; new
  runs: `tmux -L openqa10 send-keys -t test 'clear; bash
  /home/l/.run-openqa-test.sh' Enter`.
- Logs: `/home/l/.run-openqa-test.log` (last 5 min run, only top of file
  contains the per-test isotovideo log).
- Per-test artifacts: `e2e/openqa-poc/.workdir/testresults/transcribe-*.txt`
  (text captures of each `assert_script_run` step) and
  `transcribe-*.png` (screenshots).

## Quick debug commands

```bash
# Inspect base image btrfs
LIBGUESTFS_BACKEND=direct guestfish -i -a /home/l/qemu-images/golden-gnome-deps-autologin.qcow2 stat /opt
# List subvols
LIBGUESTFS_BACKEND=direct guestfish -a /home/l/qemu-images/golden-gnome-deps-autologin.qcow2 -m btrfsvol:/dev/sda4/root / sh -c 'btrfs subvolume list /'
# Upload to @root directly
LIBGUESTFS_BACKEND=direct guestfish -a /home/l/qemu-images/golden-gnome-deps-autologin.qcow2 -m btrfsvol:/dev/sda4/root / sh -c 'upload /path/to/file /opt/file'
```

## Skills referenced

- `voice-to-text-debug` (spinner hangs / SUT issues)
- `e2e-debugging` (QEMU VM interaction)
