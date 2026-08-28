# Fedora speech to text

Convert speech to text for free by using free APIs or local models (Parakeet, Moonshine) on Fedora.


# Why choose this over alternatives

Other repositories don't integrate natively with GNOME Wayland because of compatibility issues or they use ydotool. Ydotool is slower than alternatives:

| Output method | Average time (235 chars) | vs baseline (× slower) |
|--------------|---------------------------|------------------------|
| `mutter-commit` | **5.1 ms** | baseline |
| `mutter-virtual` | **174 ms** | ~34× slower |
| `type` (dotool) | **2,012 ms** | ~395× slower |
| `type` (ydotool) | **4,760 ms** | ~936× slower |

By using internal fedora API (mutter methods) we can higher throughput.

# Demo

<https://github.com/user-attachments/assets/95bd743b-4af4-4329-b6d2-b3b3b979d45a>

## Installation

```bash
 curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/happytomatoe/voice-to-text/refs/heads/main/install.sh | bash
```
## Configuration
<img width="324" height="108" alt="Screenshot From 2026-08-26 10-37-33" src="https://github.com/user-attachments/assets/7d2a59e3-2597-4d8c-a11f-1ca9513d8226" />

Right click on icon to see preferences

## How to use

- Set custom hotkey or use press Super+W to start recording 
- Dictate
- Press hotkey to stop recording

# Providers

Cloud:

- Voxtral
- Groq
- Deepgram
- 60db
- ElevenLabs

Local:
- Parakeet. You can install it in podman container using [this script](./parakeet-v2.sh)
- Moonshine (streaming + batch, CPU-only)

## Requirements

- Python 3.13+
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- API Key if you would use cloud api

### API Keys

You can provide API keys using next:

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

Edit [`config.yaml`](./config.yaml)

## Attribution

- The diff-based incremental typing algorithm in [`gnome-ext/typer.js`](./gnome-ext/typer.js) is inspired by [nerd-dictation](https://github.com/ideasman42/nerd-dictation)

## Alternatives 
- [Speed of sound](https://flathub.org/en/apps/io.speedofsound.SpeedOfSound)

## License

MIT
