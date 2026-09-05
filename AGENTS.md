# Agent instructions for voice-to-text

## Python imports

- All imports must be at the module level (top of file), never inside functions or methods.
- Local imports inside functions cause `NameError` when module-level functions reference those names.

## Project overview

Voice-to-text converts speech to text on Linux using free cloud/local APIs. It is a two-part project:

- **Python service** (`src/voice_to_text/`): the transcription engine, audio capture, providers, and a D-Bus service that the GNOME extension calls.
- **GNOME Shell extension** (`gnome-ext/`): JS UI (indicator, hotkey, preferences, typer) that talks to the D-Bus service.

Transcription providers: cloud (Voxtral, Groq, Deepgram, 60db, ElevenLabs) and local (Parakeet). API keys come from env vars, `config.yaml`, or command substitution (`!command`).

## Output Methods

The engine supports three output methods (configured via `output-method` in preferences):

| Method | Class | How it works |
| -------- | ------- | -------------- |
| `type` | `DotoolTyper` | Dotool Type — Types via dotool (requires dotoolc) |
| `mutter-virtual` | `MutterVirtualTyper` | Mutter Type — Char-by-char typing via GNOME extension D-Bus (virtual keyboard) |
| `mutter-commit` | `MutterVirtualPaster` | Mutter Commit — Commits text via `Main.inputMethod.commit()` — bypasses clipboard and keystroke simulation entirely |

### Adding/Removing Output Methods

When adding or removing an output method, update ALL of these files:

1. `src/voice_to_text/engine.py` — handle the new method in the output method switch
2. `gnome-ext/prefs/provider-row.js` — add to `createOutputMethodRow()` combo box
3. `gnome-ext/schemas/*.xml` — update allowed values if needed
4. Run `just check-output-methods-sync` to verify (also runs in `just lint`)

## Layout

- `src/voice_to_text/` — Python package (engine, audio, config, dbus_service, debug, hybrid, postprocess, profiling, typer, vad, providers/).
- `gnome-ext/` — GNOME Shell extension (plain JS, no build step needed).
- `tests/` — pytest suite (mirrors `src/` modules).
- `service/` — D-Bus service definition.
- `scripts/` — dev/setup helpers.
- `docs/` — design notes.
- `opensrc/` — Cloned open source repos for API reference (gitignored). See `opensrc/README.md`.
  - GNOME Shell `gnome-50` branch for inspecting `Main.inputMethod` and other internal APIs.

## Tooling

- Package + environment manager: **uv** (see `pyproject.toml`). Build backend: hatchling.
- Task runner: **just** (see `justfile`). Key recipes:
  - `just test` — run the test suite (`uv run pytest -n auto`).
  - `just run <args>` — run the CLI with `PYTHONPATH=src`.
  - `just service-run` — run the D-Bus service in the foreground.
  - `just service-install` / `service-uninstall` — install/uninstall the user D-Bus service.
  - `just gnome-ext-dev` — install extension and run nested GNOME Shell
- Python version: **3.13+** (`requires-python`).

## Linting and type checking

- **ruff** for lint/format: `ruff check .`, `ruff format .` (line-length 120, py313).
- **pyright** for types: `pyright .`.
- **oxlint** for GNOME extension JS linting (see `.oxlintrc.json`): `npx oxlint gnome-ext/`.
- **knip** for unused JS/TS exports/deps: `bunx knip` (config: `knip.json`).
- **vulture** for Python dead code (pre-push): `uv run vulture src/ --min-confidence 80`.
- **aislop** for AI-slop/code-quality gate: `aislop scan` (pinned 0.15.0; config: `.aislop/config.yml`). Not in hooks — run manually or in CI.
- **lefthook** is configured (see `lefthook.yml`); run `lefthook run pre-commit` or `just setup` to install hooks.

## GNOME Extension Development

When modifying files in `gnome-ext/`:

1. **Quick check** — verify extension loads without errors (exits with failure if errors found):

   ```sh
      just gnome-ext-check
   ```

2. **Lint** — run JS linting:

   ```sh
   npx oxlint gnome-ext/   # or specific file
   ```

3. **Visual testing** — if you need to see the UI:
   - E2E tests: `just e2e-fedora-local` (runs in QEMU VM with `--snapshot` for visual regression)

### E2E / Snapshot tests

See `e2e/AGENTS.md` for detailed instructions.

**Key commands:**

- Update references: `just qemu-e2e-update-ts` or `cd e2e && bun run e2e.ts --update`
- Run snapshot tests: `cd e2e && bun run e2e.ts --snapshot`
- Run full E2E (full VM boot): `just e2e-fedora-local` (or `just e2e-ubuntu-local`/`just e2e-ubuntu-ci`) — `cd e2e && bun run e2e.ts`

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
