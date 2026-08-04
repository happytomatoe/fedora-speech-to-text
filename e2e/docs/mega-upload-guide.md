# MEGA Upload/Download Guide for E2E Golden Image

## Prerequisites

- megatools installed in toolbox: `toolbox run --container fedora-toolbox-44 -- sudo dnf install -y megatools`
- MEGA account with credentials set in fish shell

## Environment Variables (Fish Shell)

```fish
# Set in fish shell (persistent)
set -gx MEGA_USER your@email.com
set -gx MEGA_PASSWORD yourpassword
```

## Upload Golden Image

```bash
# Upload to MEGA
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools put /var/home/l/git/voice-to-text/e2e/qemu-images/golden-gnome.qcow2 / -u $MEGA_USER -p $MEGA_PASSWORD'

# Upload to specific folder
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools mkdir /E2E-Images'
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools put /var/home/l/git/voice-to-text/e2e/qemu-images/golden-gnome.qcow2 /E2E-Images/ -u $MEGA_USER -p $MEGA_PASSWORD'
```

## Download Golden Image

```bash
# Download from MEGA
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools get /golden-gnome.qcow2 /var/home/l/git/voice-to-text/e2e/qemu-images/ -u $MEGA_USER -p $MEGA_PASSWORD'

# Download from specific folder
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools get /E2E-Images/golden-gnome.qcow2 /var/home/l/git/voice-to-text/e2e/qemu-images/ -u $MEGA_USER -p $MEGA_PASSWORD'
```

## List Files

```bash
# List all files
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools ls / -u $MEGA_USER -p $MEGA_PASSWORD'

# List with details
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools ls -l / -u $MEGA_USER -p $MEGA_PASSWORD'
```

## Check Storage

```bash
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools df -h -u $MEGA_USER -p $MEGA_PASSWORD'
```

## Delete File

```bash
toolbox run --container fedora-toolbox-44 -- fish -c 'megatools rm /golden-gnome.qcow2 -u $MEGA_USER -p $MEGA_PASSWORD'
```

## Notes

- MEGA free tier: 20 GB storage
- Upload speed: ~500 KB/s - 1 MB/s (varies)
- Download limit: 1-5 GB per 6 hours (free tier)
- File size limit: Unlimited
- Encryption: End-to-end (zero-knowledge)
