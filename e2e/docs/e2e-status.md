# E2E Test Status & Optimization

## Current Status

**Last Successful Run:**
- **Total Time**: 77.6s
- **Setup Time**: 51.3s (includes GDM login, SSH wait, extension deploy)
- **Test Flow Time**: 22.7s (includes recording, transcription, assertion)

**Components:**
- ✅ Golden image created (`golden-gnome.qcow2` - 1.9GB)
- ✅ Dependencies pre-installed (dotool, tmux, python packages)
- ✅ E2E tests passing
- ⚠️ MEGA upload in progress (for backup)

## Timing Breakdown

| Phase | Time | Notes |
|-------|------|-------|
| VM Boot | ~0.5s | Using existing overlay |
| SSH Wait | ~0.6s | Quick connection |
| GDM Login | ~8.5s | Headless cloud image |
| Session Ready | ~8.1s | GNOME Shell startup |
| Extension Deploy | ~15s | Copy files, reload extension |
| Test Execution | ~22.7s | Record, transcribe, assert |
| **Total** | **~77.6s** | |

## Optimization Opportunities

### 1. Snapshot/Restore Loop (Expected: -50s)
**Current**: Boot VM → Wait SSH → GDM Login → Deploy → Test
**Optimized**: Boot once → Save snapshot → Restore snapshot → Test

```bash
# Save snapshot after first boot
virsh snapshot-create-as e2e-vm "golden" "Golden state with GDM ready"

# Restore snapshot for subsequent runs
virsh snapshot-revert e2e-vm "golden"
```

**Savings**: Eliminates GDM login (8.5s) + Session ready (8.1s) + Extension deploy (15s)

### 2. Persistent Dev VM (Expected: -30s)
**Current**: Create overlay → Boot → Test → Destroy overlay
**Optimized**: Keep VM running, rsync changes, reload extension

```bash
# Keep VM running between tests
# rsync changes to VM
rsync -avz --exclude='.git' src/ testuser@localhost:~/voice-to-text/

# Reload extension
ssh testuser@localhost 'gnome-extensions disable voice-to-text && gnome-extensions enable voice-to-text'
```

### 3. Pre-built Extension Package (Expected: -5s)
**Current**: Copy individual files to VM
**Optimized**: Build extension zip, copy once, extract

```bash
# Build extension package
cd gnome-ext && zip -r ../voice-to-text.zip .

# Copy to VM
scp voice-to-text.zip testuser@localhost:~/

# Extract and reload
ssh testuser@localhost 'cd ~/.local/share/gnome-shell/extensions/ && unzip ~/voice-to-text.zip'
```

### 4. Parallel Test Execution (Expected: -10s)
**Current**: Sequential test steps
**Optimized**: Run independent steps in parallel

```typescript
// Run recording and frame capture in parallel
const [recording, frame] = await Promise.all([
  startRecording(),
  captureFrame()
]);
```

## Recommended Next Steps

1. **Immediate**: Implement snapshot/restore loop (-50s)
2. **Short-term**: Add extension packaging (-5s)
3. **Medium-term**: Persistent dev VM for development (-30s)

## Target Timing

| Metric | Current | Target | Savings |
|--------|---------|--------|---------|
| Setup | 51.3s | ~5s | -46s |
| Test | 22.7s | ~20s | -2.7s |
| **Total** | **77.6s** | **~25s** | **-52.6s** |

## MEGA Backup Status

- ✅ MEGA account created (20 GB free)
- ✅ megatools installed in toolbox
- ✅ Credentials configured
- ⏳ Golden image upload in progress
- 📝 Upload guide saved to `mega-upload-guide.md`
