# TODO

## Streaming / Real-time

- [ ] Add mutter-commit output method for streaming transcription results
  - Currently `stream_diff()` only works with `type` and `mutter-virtual` methods
  - Need to integrate `MutterVirtualPaster` with streaming partial results
  - Use `Main.inputMethod.commit()` to commit text directly without clipboard/keystroke simulation

- [ ] Text stabilization for partial results (Idea #2 from STT analysis)
  - Source: RealtimeSTT (MIT license)
  - Problem: Partial results jump around as AI revises outputs, creating flickery UX
  - Solution: Characters only become visible once they've appeared consistently across multiple AI outputs
  - Key parameters from RealtimeSTT:
    - `min_char_confirmations: 2` - character must appear in 2+ consecutive outputs
    - `min_char_evidence_span_seconds: 0.60` - character visible for at least 0.6s
    - `space_min_confirmations: 4` - spaces need more confirmation
    - `space_requires_stable_right_context: True` - spaces need confirmed text after them
  - Tradeoff: Small latency (hundreds of ms) for much better readability
  - Impact: High - best UX improvement for streaming mode

## VAD / Audio Processing

- [ ] Replace energy-based VAD with Silero VAD (Idea #1 from STT analysis)
  - Source: WhisperLive + RealtimeSTT (MIT license)
  - Current: RMS energy thresholding (volume-based, unreliable with background noise)
  - New: ~2MB ONNX neural network that understands speech patterns
  - Impact: High - biggest quality jump for detection accuracy

- [ ] Add preroll buffer to prevent first-word clipping (Idea #3 from STT analysis)
  - Source: RealtimeSTT (MIT license)
  - Problem: VAD takes time to detect speech, causing first word to be lost
  - Solution: ~1 second circular buffer that saves audio before VAD triggers
  - Scan backward to find clean silence boundary before including pre-detection audio

## Configuration / UX

- [x] Add hotwords / initial_prompt config field (Idea #6 from STT analysis)
  - Source: WhisperLive + WhisperWriter
  - Low effort, high impact - just a config field passed to providers
  - Helps with technical terms (Kubernetes, Prometheus, etc.)
  - Implemented: `custom_words` now sent to providers (Deepgram keyterm, Voxtral context_bias, Groq prompt, ElevenLabs keyterms, 60db context)

- [ ] Implement continuous recording mode (Idea #4 from STT analysis)
  - Source: WhisperWriter (GPLv3 - must reimplement, not copy code)
  - 4 modes: Hold to Record, Press to Toggle, Voice Activity, Continuous
  - Continuous mode: press once, auto-transcribes during natural speech pauses

## E2E Testing

- [ ] optimize e2e test so that it takes less time

## Future / Nice-to-have

- [ ] Wake word activation (Idea #5 from STT analysis)
  - Source: RealtimeSTT (MIT license)
  - High complexity, lower impact for most users
  - Good for accessibility / hands-busy workflows
