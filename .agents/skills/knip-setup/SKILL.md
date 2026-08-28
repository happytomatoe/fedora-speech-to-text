# Knip Setup for voice-to-text

Setup and run [knip](https://knip.dev) — unused files/exports/dependencies detector for the TS/JS parts of this repo.

## Scope (important)

- Knip covers **TypeScript (`e2e/`) and JavaScript (`gnome-ext/`)** only.
- **Python (`src/`, `tests/`) is NOT covered** by knip — it's a JS/TS ecosystem tool. Use `vulture` for Python dead code (not yet set up in this repo).
- GJS platform imports (`imports.gi.*`, `imports.resource.*`) in `gnome-ext/` are runtime GNOME modules, not npm packages — knip reports them as "unlisted dependencies". The config ignores the whole `gnome-ext/` directory for dependency analysis for this reason; don't remove that ignore.

## Run

```sh
bunx knip            # from repo root
bun add -d knip      # already done on feat/knip branch
```

## Config

`knip.json` at repo root. Key decisions baked in:

- `entry`: the three real entry points (`e2e/e2e.ts`, `gnome-ext/extension.js`, `gnome-ext/prefs.js`, `gnome-ext/type-text-service.js`)
- `ignoreDependencies`: all `@girs/*` type packages (GJS GIR type stubs, referenced only by types) + `ssh2` (lives in `e2e/package.json`, not root)
- `ignoreBinaries`: `convert`, `ffmpeg`, `compare`, `podman`, `ss` (host tools used via child_process)
- `ignore`: `gnome-ext/vendor/**` (vendored js-yaml) and `gnome-ext/**` (GJS platform imports)

If knip emits "Configuration hints" saying an ignore entry is unused, **remove it** — hints keep the config honest.

## Current findings (2026-08-28, branch feat/knip, base origin/main 52649d9)

### Real dead code — safe to delete
1. `e2e/lib/virsh.ts` — unused file (e2e moved from virsh to plain QEMU)
2. Unused exports in `e2e/lib/deploy-steps.ts`: `sshExec`, `rsyncToVm` has callers but... (see plan), `scpToVm`
3. Unused exports in `e2e/lib/tmux.ts`: `createSession`, `sendKeys`, `sendKey`, `capturePaneHistory`, `waitForText`
4. `PORT`/`ENDPOINT` in `e2e/lib/parakeet.ts` — check internal usage first (`ignoreExportsUsedInFile: true` may resolve)

## Verify

After any deletion: `cd e2e && bun run e2e.ts --help`-style smoke or full `just e2e` (slow, ~80s with snapshot restore). `bun build e2e/e2e.ts --target=bun` catches syntax breakage.
