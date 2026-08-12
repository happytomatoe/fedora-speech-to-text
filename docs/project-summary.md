# voice-to-text

Voice-to-text is a Linux speech-to-text project that converts spoken audio into
text using free cloud or local APIs. It ships as two cooperating parts:

- **Python service** (`src/voice_to_text/`): the transcription engine, audio
  capture, provider integrations, and a D-Bus service that exposes the engine to
  the desktop.
- **GNOME Shell extension** (`gnome-ext/`): the JS UI (indicator, hotkey,
  preferences, and an auto-typer) that drives the D-Bus service.

API keys are resolved from environment variables, `config.yaml`, or command substitution (`!command` or `!!command`).

Lint/format via ruff, types via pyright.

## Transcription providers

| Provider   | Type  | Streaming |
|------------|-------|-----------|
| Moonshine  | local | ✅        |
| Parakeet   | local | ❌        |
| Voxtral    | cloud | ✅        |
| Deepgram   | cloud | ✅        |
| 60db       | cloud | ✅        |
| Groq       | cloud | ❌        |
| ElevenLabs | cloud | ❌        |
