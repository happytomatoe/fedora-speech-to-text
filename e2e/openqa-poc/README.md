# openQA POC: boot a Fedora VM and verify GDM login

A self-contained openQA test that boots a Fedora 42 QCOW2 image in QEMU and verifies
the system reaches a GDM login screen, then logs in as `testuser` and lands on the
GNOME desktop. Runs from this directory; no podman required.

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
Final screenshot: `testresults/login_with_password-4.png`

End-to-end time: ~35 seconds on a host with KVM and the golden image cached.

## Requirements

- Fedora 41+ host with `/dev/kvm` accessible to the running user
- Packages:
  ```bash
  sudo dnf install os-autoinst xorg-x11-server-Xvfb qemu-kvm guestfs-tools
  ```
  (`guestfs-tools` provides `virt-customize`. On older releases use `libguestfs-tools-c`.)
- The os-autoinst distri reference tree, cloned to `/tmp/os-autoinst-distri-fedora`:
  ```bash
  sudo git clone --depth 1 https://github.com/os-autoinst/os-autoinst-distri-fedora /tmp/os-autoinst-distri-fedora
  ```
  (Required for some shared utilities; you can also point the loader elsewhere via `PERL5LIB`.)
- A golden QCOW2 image with a `testuser` account whose password is `testuser`.
  See [Golden image](#golden-image) below for how to provision it from scratch.

## Quick start

```bash
# 0. one-time, from a clean clone of the repo:
#    - clone the distri (see Requirements)
#    - provision the golden image (see Golden image)
#      OR copy an existing baked image from another machine.

# 1. (every fresh checkout) make sure the golden image is in place
ls ../qemu-images/golden-gnome-deps-autologin.qcow2
#    if not: just prepare-img    (bakes the password into a copy of the base image)

# 2. run the test
just openqa-test
```

`just` with no arguments prints the available recipes.

## Golden image

The test boots `../qemu-images/golden-gnome-deps-autologin.qcow2` (relative to this
directory). The `*autologin*` image is a copy of `golden-gnome-deps.qcow2` with the
`testuser` password baked in via `virt-customize`.

The base image (`golden-gnome-deps.qcow2`, ~1.8 GB) is **not** stored in git. Provision
it once on each machine, or copy the autologin image directly from another machine
that already has it.

### Provision from scratch (offline-friendly, single `virt-customize` invocation)

```bash
# Download the official Fedora 42 cloud image (one time)
curl -L -o /tmp/Fedora-Cloud-Base-42.qcow2.xz \
  https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-42-1.14.x86_64.qcow2.xz
unxz /tmp/Fedora-Cloud-Base-42.qcow2.xz
mv /tmp/Fedora-Cloud-Base-42.qcow2 e2e/qemu-images/golden-gnome-deps.qcow2

# Resize to leave headroom for package install
qemu-img resize e2e/qemu-images/golden-gnome-deps.qcow2 +5G

# Install everything the test expects (GNOME, GDM, testuser, sudo, virtio drivers).
# This single virt-customize invocation replaces the manual boot+install+sysprep dance.
# --root-password and --password set the credentials; --run-command enables
# passwordless sudo and ensures virtio-serial is loaded at boot.
sudo virt-customize \
    -a e2e/qemu-images/golden-gnome-deps.qcow2 \
    --root-password password:testuser \
    --password testuser:password:testuser \
    --install @gnome-desktop,gdm,NetworkManager,systemd-resolved,virtio-tools,spice-vdagent,glx-utils,libglvnd-glx,mesa-dri-drivers,plymouth \
    --run-command "echo 'testuser ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/testuser" \
    --run-command "systemctl enable gdm NetworkManager" \
    --run-command "sed -i 's/^#*AutomaticLoginEnable=.*/AutomaticLoginEnable=true/' /etc/gdm/custom.conf" \
    --run-command "sed -i 's/^#*AutomaticLogin=.*/AutomaticUser=testuser/' /etc/gdm/custom.conf" \
    --run-command "systemctl set-default graphical.target" \
    --selinux-relabel

# Bake the testuser password into a working copy
just prepare-img
```

### Or copy an already-baked image from another machine

If a teammate has the working image, just rsync it:

```bash
rsync -avP other-host:/path/to/golden-gnome-deps-autologin.qcow2 e2e/qemu-images/
```

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
  (the GDM password input field)
- Types the password (`testuser`) + Enter, sleeps 5 s, and saves a screenshot

The needles (`needles/login-screen.{json,png}`, `needles/password-prompt.{json,png}`)
are image templates openQA uses for visual assertions. The `login-screen` needle
covers the top status bar (positions 0-350 and 700-1024 of the 1024-pixel-wide
status bar) to avoid the system clock area, which varies between runs.
The `password-prompt` needle covers only the password input box itself
(positions 380-650, 445-495), so it matches regardless of whether the username
label is still shown above the box.

## Files

| File | Role |
|------|------|
| `main.pm` | Loads `vtdistribution`, schedules the test from `vars.json` |
| `vtdistribution.pm` | Minimal os-autoinst distribution: registers 3 consoles, sets test list |
| `vars.template.json` | QEMU + test parameters template (no absolute paths) |
| `vars.json` | **Generated** by `run-host.sh` from `vars.template.json` with absolute paths substituted; gitignored |
| `tests/login_with_password.pm` | The test itself (this is the only test that runs) |
| `tests/boot_desktop.pm`, `tests/autologin.pm`, `tests/find_password.pm` | Earlier test attempts, kept for reference |
| `needles/{login-screen,password-prompt,desktop}.{json,png}` | Visual references for openQA |
| `run-host.sh` | Boots the test: starts Xvfb, generates vars.json, runs isotovideo, cleans up |
| `Containerfile` | Optional podman image (alternative to host packages) |
| `justfile` | `just openqa-test`, `just prepare-img`, `just clean`, `just build` |

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
- **"golden-gnome-deps-autologin.qcow2 not found"** — you haven't run
  `just prepare-img` yet, or you haven't rsynced an already-baked image from
  another machine. See [Golden image](#golden-image).
- **"no candidate needle with tag 'login-screen' matched"** — the GDM layout
  changed in a Fedora update. Re-capture the needle by booting the image
  manually, taking a screenshot, and replacing `needles/login-screen.png` (and
  updating `login-screen.json` to match the new layout).
- **Test fails with `Can't sysopen ... virtio_console.in`** — your CWD does
  not match `CASEDIR`. Run `just openqa-test` from this directory (it handles
  paths automatically), or set `CASEDIR` before invoking `isotovideo` manually.
- **`just prepare-img` hangs on `sudo: a password is required`** — your
  `sudo` configuration requires a TTY for password input. Run from an
  interactive terminal, or configure passwordless `sudo` for `virt-customize`
  in `/etc/sudoers`.
- **Test reports `similarity: 0` for `password-prompt`** — needle is too tight
  or too loose for your GDM theme/scaling. Open the most recent
  `testresults/login_with_password-3.png`, find the password input box
  coordinates, and update `needles/password-prompt.json` accordingly.
