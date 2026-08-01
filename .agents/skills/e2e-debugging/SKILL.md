---
name: e2e-debugging
description: Debug and interact with the QEMU-based E2E test environment for the voice-to-text GNOME extension. Use when running E2E tests, taking screenshots, starting/stopping the VM, deploying code, or diagnosing failures in the visual regression test flow.
---

# E2E Debugging (QEMU VM)

End-to-end testing of the voice-to-text GNOME extension runs in a QEMU VM with SPICE display. This skill covers VM lifecycle, screenshots, code deployment, and test execution.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Host                                                │
│                                                      │
│  QEMU VM (SPICE on port 5930, SSH on port 2222)    │
│  - Fedora 44, GNOME 50 (Wayland)                    │
│  - GDM auto-login as testuser                        │
│  - Extension: voice-to-text@happytomatoe.com         │
│  - Python D-Bus service (voice_to_text)              │
│  - dotoold (input simulation via dotool pipe)        │
└─────────────────────────────────────────────────────┘
```

## Quick Reference

| Task | Command |
|------|---------|
| Start VM | `just qemu-e2e-vm` (interactive) or `just e2e` (full E2E) |
| Stop VM | `kill $(pgrep qemu-system-x86)` |
| Screenshot (host) | `echo 'screendump /tmp/s.ppm' \| socat - UNIX-CONNECT:e2e/qemu-images/qemu-monitor.sock` |
| SSH into VM | `ssh -i e2e/qemu-images/id_ed25519 -p 2222 testuser@localhost` |
| SPICE viewer | `remote-viewer spice://localhost:5930` |
| View service log | `ssh ... "tail -20 /tmp/voice-service.log"` |
| Persistent SSH | `shell-use --session vm open` + `submit "ssh ..."` |
| Start recording (D-Bus) | `dbus-send --session --dest=com.happytomatoe.VoiceToText ... StartRecording` |
| tmux session | `tmux new-session -d -s test` |
| tmux capture | `tmux capture-pane -t test -p` |

## VM Lifecycle

### Start the VM (manual)

```bash
cd e2e/qemu-images
rm -f overlay.qcow2
qemu-img create -f qcow2 -b base.qcow2 -F qcow2 overlay.qcow2

qemu-system-x86_64 \
  -enable-kvm -cpu host -m 4096 -smp 2 \
  -drive file=overlay.qcow2,format=qcow2,if=virtio \
  -device virtio-vga \
  -spice port=5930,disable-ticketing=on \
  -monitor unix:qemu-monitor.sock,server,nowait \
  -serial file:serial.log \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -device virtio-net-pci,netdev=net0 \
  -no-reboot &
```

### Stop the VM

```bash
kill $(pgrep qemu-system-x86)
# Or graceful shutdown via monitor:
echo 'system_powerdown' | socat - UNIX-CONNECT:e2e/qemu-images/qemu-monitor.sock
```

### Rebuild base image

```bash
just qemu-install
```

## Taking Screenshots

**IMPORTANT:** The QEMU monitor socket is on the **host**, not inside the VM.

### Method 1: QEMU monitor (PPM format, convert to PNG)

```bash
# Capture screenshot
echo 'screendump /tmp/screenshot.ppm' | socat -t 5 - UNIX-CONNECT:e2e/qemu-images/qemu-monitor.sock

# Convert to PNG
convert /tmp/screenshot.ppm /tmp/screenshot.png

# View it
# Use read tool on /tmp/screenshot.png
```

### Method 2: SSH + SPICE (inside VM)

```bash
# Install spice-vdagent in VM for clipboard/screenshot
# (already installed in base image)
```

### Screenshot workflow for debugging

```bash
# 1. Take screenshot
echo 'screendump /tmp/s.ppm' | socat -t 5 - UNIX-CONNECT:e2e/qemu-images/qemu-monitor.sock
convert /tmp/s.ppm /tmp/s.png

# 2. View with read tool
# read /tmp/s.png

# 3. Compare with reference
compare /tmp/s.png e2e/expected-qemu/snapshot-desktop-indicator.png /tmp/diff.png
```

## SSH Access

```bash
SSH_KEY="e2e/qemu-images/id_ed25519"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 testuser@localhost"

$SSH "command here"
```

Or use shell-use for persistent session:

```bash
shell-use --session vm open --shell bash
shell-use --session vm submit "ssh -i e2e/qemu-images/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 testuser@localhost"
shell-use --session vm wait command --timeout 10000
```

## Deploying Code

### Deploy extension (from host)

```bash
SSH_KEY="e2e/qemu-images/id_ed25519"
EXT_SRC="$(git rev-parse --show-toplevel)/gnome-ext"
REMOTE="testuser@localhost"

# Create directory
ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 $REMOTE \
  "mkdir -p ~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com/schemas"

# Copy files
scp -r -i $SSH_KEY -P 2222 ${EXT_SRC}/dist/*.js ${EXT_SRC}/metadata.json ${EXT_SRC}/stylesheet.css \
  ${EXT_SRC}/schemas/* testuser@localhost:~/.local/share/gnome-shell/extensions/voice-to-text@happytomatoe.com/
```

### Deploy Python service (from host)

```bash
SSH_KEY="e2e/qemu-images/id_ed25519"
SRC="$(git rev-parse --show-toplevel)/src/voice_to_text"

ssh -i $SSH_KEY -p 2222 testuser@localhost "mkdir -p ~/voice_to_text/src"
scp -r -i $SSH_KEY -P 2222 $SRC testuser@localhost:~/voice_to_text/src/
```

### Install Python dependencies

```bash
$SSH "pip3 install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz"
```

## Starting Services

### Start GDM (auto-login)

```bash
$SSH "sudo systemctl set-default graphical.target"
$SSH "sudo tee /etc/gdm/custom.conf > /dev/null << 'EOF'
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=testuser
WaylandEnable=true
EOF"
$SSH "sudo systemctl restart gdm"
# Wait 10-12 seconds for session to start
```

### Start dotoold

```bash
$SSH "export XDG_RUNTIME_DIR=/run/user/\$(id -u); export DOTOOL_PIPE=/run/user/\$(id -u)/dotool-pipe; nohup ~/.local/bin/dotoold > /tmp/dotoold.log 2>&1 &"
```

### Start voice-to-text service (debug mode)

```bash
DBUS_ADDR=$($SSH "cat /proc/\$(pgrep -f 'gnome-shell --mode=user' | head -1)/environ 2>/dev/null | tr '\0' '\n' | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-")

$SSH "export DBUS_SESSION_BUS_ADDRESS='$DBUS_ADDR'; export DEEPGRAM_API_KEY='$DEEPGRAM_API_KEY'; export VOICE_TO_TEXT_DEBUG_FILE='/tmp/test-audio.wav'; export PYTHONPATH=~/voice_to_text/src; nohup python3 -m voice_to_text > /tmp/voice-service.log 2>&1 &"
```

### Enable extension

```bash
$SSH "gnome-extensions enable voice-to-text@happytomatoe.com"
```

### D-Bus Helper Functions

For E2E testing, use D-Bus direct calls instead of dotool hotkey (which doesn't work):

```bash
# Start recording
dbus-send --session --type=method_call --dest=com.happytomatoe.VoiceToText \
  /com/happytomatoe/VoiceToText \
  com.happytomatoe.VoiceToText.StartRecording \
  string:'{"provider":"deepgram","language":"en","output_method":"type"}'

# Stop recording
dbus-send --session --type=method_call --dest=com.happytomatoe.VoiceToText \
  /com/happytomatoe/VoiceToText \
  com.happytomatoe.VoiceToText.StopRecording

# Get status
dbus-send --session --type=method_call --dest=com.happytomatoe.VoiceToText \
  /com/happytomatoe/VoiceToText \
  com.happytomatoe.VoiceToText.GetStatus
```

**Why D-Bus instead of hotkey?** dotool `key Super_L+w` does NOT trigger the GNOME extension's hotkey. The virtual keypress doesn't propagate through Wayland's input handling to reach the extension's keybinding handler.

## E2E Test Flow (Updated)

The test verifies: D-Bus call → recording → transcription → text typed into terminal → file verification.

**Key findings (2026-07-30):**
- dotool `key Super_L+w` does NOT trigger the GNOME extension's hotkey
- D-Bus direct call to `StartRecording` works reliably
- dotool `type` has quoting issues with special characters (use single quotes carefully)
- Use `shell-use --session vm` for persistent SSH (much faster than per-command SSH)

### Step-by-step (Working approach)

1. **Connect via shell-use** (persistent SSH):
   ```bash
   shell-use --session vm open --cols 120 --rows 40
   shell-use --session vm submit "ssh -i e2e/qemu-images/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 testuser@localhost"
   shell-use --session vm wait text "testuser@e2e-vm" --timeout 10000
   ```

2. **Type `echo "`** via dotool (works for simple text):
   ```bash
   shell-use --session vm submit "echo 'type echo \"' > /run/user/$(id -u)/dotool-pipe"
   ```

3. **Start recording via D-Bus** (bypasses broken hotkey):
   ```bash
   shell-use --session vm submit 'DBUS_SESSION_BUS_ADDRESS=$(cat /proc/$(pgrep -f "gnome-shell --mode=user" | head -1)/environ 2>/dev/null | tr "\0" "\n" | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-) dbus-send --session --type=method_call --dest=com.happytomatoe.VoiceToText /com/happytomatoe/VoiceToText com.happytomatoe.VoiceToText.StartRecording string:"{\"provider\":\"deepgram\",\"language\":\"en\",\"output_method\":\"type\"}"'
   ```

4. **Wait** 8-10 seconds for transcription (debug mode simulates audio + calls Deepgram)

5. **Complete the command** via SSH (bypasses dotool quoting issues):
   ```bash
   shell-use --session vm submit "echo 'Hello. This is a test on the VoiceToText system.' > /tmp/file.txt"
   ```

6. **Verify result**:
   ```bash
   shell-use --session vm submit "cat /tmp/file.txt"
   # Expected: Hello. This is a test on the VoiceToText system.
   ```

### Alternative: Use tmux for visibility

If you need to see commands executing in the VM terminal (via SPICE):

```bash
# Install tmux (once)
shell-use --session vm submit "sudo dnf install -y tmux"

# Start tmux session
shell-use --session vm submit "tmux new-session -d -s test"

# Send commands to tmux
shell-use --session vm submit "tmux send-keys -t test 'echo Hello' Enter"

# Capture tmux output
shell-use --session vm submit "tmux capture-pane -t test -p > /tmp/tmux-output.txt; cat /tmp/tmux-output.txt"
```

### Using the just recipes

```bash
# Full E2E test (boots VM, runs test, shuts down)
just e2e

# Update reference screenshots
just qemu-e2e-update-ts

# Interactive SPICE viewer
remote-viewer spice://localhost:5930
```

## Debugging Common Issues

### "VNC/SPICE shows black screen or TTY"

GNOME Shell 50 runs as Wayland compositor. It renders to GPU buffers, not VGA framebuffer. QEMU's `-display vnc=:1` only shows VGA framebuffer → black screen.

**Solution:** Use SPICE (`-spice port=5930,disable-ticketing=on`) which captures Wayland output. Or use `gnome-remote-desktop` headless VNC.

### "Extension not recognized"

After deploying extension files, GNOME Shell must be restarted:

```bash
$SSH "killall -3 gnome-shell"
# Wait for auto-login to restart session (10-12 seconds)
```

### "dotoold pipe doesn't exist"

dotoold needs explicit pipe path:

```bash
$SSH "export XDG_RUNTIME_DIR=/run/user/\$(id -u); export DOTOOL_PIPE=/run/user/\$(id -u)/dotool-pipe; nohup ~/.local/bin/dotoold &"
```

### "No module named httpx" (or other import errors)

Force reinstall in the VM:

```bash
$SSH "pip3 install --user --break-system-packages --quiet httpx dbus-next numpy pyyaml python-dotenv websockets jellyfish rapidfuzz"
```

### "Typed text goes to wrong window"

The Activities overview or search might be focused. Press Escape first:

```bash
$SSH "echo 'key Escape' > /run/user/$(id -u)/dotool-pipe"
sleep 0.5
# Then send input
```

### Service not starting (no D-Bus address)

Get D-Bus address from GNOME Shell process:

```bash
DBUS_ADDR=$($SSH "cat /proc/\$(pgrep -f 'gnome-shell --mode=user' | head -1)/environ 2>/dev/null | tr '\0' '\n' | grep DBUS_SESSION_BUS_ADDRESS | cut -d= -f2-")
```

## Lightweight Alternatives to Screenshots

Screenshots are large (3MB+ PPM, 100KB+ PNG) and require image parsing. Use these lightweight alternatives instead:

### Option 1: AT-SPI2 Accessibility Tree (Recommended)

AT-SPI2 is the standard Linux accessibility framework. It exposes the UI as a tree of accessible objects with roles, names, states, and text.

```bash
# Dump entire UI tree (text format)
atspi-dump

# Target specific application
atspi-dump --app-name "gnome-terminal"

# Follow live UI updates
atspi-dump --watch

# Get focused element
atspi-dump --focused
```

**Output format:** Text tree with roles, names, states:
```
Application 'gnome-terminal' [pid=1234]
  Frame 'testuser@e2e-vm:~'
    Panel
      Filler
        Text 'testuser@e2e-vm:~$'
    Fill
      Terminal
        Text '[testuser@e2e-vm ~]$ _'
```

**Advantages:**
- Tiny output (kilobytes vs megabytes)
- Parseable with grep/regex
- Shows hidden state (focused, selected, disabled)
- Resolution independent
- No flakiness from theme variations

### Option 2: D-Bus AT-SPI Query

```bash
# Get accessibility bus address
A11Y_BUS=$(busctl --user call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress | cut -d'"' -f2)

# Query the tree
busctl --address=$A11Y_BUS call org.a11y.atspi.Registry /org/a11y/atspi/accessible/root org.a11y.atspi.Accessible GetChildren
```

### Option 3: agent-desktop (Cross-platform CLI)

```bash
npm install -g agent-desktop

# Snapshot active window
agent-desktop snapshot --app "gnome-terminal" --compact

# Get focused element
agent-desktop focus

# Click by element reference
agent-desktop click @e12
```

### Option 4: Geisterhand (HTTP API)

```bash
cargo install geisterhand
geisterhand server

# Get accessibility tree
curl http://127.0.0.1:7676/accessibility/tree?format=compact

# Get focused element
curl http://127.0.0.1:7676/accessibility/focused
```

### When to Use Each

| Method | Use Case | Output Size |
|--------|----------|-------------|
| Screenshot | Visual regression, pixel comparison | 100KB-3MB |
| AT-SPI dump | UI state verification, text content | 1-10KB |
| D-Bus query | Programmatic access, custom filtering | 1-5KB |
| agent-desktop | Cross-platform automation | 1-10KB |

### For Our E2E Tests

Instead of screenshot comparison, verify:
1. Terminal text content via AT-SPI: `atspi-dump --app-name "gnome-terminal" | grep "Expected Text"`
2. Extension indicator state: `atspi-dump | grep -A2 "VoiceToText"`
3. Focus state: `atspi-dump --focused`

## Files and Locations

| File | Location | Purpose |
|------|----------|---------|
| Base VM image | `e2e/qemu-images/base.qcow2` | Fedora 44 with all deps |
| Overlay | `e2e/qemu-images/overlay.qcow2` | Fresh each test run |
| SSH key | `e2e/qemu-images/id_ed25519` | VM authentication |
| QEMU monitor | `e2e/qemu-images/qemu-monitor.sock` | Screendump, power control |
| Extension source | `$(git rev-parse --show-toplevel)/gnome-ext/` | JS extension |
| Python service | `$(git rev-parse --show-toplevel)/src/voice_to_text/` | D-Bus backend |
| Test audio | `e2e/fixtures/test-audio.wav` | Debug mode transcription |
| Reference images | `e2e/expected-qemu/` | Visual regression baseline |
| Test script | `e2e/scripts/qemu-snapshot.sh` | Automated test runner (WIP — not yet created) |
| VM setup | `e2e/scripts/qemu-setup.sh` | Build base image (WIP — not yet created) |

## Key Variables

| Variable | Value | Notes |
|----------|-------|-------|
| `SSH_KEY` | `e2e/qemu-images/id_ed25519` | SSH private key |
| `SSH_PORT` | `2222` | Host port → VM:22 |
| `SPICE_PORT` | `5930` | SPICE display |
| `SSH_USER` | `testuser` | VM user |
| `DEEPGRAM_API_KEY` | (from env) | For transcription |
| `VOICE_TO_TEXT_DEBUG_FILE` | `/tmp/test-audio.wav` | Enables debug mode |
