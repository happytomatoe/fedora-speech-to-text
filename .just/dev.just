run *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.__main__ {{ args }}

# @category dev
# Dry-run a template provider's request blueprint (or --send --audio <path>)
provider-test *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.provider_test {{ args }}

# @category dev
# Validate config.yaml (dry — no network, no key resolution)
config-check *args:
    PYTHONPATH=src .venv/bin/python -m voice_to_text.config_check {{ args }}

download-open-src:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p opensrc
    if [ ! -d opensrc/gnome-shell ]; then
      echo "Cloning GNOME Shell (gnome-48 branch)..."
      git clone --depth 1 --branch gnome-48 https://gitlab.gnome.org/GNOME/gnome-shell.git opensrc/gnome-shell
    else
      echo "opensrc/gnome-shell already exists, skipping."
    fi

# Query AT-SPI accessibility tree in the nested GNOME Shell

# Clone open-source repos for API reference (GNOME Shell, etc.)

test:
    uv run pytest -n auto

# @category lint
# Run all linters (Python + GNOME extension)
test-all: test

