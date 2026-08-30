# openQA POC: boot a Fedora VM and verify GDM login

A self-contained openQA test that boots a Fedora 42 QCOW2 image in QEMU and verifies
the system reaches a GDM login screen, then logs in as `testuser` and lands on the
GNOME desktop. The whole thing runs from this directory.

## What the test does

1. Starts `Xvfb` on display `:99` (the VNC surface that openQA captures)
2. Launches `isotovideo` (the openQA engine) against a QEMU VM backed by the
   golden image
3. Waits for `localhost login:` on the virtio-serial console (hvc0)
4. Switches to the VNC graphical console
5. Asserts the `login-screen` needle (GDM user picker with the `testuser` row)
6. Types `testuser`, asserts the `password-prompt` needle
7. Types the password, asserts the desktop is reached, saves a screenshot

Result JSON: `testresults/result-login_with_password.json`
Final screenshot: `testresults/login_with_password-4.png` (or `testresults/desktop.png` if copied)

End-to-end time: ~35 seconds on a host with KVM and the golden image cached.

## Requirements

- Fedora 41+ host with `/dev/kvm` accessible to the running user
- Packages: `os-autoinst`, `xorg-x11-server-Xvfb`, `qemu-kvm`, `guestfs-tools`
  (or `libguestfs-tools-c` on older releases). On Fedora 44 the package providing
  `virt-customize` is `guestfs-tools`.
- A golden QCOW2 image with a `testuser` account whose password is `testuser`.
  See "Golden image" below.

## Quick start

```bash
# 1. (one time) bake the password into a copy of the golden image
just prepare-img

# 2. run the test
just test
```

`just` prints available recipes when invoked with no arguments.

## How the test works (in detail)

The flow is driven by `isotovideo`, which loads `main.pm` and uses our
`vtdistribution` (a minimal subclass of os-autoinst's `distribution`) to wire
up the consoles. `vtdistribution` registers three virtio-serial consoles
(`virtio-console`, `root-console`, `serial0`) and tells `isotovideo` that the
test list is `[login_with_password]`.

`tests/login_with_password.pm` is the only test module. It:

- Selects the `virtio-console`, waits for the `localhost login:` prompt that
  the kernel prints on hvc0 during early boot (~30-35 s after QEMU start)
- Switches to the `sut` console (VNC), waits up to 60 s for the `login-screen`
  needle (GDM user picker showing the `testuser` avatar)
- Types `testuser` + Enter, waits up to 30 s for the `password-prompt` needle
  (the password input field on the GDM user picker)
- Types the password (`testuser`) + Enter, sleeps 5 s, and saves a screenshot

The needles (`needles/login-screen.{json,png}`, `needles/password-prompt.{json,png}`)
are image templates openQA uses for visual assertions. The `login-screen` needle
covers the top status bar (positions 0–350 and 700–1024 of the 1024-pixel-wide
status bar) to avoid the system clock area, which varies between runs.

## Golden image

The test boots `e2e/qemu-images/golden-gnome-deps-autologin.qcow2`. The
`*autologin*` image is a copy of `golden-gnome-deps.qcow2` with the
`testuser` password baked in via `virt-customize`. `just prepare-img`
performs the bake.

The base image (`golden-gnome-deps.qcow2`, ~1.8 GB) is **not** stored in git.
Provision it once with whatever Fedora 42 cloud image you prefer, install any
extra packages the test should assume, then snapshot. The file should land at
`e2e/qemu-images/golden-gnome-deps.qcow2` (relative to the repo root).

A minimal provisioning recipe (not committed; for reference):

```bash
# Start from the official Fedora 42 cloud image
qemu-img create -f qcow2 -b Fedora-Cloud-Base-42.qcow2 -F qcow2 \
    e2e/qemu-images/golden-gnome-deps.qcow2
# Boot it, install the deps, sysprep, shut down
# ... (use virt-customize for the dep install, virt-sysprep to clean up)
```

## Files

| File | Role |
|------|------|
| `main.pm` | Loads `vtdistribution`, schedules the test from `vars.json` |
| `lib/vtdistribution.pm` | Minimal os-autoinst distribution: registers 3 consoles, sets test list |
| `vars.json` | QEMU + test parameters; `TEST` selects which `.pm` to run |
| `tests/login_with_password.pm` | The test itself (this is the only test that runs) |
| `tests/boot_desktop.pm`, `tests/autologin.pm`, `tests/find_password.pm` | Earlier test attempts, kept for reference |
| `needles/{login-screen,password-prompt,desktop}.{json,png}` | Visual references for openQA |
| `run-host.sh` | Boots the test: starts Xvfb, runs isotovideo, cleans up |
| `Containerfile` | Optional podman image (alternative to host packages) |
| `justfile` | `just test`, `just prepare-img`, `just clean`, `just build` |

## Running in podman instead

If you prefer not to install the host packages:

```bash
just build              # builds openqa-poc-worker image (~5 min first time)
# then run the podman equivalent of run-host.sh
```

The `Containerfile` is kept for that flow, but the host-side runner is the
default because it has the simplest setup and matches what CI would do on a
self-hosted runner.

## Troubleshooting

- **"isotovideo: command not found"** — install `os-autoinst`.
- **"/dev/kvm: permission denied"** — your user is not in the `kvm` group
  (or `/dev/kvm` is not world-writable). `sudo usermod -aG kvm $USER` and log
  back in.
- **"no candidate needle with tag 'login-screen' matched"** — the GDM layout
  changed in a Fedora update. Re-capture the needle by booting the image
  manually, taking a screenshot, and replacing `needles/login-screen.png` (and
  updating `login-screen.json` to match the new layout).
- **Test dies on `select_console 'virtio-console'`** with
  `Can't sysopen ... virtio_console.in` — you're running from a CWD that
  doesn't match `CASEDIR`. Run from the directory containing `vars.json`.
