# Filen Download Guide for E2E Golden Image

## Quick Download

**Direct Link:** [golden-gnome-deps.qcow2](https://mega.nz/#!HpgWTYrS!XkQxF5V1TbOfcre2GM7BAb_Zkj-YYCVK2Xci_2YQl9Q)

```bash
# Download using megatools
cd e2e/qemu-images
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools dl https://mega.nz/#!HpgWTYrS!XkQxF5V1TbOfcre2GM7BAb_Zkj-YYCVK2Xci_2YQl9Q -u $MEGA_USER -p $MEGA_PASSWORD'
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
