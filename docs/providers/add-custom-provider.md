# How to Add a Custom Provider (Template Guide)

This guide walks through adding a brand-new speech-to-text provider using the
`template` provider type — config only, no code changes. It's written so a human
or a coding agent can follow it unattended using only the server's API docs and
the verification commands built into this project.

## Step 1 — Read the target server's API docs

Identify from the server's documentation:

1. **Endpoint URL** — the full URL to POST audio to
   (e.g. `http://localhost:8080/v1/audio/transcriptions`).
2. **Auth scheme** — Bearer token? Custom header? None?
3. **Required request fields** — model name field? Language? Any vendor-specific
   parameters (hotwords, punctuation, …)? Are they form fields or JSON?
4. **Response shape** — where does the transcript text live in the response JSON?
   (e.g. `{"text": "..."}` → `text`; `{"result": {"transcript": "..."}}` →
   `result.transcript`)

Servers that speak the OpenAI Whisper contract (`POST /v1/audio/transcriptions`,
multipart `file` + `model`, `{"text": "..."}` response) need no adaptation —
see the first example below.

## Step 2 — Write the config block

Add a section to `~/.config/voice-to-text/config.yaml` (or the repo's
`config.yaml` for development).

**Example A — OpenAI-shaped server (CrispASR with hotwords):**

```yaml
crispasr:
  type: template
  endpoint: http://localhost/speech-to-text/v1/audio/transcriptions
  model: whisper-1
  headers:
    Authorization: "Bearer {{ API_KEY }}"        # omitted entirely if no api_key below
  form:
    model: "{{ MODEL }}"
    hotwords: "{{ CUSTOM_WORDS | join(', ') }}"  # GNOME custom words → hotwords field
    hotwords_boost: "2.0"
    beam_size: "2"
  api_key: ""                                    # or api_key_env: MY_SERVER_KEY
  response_text_path: text
  timeout: 120
```

**Example B — vendor with a custom auth header and array field:**

```yaml
my-vendor:
  type: template
  endpoint: https://api.vendor.example/recognize
  model: vendor-large
  headers:
    X-Api-Key: "{{ API_KEY }}"
  form:
    model_id: "{{ MODEL }}"
  json:
    keyterms: "{{ CUSTOM_WORDS }}"     # list → repeated multipart keys
    language: "{{ LANGUAGE }}"
  api_key_env: VENDOR_API_KEY
  response_text_path: result.transcript
```

Context variables available in templates: `API_KEY`, `LANGUAGE`,
`CUSTOM_WORDS` (list), `MODEL`. Full reference:
[template.md](template.md).

## Step 3 — Validate: `just config-check`

```sh
just config-check
```

Catches missing keys and Jinja syntax errors before anything runs. Expect
`config OK`. If it reports findings for your section, fix them first.

## Step 4 — Dry-run: `just provider-test <name>`

```sh
just provider-test crispasr
```

Prints the exact request blueprint with sample context (`Sample, Hotword` as
custom words). Compare it against the server's API docs:

- URL and method correct?
- Auth header present (or correctly absent) with the right value shape?
- Field names match the docs exactly (`hotwords` vs `hot_words` vs `keywords`)?
- Array values rendered as expected?

API-key-derived values are masked (`Bearer ****`) in dry-run output. Iterate:
edit config → rerun → compare. `--words "a,b"` and `--language de` override the
sample context.

## Step 5 — Live test: `--send --audio`

```sh
just provider-test crispasr --send --audio /path/to/test.wav
```

Performs the real request. Verify:

- Status 200 and sensible transcript text.
- If the response extraction fails, the error includes a snippet of the actual
  response — adjust `response_text_path` accordingly and retry.
- `--send` without `--audio` (or with a nonexistent file) exits with a usage
  error instead of sending anything.

## Step 6 — Enable it

```yaml
# config.yaml
transcription:
  provider: crispasr    # your section name
```

## Step 7 — GNOME side

1. Open the extension preferences → **Transcription Provider** — your provider
   appears as `<name> (custom)`.
2. Add custom words in preferences — they flow into `{{ CUSTOM_WORDS }}` on
   every request.

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| `config-check`: `missing 'endpoint'` | Add the `endpoint` key (full URL). |
| `config-check`: `template error in form.<k>` | Jinja syntax error in that template — check block closure (`{% endif %}`, quotes). |
| `provider-test`: header missing | Its template references `API_KEY` but no key is configured → set `api_key`/`api_key_env`, or the header is intentionally omitted. |
| `--send`: HTTP 401/403 | Auth header wrong or key invalid — verify header name and scheme against the API docs. |
| `--send`: `response_text_path '...' not found in response: {...}` | Wrong dotted path — copy the correct path from the response snippet shown in the error. |
| Hotwords not affecting results | Field name mismatch — compare the dry-run blueprint against the server's docs/logs. |
| Extra fields ignored by server | Vendor doesn't support them — harmless, but remove to keep requests minimal. |
