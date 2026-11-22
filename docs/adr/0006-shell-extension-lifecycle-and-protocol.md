# 0006 — Shell extension lifecycle and protocol

- Status: Accepted
- Date: 2026-11-22

## Context

The GNOME Shell extension outlives individual recordings and can be disabled and re-enabled at
any time. The service it talks to is a separate process that survives those cycles. Several
races and compatibility constraints were previously explained by comments.

## Decisions

### 1. State is resynchronised on every `enable()`

`enable()` calls `GetStatusAsync()` because the D-Bus service may already be `recording` or
`processing` when the extension is re-enabled. Assuming `idle` would desynchronise the panel
indicator and leak or skip the sleep inhibitor.

### 2. A status reply is applied only if its proxy is still current

The `GetStatusAsync()` promise can resolve after `disable()` or after a second `enable()`. The
result is applied only when `this._proxy === proxyRef`, the proxy captured when the call was
made. Otherwise the stale state is dropped.

### 3. Initial state sync is best effort

A failed initial `GetStatus` is logged and ignored: the extension stays usable and a later
`StateChanged` signal corrects the state. It is not surfaced as a notification.

### 4. Teardown disconnects signals tolerantly

`proxy.disconnectSignal(id)` may throw during teardown (signal already disconnected, proxy
destroyed). The failure is logged at `debug`/`warn` and swallowed so `disable()` can finish
disconnecting the remaining ids.

### 5. The sleep inhibitor uses flags `12`

`org.gnome.SessionManager.Inhibit` is called with `12`, the bitwise OR of `INHIBIT_SUSPEND` (4)
and `INHIBIT_IDLE` (8), per the interface's documented `InhibitedActions=12`. Do not "simplify"
it to a named constant from a different module or to a smaller value.

### 6. An inhibitor acquired after recording stops is released immediately

`InhibitAsync()` may resolve after recording stopped or after another cookie was already stored.
The returned cookie is then uninhibited immediately instead of being assigned, so a recording
never leaks a suspend/idle inhibitor.

### 7. Hotkey registration failures are rethrown

`registerHotkey()` logs the failing keybinding and rethrows; the caller owns the user-facing
notification. Swallowing the error would hide a registration failure behind a working-looking UI.

### 8. The spinner tolerates GNOME 46, intermediate and 48+ shells

`St.SpinnerContent` exists since GNOME 48; intermediate shells expose `St.Spinner`; GNOME 46 has
neither. `createSpinner()` falls back to a static `St.Icon`. The spinner is decorative, so E2E
assertions must not depend on it.

### 9. U+0008 in typed text means backspace

The engine's diff-correction emits a literal U+0008 character to request a backspace. The typing
service translates it into `Clutter.KEY_BackSpace` press/release pairs; it is never typed as text.

## Consequences

The extension's state machine is a mirrored view of the engine's. Any new engine state must be
handled in `GetStatus` resynchronisation and in `StateChanged`, or the panel can disagree with
the service.
