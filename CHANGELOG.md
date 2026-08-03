# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`mutter-paste` output method** — Clipboard-based paste via GNOME Shell's `St.Clipboard` + `Shift+Insert`. Faster than `Mutter Type` in browsers because it avoids per-character keyboard event overhead. Uses D-Bus methods `SaveClipboard`, `PasteText`, `RestoreClipboard` from the GNOME extension.
- **Command substitution (`!command`) for API keys** — If an `api_key` value starts with `!`, the rest is executed as a shell command and stdout is used as the key. This enables integration with secret managers like 1Password, pass, or custom scripts.
  ```yaml
  # 1Password
  voxtral:
    api_key: "!op read 'op://Vault/Voxtral/key'"
  ```

  ```yaml
  # pass
  voxtral:
    api_key: "!pass show voxtral/api-key"
  ```

  ```yaml
  # GNOME Keyring
  voxtral:
    api_key: "!secret-tool lookup service mistral type api_key"
  ```
  - Supports shell pipes and quotes (`shell=True`)
  - 10-second timeout
  - Resolves after env vars and config file literals

### Changed
- Resolution order: environment variable → config file → command substitution
- Updated documentation with command substitution examples
- **Output method renamed**: `mutter-virtual` is now `Mutter Type` in preferences (no config change needed)
- **`clipboard` output method removed** — was dead code using `wl-copy`/`xclip`/`xsel` + `xdotool` and never worked

### Deprecated
- None

### Removed
- **`clipboard` output method** — unused dead code (`wl-copy`/`xclip`/`xsel` + `xdotool` Ctrl+V) that was never functional

### Fixed
- **E2E preferences screenshots now capture actual content** — GNOME 47 renders extension preferences in-process via Clutter, so `xwd` couldn't capture them. Fixed by using `org.gnome.Shell.Eval` → `Shell.Screenshot` from inside gnome-shell, which reads `global.stage` directly. Requires `--unsafe-mode` enabled via systemd drop-in on `org.gnome.Shell@x11.service`.
- **QEMU E2E prefs dialog close** — GNOME Shell modal prefs dialog doesn't respond to Alt+F4. Fixed by using `xdotool windowclose` on the specific window ID with retry loop and Escape fallback. Removed Super keypress that incorrectly toggled Activities overview.

### Security
- None

## [0.0.58] - 2026-07-23

### Fixed
- 401 debugging for Deepgram and 60db providers
- Improved API key debugging and error handling

## [0.0.57] - 2026-07-22

### Fixed
- Shell-freezing sync D-Bus calls in GNOME extension
- Missing flags argument in SessionManager Inhibit method
- Engine `_stop_timeout` AttributeError initialization
- Race condition in InhibitRemote success handler

### Changed
- Enforced Google JavaScript Style Guide in GNOME extension
- Promise-based InhibitRemote/UninhibitRemote for sleep inhibitor

## [0.0.56] - 2026-07-21

### Added
- Provider documentation links in README

### Changed
- Removed app-level Bluetooth profile switching

## [0.0.55] - 2026-07-20

### Fixed
- `--debug` flag in install script
- `LATEST_TAG` undefined variable in install script

## [0.0.54] - 2026-07-19

### Added
- `--debug` flag to install script

### Fixed
- Default `api_key_source` to keyring
- 60db key resolution

## [0.0.53] - 2026-07-18

### Fixed
- npm install step in eslint pre-commit hook

### Changed
- Applied CodeRabbit/cubic review fixes

## [0.0.52] - 2026-07-17

### Added
- JavaScript error handling guidelines to AGENTS.md

## [0.0.51] - 2026-07-16

### Fixed
- D-Bus `stop_timeout` config usage in `stop()` method

## [0.0.50] - 2026-07-15

### Added
- Empty catch justification in GNOME extension

### Changed
- Applied CodeRabbit/cubic review fixes

## [0.0.49] - 2026-07-14

### Fixed
- Keyring `api_key_source` default and 60db resolution

---

[Unreleased]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.58...HEAD
[0.0.58]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.57...v0.0.58
[0.0.57]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.56...v0.0.57
[0.0.56]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.55...v0.0.56
[0.0.55]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.54...v0.0.55
[0.0.54]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.53...v0.0.54
[0.0.53]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.52...v0.0.53
[0.0.52]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.51...v0.0.52
[0.0.51]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.50...v0.0.51
[0.0.50]: https://github.com/happytomatoe/voice-to-text/compare/v0.0.49...v0.0.50
[0.0.49]: https://github.com/happytomatoe/voice-to-text/releases/tag/v0.0.49
