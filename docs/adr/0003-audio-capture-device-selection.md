# 0003 — Audio capture device selection and level metering

- Status: Accepted
- Date: 2026-11-22

## Context

`AsyncAudioRecorder` wraps a `sounddevice` input stream whose callback runs on a PortAudio
thread. Device choice, buffering and level computation all have non-obvious constraints.

## Decisions

### 1. Prefer the `pipewire` device when the user chose nothing

With no explicit device, the recorder tries `pipewire` first and falls back to PortAudio's
default only if the PipeWire ALSA plugin is unavailable. Routing through PipeWire makes GNOME
Shell's microphone/privacy recording indicator appear and selects the correct source on
PipeWire systems. An explicitly selected device is used as-is; there is no silent fallback,
because recording from a different device than the user picked would be a privacy bug.

### 2. The queue holds roughly two minutes of audio

`asyncio.Queue(maxsize=1000)` at 2048 samples per chunk and 16 kHz is about 128 seconds. The
consumer is the D-Bus/streaming pipeline; a stall of that length is treated as fatal rather than
allowed to grow memory without bound.

### 3. Full queue drops the newest frame

When the queue is full the callback drops the incoming frame (`QueueFull` is suppressed). The
callback thread must never block: blocking PortAudio causes dropouts for the whole system.

### 4. Level is a normalized dBFS value

RMS is converted to dBFS, floored at −50 dB and ceilinged at 0 dB, then linearly mapped to
`0.0–1.0` and smoothed exponentially (`0.7 * previous + 0.3 * current`). The UI uses that
smoothed value; it is not a calibrated sound-pressure level.

## Consequences

The device list exposed over D-Bus contains only devices that accept 16 kHz mono capture, so
selecting an entry cannot fail later with "invalid sample rate". Changing the sample rate
requires revisiting that filter and the queue sizing.
