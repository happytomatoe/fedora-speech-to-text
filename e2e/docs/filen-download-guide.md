# Filen Download Guide for E2E Golden Image

## Quick Download

**Direct Link:** *(will be added after Filen upload)*

```bash
# Download using filen CLI (after user uploads)
cd e2e/qemu-images
filen download /golden-gnome-deps.qcow2 .
```

## What's in the Image

- Fedora 44 + GNOME Shell
- GDM with auto-login configured
- gnome-terminal, ghostty, dotool
- Python packages (httpx, dbus-next, numpy, etc.)
- uv package manager

## Using the Downloaded Image

```bash
# The E2E test will auto-detect golden-gnome-deps.qcow2
cd e2e && bun run e2e.ts

# For faster subsequent runs (51% faster), use snapshot mode
cd e2e && bun run e2e.ts --snapshot
```

## Notes

- File size: ~2.2GB
- Filen provides end-to-end encryption
- Free tier: 10GB storage
