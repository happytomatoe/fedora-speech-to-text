# Agent instructions for voice-to-text

## Python imports

- All imports must be at the module level (top of file), never inside functions or methods.
- Local imports inside functions cause `NameError` when module-level functions reference those names.

## Project overview

Voice-to-text converts speech to text on Linux using free cloud/local APIs. It is a two-part project:

- **Python service** (`src/voice_to_text/`): the transcription engine, audio capture, providers, and a D-Bus service that the GNOME extension calls.
- **GNOME Shell extension** (`gnome-ext/`): JS UI (indicator, hotkey, preferences, typer) that talks to the D-Bus service.

Transcription providers: cloud (Voxtral, Groq, Deepgram, 60db, ElevenLabs) and local (Parakeet). API keys come from env vars, `config.yaml`, or command substitution (`!command`).

## Layout

- `src/voice_to_text/` — Python package (engine, audio, bluetooth, config, dbus_service, typer, providers/).
- `gnome-ext/` — GNOME Shell extension JS/JSON/CSS.
- `tests/` — pytest suite (mirrors `src/` modules).
- `service/` — D-Bus service definition.
- `scripts/` — dev/setup helpers.
- `docs/` — design notes.

## Tooling

- Package + environment manager: **uv** (see `pyproject.toml`). Build backend: hatchling.
- Task runner: **just** (see `justfile`). Key recipes:
  - `just test` — run the test suite (`uv run pytest -n auto`).
  - `just run <args>` — run the CLI with `PYTHONPATH=src`.
  - `just service-run` — run the D-Bus service in the foreground.
  - `just service-install` / `service-uninstall` — install/uninstall the user D-Bus service.
  - `just gnome-ext-dev` — install extension and launch a nested GNOME Shell for development.
- Python version: **3.13+** (`requires-python`).

## Linting and type checking

- **ruff** for lint/format: `ruff check .`, `ruff format .` (line-length 120, py313).
- **pyright** for types: `pyright .`.
- **pre-commit** is configured (see `.pre-commit-config.yaml`); run `pre-commit run --all-files`.

## Testing

- Tests use pytest with `pytest-asyncio` (auto mode) and `pytest-xdist` (`-n auto`).
- `testpaths = tests`, `pythonpath = src` (set in `pyproject.toml`).
- Run a single test file with `uv run pytest tests/test_audio.py`.

### E2E / Snapshot tests

See `tests/e2e/AGENTS.md` for detailed instructions.

E2E tests run in a containerized GNOME Shell (Xvfb + Podman) and capture screenshots for visual regression:

- `tests/e2e/snapshot.sh` — main script. Captures screenshots of desktop, preferences, recording state (with audio level), and transcription result.
- `tests/e2e/run-test.sh` — simpler visual regression runner (indicator + prefs).
- `tests/e2e/generate-references.sh` — generates baseline reference images.
- `tests/e2e/record-test.sh` — records a video of the full e2e flow.

**How screenshots work:**
1. Container runs GNOME Shell on Xvfb (`/opt/Xvfb_screen0` is the framebuffer).
2. Screenshots captured via: `podman cp <container>:/opt/Xvfb_screen0 - | tar xf - --to-command "convert xwd:- output.png"` (ImageMagick).
3. **Extension icon location**: The microphone/recording indicator is in the **top-right corner** of the GNOME top bar.
4. Audio level captured with crop: `convert xwd:- -crop 100x30+650+0 +repage output.png` (top-right panel area for extension indicator).
5. Comparison: `compare -metric MSE reference.png actual.png diff.png` — MSE < 100 = pass.

**Key commands:**
- Update references: `./tests/e2e/snapshot.sh --update`
- Run tests: `./tests/e2e/snapshot.sh`
- Requires: `DEEPGRAM_API_KEY` env var for transcription tests.

## Conventions

- Python imports stay at module level (see above).
- Match existing style; ruff/pyright must pass before committing.
- Commit messages follow Conventional Commits (the repo rejects `Co-Authored-By` trailers in pre-commit).

## Changelog

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Deprecated`, `### Fixed`, `### Removed`, `### Security`.

Rules:
- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

## Semantic Release

This project uses [python-semantic-release](https://python-semantic-release.readthedocs.io/) for automated versioning.

**How it works:**
- Every merge to `main` with conventional commits triggers automatic:
  - Version bump (based on commit types)
  - CHANGELOG.md update
  - Git tag creation (`vX.Y.Z`)
  - GitHub Release creation

**Version bump rules:**
- `feat:` → minor bump (0.x.0)
- `fix:`, `perf:` → patch bump (0.0.x)
- `feat!:` or `BREAKING CHANGE:` → major bump (x.0.0)
- `chore:`, `docs:`, `style:`, `refactor:`, `test:` → no bump

**Configuration:** `pyproject.toml` → `[tool.semantic_release]`
## JavaScript/TypeScript Error Handling (gnome-ext/)

- **Never leave catch blocks empty.** At minimum, log the error: `catch (e) { console.error(e); }`
- **If you must intentionally ignore an error**, add a comment explaining WHY it's safe:
  ```js
  try { await api.call(); } catch { /* ignore: best-effort notification */ }
  ```
- **Use `catch { }` (no parameter)** when intentionally ignoring — signals intent and avoids unused-variable lint errors.
- **Don't just swallow errors** — this makes debugging impossible and hides production failures.
- **Use `finally` for cleanup** (disconnect signals, close connections, release locks).
