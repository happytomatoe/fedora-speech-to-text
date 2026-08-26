# Fedora speech to text

Convert speech to text for free by using free APIs or local models (Parakeet, Moonshine) on Fedora Gnome Wayland(Standard Fedora Workstation).

# Why choose this over alternatives:
Other repositories uh don't integrate natively with uh GNOME Wyaland because of compatibility issues [Handy](https://handy.computer) or they use ydotool. Ydotool is slower than alternatives:

| Output method | Average time (235 chars) | vs baseline (× slower) |
|--------------|---------------------------|------------------------|
| `mutter-commit` | **5.1 ms** | baseline |
| `mutter-virtual` | **174 ms** | ~34× slower |
| `type` (dotool) | **2,012 ms** | ~395× slower |
| `type` (ydotool) | **4,760 ms** | ~936× slower |

By using internal fedora API(mutter methods) we can higher throughput.

# Demo
<https://github.com/user-attachments/assets/a51d6826-e417-4e69-afd0-9ff40799d3a1>


# Providers

Cloud:

- Voxtral
- Groq
- Deepgram
- 60db
- ElevenLabs

Local:
- Parakeet
- Moonshine (streaming + batch, CPU-only)

This repo contains gnome extension and python application


## Requirements

- Python 3.13+
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- [Groq API key](https://console.groq.com/keys) OR [Voxtral API key](https://mistral.ai) OR [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys)
- Linux with `xclip`/`xsel` (X11) if you'll use clipboard functionality

## Installation

```bash
 curl -sSL https://raw.githubusercontent.com/happytomatoe/voice-to-text/refs/heads/main/install.sh | bash
```

If you want to use Parakeet check out [this script](./parakeet-v2.sh)

## How to use

- Press Super+W
- Dictate
- Press Super+W

## Configuration

### API Keys

You can provide API keys in three ways:

#### 1. Environment Variables (Default)

```bash
export VOXTRAL_API_KEY="your-api-key-here"
export DEEPGRAM_API_KEY="your-api-key-here"
export GROQ_API_KEY="your-api-key-here"
export SIXTYDB_API_KEY="your-api-key-here"
export ELEVENLABS_API_KEY="your-api-key-here"
```

#### 2. Configuration File

Put the keys in `~/.config/voice-to-text/config.yaml`:

```yaml
voxtral:
  api_key: "your-api-key-here"

deepgram:
  api_key: "your-api-key-here"
```

#### 3. Command Substitution (Recommended for Secret Managers)

If an API key starts with `!`, the rest is executed as a shell command and stdout is used as the key. This works with any secret manager (1Password, pass, secret-tool, custom scripts):

```yaml
# Example: 1Password
voxtral:
  api_key: "!op read 'op://Vault/Voxtral/key'"
```

```yaml
# Example: pass
voxtral:
  api_key: "!pass show voxtral/api-key"
```

```yaml
# Example: GNOME Keyring
voxtral:
  api_key: "!secret-tool lookup service voice-to-text username voxtral"
```

The command runs fresh each time the key is needed (no caching). Raises `ValueError` on timeout, non-zero exit, or empty output.

**Script requirements:** Output ONLY the key to stdout; all logs/errors to stderr.

#### 4. Async Command Substitution (For Fast Recording Start)

If an API key starts with `!!`, the command runs in the background while recording starts immediately. Use this when key resolution is slow (e.g., network calls to secret managers):

```yaml
# Recording starts immediately, key resolves in background
voxtral:
  api_key: "!!bash /path/to/get-key.sh"
```

**Benefits:**
- Recording starts in parallel with key resolution
- Reduces latency for slow key commands (e.g., 1Password, network secret managers)
- Falls back to synchronous behavior if key is already cached

#### Reload keys

```bash
# Stop the service — it will auto-restart on next use with fresh keys
just service-stop
```

### Other Settings

Edit [`config.yaml`](./config.yaml) to customize if you are using python app or right click on microphone icon->Preferences if you are using gnome extension

## Output Methods

Configure via `output-method` in preferences or `config.yaml`:

| Method | How it works | Requirements |
|--------|--------------|--------------|
| `type` | Types via dotool (keystroke simulation) | dotoolc running |
| `mutter-virtual` | Char-by-char typing via GNOME Shell virtual keyboard | GNOME extension |
| `mutter-commit` | Commits text via `Main.inputMethod.commit()` — bypasses clipboard and keystroke simulation | GNOME extension |

## Attribution

- The diff-based incremental typing algorithm in [`gnome-ext/typer.js`](./gnome-ext/typer.js) is inspired by [nerd-dictation](https://github.com/ideasman42/nerd-dictation)

## License

MIT
