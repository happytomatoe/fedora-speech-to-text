"""Update voice-to-text config.yaml with a secret-tool lookup reference.

Used by store-api-keys.sh to add or update the api_key line for a provider
after the key has been stored in GNOME Keyring.

Usage:
    python3 scripts/update-config-yaml.py <username>

The script finds the provider section (case-insensitive match on the first
line starting with ``<username>:`) in ``~/.config/voice-to-text/config.yaml``
and adds or updates its ``api_key`` line with:

    api_key: "!secret-tool lookup service voice-to-text username <username>"

If the config file or provider section does not exist, it creates them.
All existing comments and formatting are preserved.
"""

import os
import re
import sys

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".config", "voice-to-text")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.yaml")


def update_config(username: str, config_path: str = CONFIG_PATH) -> None:
    """Add or update the api_key line for a provider section in config.yaml.

    Args:
        username: Provider name used as the YAML section key and keyring
            lookup username. Should be lowercase (e.g. ``"deepgram"``).
        config_path: Path to the config.yaml file.

    """
    api_line = f'  api_key: "!secret-tool lookup service voice-to-text username {username}"'

    if not os.path.exists(config_path):
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        with open(config_path, "w") as f:
            f.write(f"{username}:\n{api_line}\n")
        print(f"Created {config_path} with {username} section")
        return

    with open(config_path) as f:
        lines = f.readlines()

    # Find provider section (case-insensitive)
    section_idx = None
    for i, line in enumerate(lines):
        if re.match(rf"^{username}:", line, re.IGNORECASE):
            section_idx = i
            break

    action: str
    if section_idx is not None:
        # Check if api_key already exists in this section
        # (stop at next top-level section — lines not starting with whitespace)
        section_updated = False
        for j in range(section_idx + 1, len(lines)):
            if lines[j] and not lines[j][0].isspace():
                break  # next section starts
            if lines[j].startswith("  api_key:"):
                lines[j] = api_line + "\n"
                section_updated = True
                break
        if not section_updated:
            lines.insert(section_idx + 1, api_line + "\n")
        action = "Updated" if section_updated else "Added"
    else:
        # Append new section at end
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append(f"\n{username}:\n")
        lines.append(api_line + "\n")
        action = "Added"

    with open(config_path, "w") as f:
        f.writelines(lines)
    print(f"{action} {username} section in {config_path}")


MIN_ARGS = 2


def main() -> None:
    """Parse CLI arguments and update config.yaml for the given provider."""
    if len(sys.argv) < MIN_ARGS:
        print("Usage: python3 update-config-yaml.py <username>", file=sys.stderr)
        sys.exit(1)

    username = sys.argv[1]
    if not re.match(r"^[a-zA-Z0-9_]+$", username):
        print(
            f"Error: invalid username '{username}' — use only letters, numbers, underscores",
            file=sys.stderr,
        )
        sys.exit(1)

    update_config(username)


if __name__ == "__main__":
    main()
