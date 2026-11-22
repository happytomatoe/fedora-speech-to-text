# 0008 — Configuration discovery, merging and validation

- Status: Accepted
- Date: 2026-11-22

## Context

`ConfigManager` serves both the service and the `config_check` CLI. Its fallbacks are deliberately
quiet, which is right for the service and wrong for validation; several merge and discovery rules
are not visible from the code.

## Decisions

### 1. Discovery order and the explicit-path escape hatch

Default discovery tries, in order: `~/.config/voice-to-text/config.yaml`, the package parent,
the package directory, then the repository root, and keeps the first path that exists. An
explicitly passed path is used as given, even when it is not the user config path (tests rely on
this with temporary paths).

`save()` redirects writes to `~/.config/voice-to-text/config.yaml` when the manager
auto-discovered a checked-in repository config, so running the service from a checkout never
rewrites the repository's `config.yaml`. Explicit paths are not redirected.

### 2. Provider config overrides global transcription config

`get_provider_config()` merges the `transcription` section with the provider's own section, and
the provider section wins on conflicting keys. This lets global settings provide defaults while a
provider can override any of them.

### 3. The service tolerates a broken config; validation must not

`ConfigManager` turns YAML parse errors and a missing file into an empty config so the service can
start. `config_check` therefore parses the raw YAML itself before asking the manager: otherwise a
syntactically broken file would be reported as "config OK".

`config_check` also removes `api_key`/`api_key_env` before instantiating a custom provider,
because `resolve_api_key` executes `!command` substitutions and a dry validation must never run a
shell command.

A selected provider with no section is only an error when it is neither a built-in provider (which
works from environment variables alone) nor a validated template section. A misspelled selected
provider must still be reported.

## Consequences

Discovery precedence is part of the user-facing contract: a repository checkout must not shadow
the user's file, and `VOICE_TO_TEXT_CONFIG` must win over everything (see `config_check`).
