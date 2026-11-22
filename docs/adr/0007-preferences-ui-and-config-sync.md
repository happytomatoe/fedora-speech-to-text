# 0007 — Preferences UI: widget timing, config sync and accessibility

- Status: Accepted
- Date: 2026-11-22

## Context

The preferences UI keeps `config.yaml` and GSettings in sync and is driven by AT-SPI-based E2E
tests. Its layout and write paths encode constraints that are not visible from the widget code.

## Decisions

### 1. The audio-level OSD is shown after a delay

The widget is created after `SHOW_DELAY_MS` (300 ms) instead of immediately, because audio levels
spike at stream start and an immediate widget visibly flashes. `hide()` must cancel the pending
timeout source.

### 2. The cancel button uses raw `Clutter.ActorAlign` values

`x_align: 2` and `y_align: 2` are the numeric values of `Clutter.ActorAlign.CENTER`. Clutter is
not imported in the widget module, so the raw enum values are intentional.

### 3. Bar colour tiers follow absolute segment position

Segment colours are chosen from `i / NUM_SEGMENTS`, not from the smoothed level, so the
green→yellow→red gradient always spans the whole bar as the level rises.

The provider label uses `currentcolor` rather than a fixed colour so it follows the shell theme
(dark text on a light theme, light text on a dark one).

### 4. `config.yaml` is written owner-only

- `Gio.File.replace_contents(..., REPLACE_DESTINATION)` recreates the file with umask
  permissions. Because the file can hold API keys, the previous mode is captured and re-applied
  after the replace, defaulting to `0600` for a new file.
- Before re-applying, group/other bits are masked off (`mode & 0o600`), so an existing `0644`
  config is tightened rather than preserved.
- `Gio.IOErrorEnum.NOT_FOUND` from `query_info` is the normal first run and keeps the `0600`
  default; only other stat errors produce a warning.

### 5. GSettings seeds from config only when the key was never set

`config.yaml` seeds a GSettings key only when `settings.get_user_value(key) === null`. An explicit
user value always wins, so opening the preferences window cannot overwrite a user's choice with
the file's value.

### 6. Custom words: storage order and display order differ

- New words are appended to the stored array (`[...existing, text]`); the stored order is the
  insertion order.
- The list is rendered by iterating the array backwards, so the most recently added word appears
  first.
- `createWordRow` calls `ref.populate()` and `populate` calls `createWordRow`; a mutable `ref`
  object assigned after the factory is defined breaks the definition cycle.
- The delete control is icon-only, so `update_property([Gtk.AccessibleProperty.LABEL], …)` is
  required for screen readers and for AT-SPI E2E targeting.
- GTK4 `Adw.ActionRow` exposes no AT-SPI actions, so the activatable "Add Word…" row carries a
  suffix `Gtk.Button` that performs the activation; both are wired to the same handler.

### 7. Config-defined providers are appended to the built-in list

Top-level sections with `type: batch_custom` in `config.yaml` are added after the built-ins. The
section name itself is the valid `transcription.provider` value, so selecting one selects that
provider; no mapping key exists. The `template` section is filtered out and entries are labelled
`name (custom)`.

### 8. Config-sync failures are surfaced by a dedicated row

A failed `syncToConfig` only sets `_configSyncFailed.v`; the user-facing feedback is the separate
"Configuration Drift" `syncWarningRow`. The failure handler must not add its own dialog or
notification.

### 9. Legacy output-method values are migrated

A persisted `output-method` outside `['mutter-commit', 'mutter-virtual', 'type']` is rewritten to
`'type'` (Dotool) so the combo box always has a valid selection.
