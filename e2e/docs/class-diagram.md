# E2E Test Framework — Class Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         qemu-snapshot.ts (main)                        │
│  StepRunner.run([preflight, boot-vm, wait-ssh, setup, test-flow])      │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ orchestrates
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              VmManager                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  + qemu: QemuMonitor      ── owns ──▶  ┌──────────────────────────┐   │
│  + deployer: Deployer     ── owns ──▶  │ net.Socket → QEMU HMP   │   │
│  + shell: ShellHelper     ── owns ──▶  │ /tmp/qemu-monitor.sock  │   │
├─────────────────────────────────────────┼──────────────────────────┤   │
│  + boot()                               │  + connect()             │   │
│  + waitForSsh() opens shell session     │  + execute(cmd) → string │   │
│  + setup()    uses shell for commands   │  + queryStatus()         │   │
│  + shutdown()                           │  + screendump(path)      │   │
│  - pollUntil()                          │  + savevm(tag)           │   │
└─────────────────────────────────────────┴──────────────────────────┘   │
                                    │                                    │
        ┌───────────────────────────┼───────────────────────────┐        │
        │                           │                           │        │
        ▼                           ▼                           ▼        │
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐│
│     Deployer         │  │    ShellHelper        │  │                  ││
├──────────────────────┤  ├──────────────────────┤  │  QemuMonitor     ││
│ ssh2.Client → SFTP   │  │ ShellUse → PTY daemon│  │  (shown above)   ││
│                      │  │                      │  │                  ││
│ File upload ONLY:    │  │ All commands:        │  └──────────────────┘│
│  + uploadFile()      │  │  + exec(cmd)         │                      │
│  + uploadDir()       │  │  + dotoolCommand()   │                      │
│                      │  │  + sendHotkey()      │                      │
│ Not for commands:    │  │  + waitText()        │                      │
│  (use shell.exec)    │  │  + screenshot()      │                      │
└──────────────────────┘  └──────────────────────┘                      │
                                                                        │
└─────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════

DATA FLOW

  boot-vm
    │
    ├─ Bun.spawnSync("qemu-img create ...")        ← host
    ├─ Bun.spawn("qemu-system-x86_64 ...")         ← host
    └─ qemu.connect()                               ← net.Socket

  wait-ssh
    └─ shell.openSshSession()                       ← ShellUse PTY

  setup
    ├─ shell.exec("loginctl ...")                   ← PTY
    ├─ shell.exec("gnome-extensions ...")           ← PTY
    ├─ shell.exec("pgrep ...")                      ← PTY
    ├─ shell.exec("dotoold ...")                    ← PTY
    ├─ deployer.uploadDir("~/voice_to_text/...")    ← ssh2 SFTP
    ├─ deployer.uploadFile("/tmp/test-audio.wav")   ← ssh2 SFTP
    ├─ shell.exec("pip3 install ...")               ← PTY
    ├─ shell.exec("python3 -m voice_to_text ...")   ← PTY
    └─ qemu.savevm("ready")                         ← QMP

  test-flow
    ├─ shell.exec("gnome-terminal ...")             ← PTY
    ├─ shell.dotoolCommand("type tmux attach ...")  ← PTY
    ├─ shell.sendHotkey()                           ← PTY
    ├─ shell.waitForTranscription()                 ← PTY + polling
    └─ shell.exec("echo ... > /tmp/file.txt")       ← PTY

  verifyResult
    └─ deployer.exec("cat /tmp/file.txt")           ← ssh2 exec

═══════════════════════════════════════════════════════════════════════════

RESPONSIBILITY SPLIT

  Class          Transport              Purpose
  ─────────────  ─────────────────────  ──────────────────────────────────
  QemuMonitor    net.Socket → QMP/HMP   VM lifecycle (snapshot, shutdown)
  Deployer       ssh2 → SFTP            File deployment ONLY
  ShellHelper    shell-use → PTY        All interactive commands
  VmManager      —                      Owns all three, lifecycle mgmt
  StepRunner     —                      Structured step execution
```
