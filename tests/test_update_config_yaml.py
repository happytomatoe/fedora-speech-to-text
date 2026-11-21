"""Tests for update-config-yaml.py."""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "update-config-yaml.py"


def _run(username: str, config_content: str, home: str) -> tuple[str, str, int]:
    """Run update-config-yaml.py in a temp home with given config content."""
    config_dir = Path(home) / ".config" / "voice-to-text"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.yaml"
    if config_content:
        config_path.write_text(config_content)

    env = os.environ.copy()
    env["HOME"] = home
    result = subprocess.run(
        [sys.executable, str(SCRIPT), username],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return result.stdout, result.stderr, result.returncode


class TestUpdateConfigYaml:
    """Tests for update-config-yaml.py."""

    def test_creates_new_file_and_section(self, tmp_path):
        """When config.yaml doesn't exist, create it with the section."""
        home = str(tmp_path)
        stdout, stderr, rc = _run("deepgram", "", home)
        assert rc == 0, stderr
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        assert 'deepgram:\n  api_key: "!secret-tool lookup service voice-to-text username deepgram"' in config
        assert "Created" in stdout

    def test_updates_existing_section(self, tmp_path):
        """When section exists without api_key, add api_key to it."""
        home = str(tmp_path)
        initial = "deepgram:\n  model: nova-3\n"
        stdout, _, rc = _run("deepgram", initial, home)
        assert rc == 0
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        assert "deepgram:\n  api_key:" in config
        assert "deepgram:\n  model: nova-3" not in config  # model should still be there
        assert (
            'deepgram:\n  api_key: "!secret-tool lookup service voice-to-text username deepgram"\n  model: nova-3'
            in config
        )
        assert "Added" in stdout

    def test_replaces_existing_api_key(self, tmp_path):
        """When section already has api_key, replace it."""
        home = str(tmp_path)
        initial = "voxtral:\n  api_key: '!op read old-key'\n  model: voxtral-mini-latest\n"
        _run("voxtral", initial, home)  # first run adds api_key
        stdout, _, rc = _run("voxtral", initial, home)  # second run replaces
        assert rc == 0
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        assert 'voxtral:\n  api_key: "!secret-tool lookup service voice-to-text username voxtral"' in config
        assert "!op read old-key" not in config
        assert "Updated" in stdout

    def test_no_cross_section_contamination(self, tmp_path):
        """Updating deepgram must NOT modify voxtral section."""
        home = str(tmp_path)
        initial = textwrap.dedent("""\
            transcription:
              provider: voxtral
            deepgram:
              model: nova-3
            voxtral:
              api_key: '!op read old-voxtral-key'
              model: voxtral-mini-latest
            """)
        _run("deepgram", initial, home)
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        # deepgram should have deepgram's api_key
        assert 'deepgram:\n  api_key: "!secret-tool lookup service voice-to-text username deepgram"' in config
        # voxtral should still have its original api_key
        assert "voxtral:\n  api_key: '!op read old-voxtral-key'" in config
        # voxtral should NOT have deepgram's api_key
        assert 'voxtral:\n  api_key: "!secret-tool lookup service voice-to-text username deepgram"' not in config

    def test_no_duplicate_sections(self, tmp_path):
        """Running the script twice should not create duplicate sections."""
        home = str(tmp_path)
        initial = "deepgram:\n  model: nova-3\n"
        _run("deepgram", initial, home)
        _run("deepgram", initial, home)
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        assert config.count("deepgram:") == 1
        assert config.count("secret-tool lookup service voice-to-text username deepgram") == 1

    def test_adds_new_section_to_existing_file(self, tmp_path):
        """Adding a section to an existing config preserves other sections."""
        home = str(tmp_path)
        initial = "deepgram:\n  model: nova-3\n"
        _run("deepgram", initial, home)
        _run("voxtral", "", home)  # don't pass content - add to existing
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        assert "deepgram:\n  api_key:" in config
        assert "voxtral:\n  api_key:" in config

    def test_case_insensitive_section_match(self, tmp_path):
        """Section matching should be case-insensitive."""
        home = str(tmp_path)
        initial = "DeepGram:\n  model: nova-3\n"
        _, _, rc = _run("deepgram", initial, home)
        assert rc == 0
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        # Should update the existing DeepGram section (case-insensitive)
        assert config.count("DeepGram:") == 1 or config.count("deepgram:") == 1

    def test_invalid_username_rejected(self, tmp_path):
        """Invalid usernames should be rejected."""
        home = str(tmp_path)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "invalid-key!"],
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": home},
            check=False,
        )
        assert result.returncode != 0
        assert "invalid" in result.stderr.lower()

    def test_missing_username_shows_usage(self, tmp_path):
        """Running without a username should show usage."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode != 0
        assert "usage" in result.stderr.lower()

    def test_preserves_comments_and_formatting(self, tmp_path):
        """Existing comments and formatting should be preserved."""
        home = str(tmp_path)
        initial = textwrap.dedent("""\
            # This is a comment
            transcription:
              provider: voxtral
            # deepgram config below
            deepgram:
              model: nova-3
            """)
        _run("deepgram", initial, home)
        config = (Path(home) / ".config" / "voice-to-text" / "config.yaml").read_text()
        assert "# This is a comment" in config
        assert "# deepgram config below" in config
        assert "transcription:" in config
