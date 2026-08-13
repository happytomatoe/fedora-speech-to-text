# E2E Test Documentation

## Quick Overview

### Current Test Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        HOST MACHINE                              │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  E2E Test Runner (TypeScript)                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                     │
│                           │ SSH + SCP                            │
│                           ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  QEMU VM (configurable: 4GB RAM, 1 core default)              │  │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  GNOME Shell                                         │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │  Voice-to-Text Extension                     │   │  │  │
│  │  │  │  - Hotkey recording                          │   │  │  │
│  │  │  │  - Preferences UI                            │   │  │  │
│  │  │  │  - Output methods (dotool/mutter)            │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           │                                     │
│                           │ HTTP (port 5092)                    │
│                           ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Parakeet Container                                       │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  Transcription API                                   │  │  │
│  │  │  - Model: nvidia/parakeet-tdt-0.6b-v3               │  │  │
│  │  │  - Latency: ~500ms                                   │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Test Flow Timeline

```
┌─────────────────────────────────────────────────────────────────┐
│  VM SETUP (7-29s)                                                │
│  ├── Boot QEMU VM (5-10s)                                        │
│  ├── Wait for SSH (5-10s)                                        │
│  └── Restore snapshot (7-9s) ← BOTTLENECK!                      │
│                                                                 │
│  TEST FLOW (4-5s)                                                │
│  ├── Dismiss Activities (0.6s)                                   │
│  ├── Open Terminal (2.4s)                                        │
│  ├── Start Recording (0.3s)                                      │
│  ├── Wait for Transcription (4.6s) ← BOTTLENECK!               │
│  │   ├── Simulate audio capture (3.9s) ← 85% of time!           │
│  │   ├── HTTP to Parakeet (0.1s)                                 │
│  │   ├── Parakeet transcribe (0.5s)                              │
│  │   └── Type result (0.2s)                                      │
│  └── Stop Recording (0.2s)                                       │
│                                                                 │
│  TOTAL: 11-34s                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Key Insights

### What We're Testing

1. **GNOME Extension** - Hotkey recording, preferences, output methods
2. **Voice Service** - Audio capture, transcription, typing
3. **Parakeet** - Transcription accuracy
4. **Full Pipeline** - End-to-end user experience

### What's Slow

| Component | Time | % of Total | Why |
|-----------|------|------------|-----|
| **Audio Playback** | 3.9s | **85%** | VM plays through virtual speakers |
| **Snapshot Restore** | 7-9s | **60-70%** | QEMU internal snapshot |
| **VM Boot** | 5-10s | First time only | QEMU cold boot |

### What's Fast

| Component | Time | Notes |
|-----------|------|-------|
| **Parakeet Transcription** | 0.5s | Fast! |
| **Capture Audio** | 0.1s | Fast! |
| **HTTP to Parakeet** | 0.1s | Fast! |
| **Type Result** | 0.2s | Fast! |

## Optimization Opportunities

### 1. Skip Audio Playback (Batch Mode)
**Current**: 4.6s → **Optimized**: 0.6s (7.7x faster)

```
Current:
VM: Play audio (3.9s) → Capture (0.1s) → HTTP (0.1s) → Transcribe (0.5s) → Type (0.2s)

Optimized:
Test Runner: Send audio to Parakeet (0.5s) → Verify (0.1s)
```

### 2. PulseAudio Loopback (Streaming Mode)
**Current**: 4.6s → **Optimized**: 2.0s (2.3x faster)

```
Current:
VM: Play audio (3.9s) → Capture (0.1s) → HTTP (0.1s) → Transcribe (0.5s) → Type (0.2s)

Optimized:
VM: Pipe audio to virtual mic (1.0s) → Capture (0.1s) → HTTP (0.1s) → Transcribe (0.5s) → Type (0.2s)
```

### 3. External Snapshots
**Current**: 7-9s → **Optimized**: <1s (7-9x faster)

## Documentation

- [Test Architecture](test-architecture.md) - Detailed ASCII diagrams of test flows
- [Optimization Guide](optimization-guide.md) - How to implement optimizations
