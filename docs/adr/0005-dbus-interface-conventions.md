# 0005 — D-Bus interface conventions

- Status: Accepted
- Date: 2026-11-22

## Context

The service exposes `com.happytomatoe.VoiceToText` on the session bus. dbus-next has two
non-obvious behaviours that shape the interface implementation.

## Decisions

### 1. Signals are emitted by calling the decorated method

In dbus-next a `@signal()`-decorated method's *return value* is the payload. The interface
therefore stashes the current value in a private attribute from an engine callback
(`_last_level`, `_last_error`, `_state`) and the signal method returns it. Emitting a signal is a
plain method call (`self.AudioLevel()`), not a separate emit API. Do not convert these to
properties or direct sends.

### 2. Preferences open in-process

`OpenPrefs` asks the extension to open its own preferences via
`Main.extensionManager.openExtensionPrefs()` instead of spawning `gnome-extensions prefs`. The
extension runs inside gnome-shell, so the in-process path works in headless sessions where a
D-Bus-activated child has no display and the CLI dies. The subprocess remains only as a fallback
for shells without `openExtensionPrefs`.

### 3. D-Bus method names keep their PascalCase and quoted signatures

Methods are named `StartRecording`, `GetStatus` and so on, and use string annotations such as
`"a(ss)"` because dbus-next reads the signature from the annotation. The `# noqa: N802` and
`# pyright: ignore[reportUndefinedVariable]` directives on those lines are required; renaming to
PEP 8 or dropping the quotes changes the wire interface.

## Consequences

The interface surface is a protocol, not an internal API. Changes to names, signatures or signal
semantics require a versioned decision.
