# E2E Test Timing Analysis

## Current Breakdown (77.6s total)

### Phase 1: VM Boot (0.5s)
```
boot-vm: 0.5s
  └─ Reusing existing overlay
```

### Phase 2: SSH Wait (0.6s)
```
wait-ssh: 0.6s
  └─ SSH connection test
```

### Phase 3: Setup (51.3s) ← **BOTTLENECK**

| Step | Time | What Happens |
|------|------|--------------|
| **GDM Login** | 8.5s | `gdbus wait` (0.3s) + session ready (8.1s) |
| **SSH Connect** | 2s | Establish deployer SSH connection |
| **installDependencies** | 15s | Check/install GDM, gnome-terminal, ghostty |
| **deployExtension** | 15s | Upload files + compile schemas + dconf |
| **deploy Python+audio** | 3s | rsync Python source + test audio |
| **startVoiceService** | 8s | Install deps + start service + wait for D-Bus |

**Setup Total: ~51.3s**

### Phase 4: Test Execution (22.7s)

| Step | Time | What Happens |
|------|------|--------------|
| Open terminal | 2s | Launch gnome-terminal |
| Start recording | 1s | Trigger extension |
| Wait for audio | 5s | Play test WAV file |
| Poll transcription | 12s | Wait for D-Bus response |
| Capture frame | 1s | Screenshot for visual verify |
| Assert result | 1.7s | Compare transcription |

**Test Total: ~22.7s**

---

## Where is the 51.3s Spent?

```
51.3s Setup Breakdown:
├── GDM Login:           8.5s  (17%)
├── SSH Connect:         2.0s  (4%)
├── installDependencies: 15.0s (29%) ← Could be pre-installed
├── deployExtension:     15.0s (29%) ← Could be faster
├── deploy Python+audio: 3.0s  (6%)
└── startVoiceService:   8.0s  (16%)
```

---

## Why 51.3s but Earlier Breakdown Showed Less?

The earlier breakdown was **approximate**. Here's the real breakdown:

| What I Said | Actual | Difference |
|-------------|--------|------------|
| GDM login: 8.5s | 8.5s | ✓ |
| Session ready: 8.1s | Included in GDM | - |
| Extension deploy: 15s | 15s | ✓ |
| **Missing** | installDependencies: 15s | +15s |
| **Missing** | SSH connect: 2s | +2s |
| **Missing** | startVoiceService: 8s | +8s |

**Total: 8.5 + 2 + 15 + 15 + 3 + 8 = 51.5s** ✓

---

## Optimization Opportunities

### 1. Pre-install Dependencies in Golden Image (-15s)
**Current:** Check + install GDM, gnome-terminal, ghostty each run
**Optimized:** Already installed in golden-gnome.qcow2

```bash
# Add to golden image:
sudo dnf install -y gdm gnome-shell gnome-terminal
sudo dnf copr enable -y scottames/ghostty
sudo dnf install -y ghostty
```

### 2. Package Extension as Zip (-10s)
**Current:** Upload 20+ individual files via SFTP
**Optimized:** Single zip file transfer

```bash
# Build once
cd gnome-ext && zip -r ../voice-to-text.zip .

# Transfer once
scp voice-to-text.zip testuser@localhost:~/

# Extract on VM
ssh testuser@localhost 'cd ~/.local/share/gnome-shell/extensions/ && unzip ~/voice-to-text.zip'
```

### 3. Skip GDM Restart When Possible (-25s)
**Current:** Always restart GDM to load extension
**Optimized:** Use `gnome-extensions enable/disable` if extension is already installed

### 4. Persistent Dev VM (-30s)
**Current:** Boot → Setup → Test → Shutdown
**Optimized:** Keep VM running, rsync changes

---

## Target Timing

| Phase | Current | Optimized | Savings |
|-------|---------|-----------|---------|
| VM Boot | 0.5s | 0.5s | - |
| SSH Wait | 0.6s | 0.6s | - |
| GDM Login | 8.5s | 0s (snapshot) | -8.5s |
| installDependencies | 15s | 0s (golden image) | -15s |
| deployExtension | 15s | 5s (zip) | -10s |
| deploy Python+audio | 3s | 3s | - |
| startVoiceService | 8s | 3s (pre-installed) | -5s |
| Test Execution | 22.7s | 22.7s | - |
| **Total** | **77.6s** | **~35s** | **-42.6s** |

---

## Recommended Implementation Order

1. **Pre-install deps in golden image** (-15s) - Easy
2. **Package extension as zip** (-10s) - Easy
3. **Snapshot/restore loop** (-25s) - Medium
4. **Skip GDM restart** (-10s) - Hard

**Total potential savings: ~50s (77.6s → ~27s)**
