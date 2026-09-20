# Template Provider — Define a Custom Provider in config.yaml

The `batch_custom` provider type lets you define a custom speech-to-text provider
entirely in `config.yaml` — no Python changes. The HTTP request is described as a
Jinja2-templated blueprint, rendered fresh for every transcription.

This page is both the reference and the step-by-step guide.

## Config schema

```yaml
<provider-name>:
  type: batch_custom
  endpoint: http://host:port/v1/audio/transcriptions   # required, full URL
  headers:                    # optional; values are templates
    Authorization: "Bearer {{ API_KEY }}"
  form:                       # multipart form fields; values render as strings
    model: "whisper-1"
    hotwords: "{{ CUSTOM_WORDS | join(', ') }}"
    hotwords_boost: "2.0"
  json:                       # extra body fields; template values render to native types (list → repeated fields)
    keyterms: "{{ CUSTOM_WORDS }}"     # list → repeated multipart keys
  response_text_path: text    # dotted path to the transcript in the JSON response (default: text); see "Response extraction"
  variables:                  # optional; custom scalar values exposed to templates
    BEAM_SIZE: 4
  api_key: "..."              # or api_key_env: NAME; supports !command; exposed as API_KEY
```

At least one of `form` or `json` is required — the audio file itself is
uploaded as the multipart `file` part, so `form`/`json` is how you attach
everything else the server expects (model name, language, vendor options, …).

The HTTP request timeout is fixed at 120 seconds; the overall stop/transcribe
deadline is the engine's `stop_timeout` (GNOME preferences →
"stop-timeout-seconds", default 120). Note that `config-check` rejects a
`timeout` key in a custom provider section — that setting was removed.

**`response_text_path`** tells the provider where the transcript text lives in
the server's JSON response. It is a dotted path, and *you* supply the whole
path — nothing is hardcoded. For example, a response of
`{"text": "hello"}` needs `text`; `{"result": {"transcript": "hello"}}` needs
`result.transcript`; `{"segments": [{"text": "hello"}]}` needs
`segments.0.text` (integers index into lists). If the path doesn't match, the
error message shows a snippet of the actual response so you can correct it.

## Context variables

These variables are available in every template (`headers`, `form`, `json`):

| Variable | Type | Value |
|---|---|---|
| `API_KEY` | str | Resolved API key, or `""` if none configured |
| `LANGUAGE` | str | Request language code (e.g. `en`) |
| `CUSTOM_WORDS` | list[str] | Custom words from GNOME prefs / config; may be empty |
| *your own* | any | Any key you define under `variables:` (see below) |

### Custom variables (`variables:`)

Beyond the three built-in variables, you can define any number of custom
variables under `variables:` and reference them anywhere in the blueprint
(`endpoint`, `headers`, `form`, `json`) — so values shared by several fields
are declared once instead of being duplicated:

```yaml
my-provider:
  type: batch_custom
  endpoint: "http://{{ HOST }}:{{ PORT }}/v1/audio/transcriptions"
  variables:
    HOST: 192.168.1.50
    PORT: 5092
  form:
    model: whisper-large-v3
```

Rules:

- Values must be scalars (string, number, or boolean). Use a list in the
  `json` section directly if you need repeated keys.
- Names must not shadow the built-in variables (`API_KEY`, `LANGUAGE`,
  `CUSTOM_WORDS`) — the config check reports this as an error **for the
  provider you are currently validating** (i.e. the selected one); shadowing
  in other, unselected sections may pass config-check and only fail at
  runtime.
- Values are plain literals; they are not themselves rendered as templates.

Everything else is plain [Jinja2](https://jinja.palletsprojects.com/en/stable/templates/) — use built-in filters (`join`, `default`, …),
conditionals (`{% if %}`), etc. No custom filters exist. Full syntax reference:
the [Jinja Template Designer Documentation](https://jinja.palletsprojects.com/en/stable/templates/).

## Body styles

Audio is always uploaded as a multipart file part (`file`). Because of that,
**both `form` and `json` fields are sent as multipart form fields**, not as a
raw JSON body. In practice:

- `form` values are always rendered as strings (e.g. `"2.0"`, `"en"`).
- `json` values render to **native Python types** — a template that produces a
  list is sent as repeated multipart keys (e.g. `keyterms=alpha&keyterms=beta`),
  the standard way arrays are carried in `multipart/form-data`.

So even though the key is called `json`, nothing is sent as a JSON document —
it is a way to say "this value may not be a plain string".

## Auth headers

Headers whose templates reference `API_KEY` while no key is configured are
**omitted entirely** (instead of sending an invalid `Authorization: Bearer `).
When a key is configured, it resolves through the standard mechanism:
`api_key_env` env var, `api_key` config value, or `!command` substitution.

## Response extraction

The response must be JSON. It is walked along the `response_text_path` you
provide (dotted segments; integer segments index lists, e.g. `segments.0.text`).
The path is entirely user-supplied — the provider hardcodes nothing about the
response shape. A miss raises an error that includes a snippet of the actual
response body so you can correct the path.

## Multiple custom providers

You can define any number of named sections with `type: batch_custom` in
`config.yaml` (`crispasr:`, `openai-local:`, `weird-vendor:`, …). Each is an
independent provider; select one with `transcription.provider: <name>`. They
also appear in the GNOME preferences provider dropdown as "<name> (custom)"
entries.

## Testing your template

```sh
just provider-test <name>                          # dry-run: print the rendered blueprint
just provider-test <name> --custom-words "ROCm,K8s"  # override CUSTOM_WORDS
just provider-test <name> --language de            # override LANGUAGE
just provider-test <name> --api-key sk-...         # override API_KEY (masked in output)
just provider-test <name> --var BEAM_SIZE=4        # override any variables: entry (repeatable)
just provider-test <name> --send --audio test.wav  # real request against the endpoint
just config-check                                  # validate all configs (dry)
```

The dry-run masks API-key-derived values (`Bearer ****`).

## Step-by-step: adding a new provider

### Step 1 — Read the target server's API docs

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

### Step 2 — Write the config block

Add a section to `~/.config/voice-to-text/config.yaml` (or the repo's
`config.yaml` for development).

**Example A — OpenAI-shaped server (CrispASR with hotwords):**

```yaml
crispasr:
  type: batch_custom
  endpoint: http://localhost/speech-to-text/v1/audio/transcriptions
  headers:
    Authorization: "Bearer {{ API_KEY }}"        # omitted entirely if no api_key below
  form:
    model: "whisper-1"
    hotwords: "{{ CUSTOM_WORDS | join(', ') }}"  # GNOME custom words → hotwords field
    hotwords_boost: "2.0"
    beam_size: "2"
  api_key: ""                                    # or api_key_env: MY_SERVER_KEY
  response_text_path: text
```

**Example B — vendor with a custom auth header and array field:**

```yaml
my-vendor:
  type: batch_custom
  endpoint: https://api.vendor.example/recognize
  headers:
    X-Api-Key: "{{ API_KEY }}"
  form:
    model_id: vendor-large
  json:
    keyterms: "{{ CUSTOM_WORDS }}"     # list → repeated multipart keys
    language: "{{ LANGUAGE }}"
  api_key_env: VENDOR_API_KEY
  response_text_path: result.transcript
```

### Step 3 — Validate: `just config-check`

```sh
just config-check
```

Catches missing keys and Jinja syntax errors before anything runs. Expect
`config OK`. If it reports findings for your section, fix them first.

### Step 4 — Dry-run: `just provider-test <name>`

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
edit config → rerun → compare. Every template context variable can be
overridden from the CLI: `--custom-words "a,b"` (CUSTOM_WORDS),
`--language de` (LANGUAGE), `--api-key sk-...` (API_KEY), and `--var NAME=VALUE`
for anything defined under `variables:`.

### Step 5 — Live test: `--send --audio`

```sh
just provider-test crispasr --send --audio /path/to/test.wav
```

Performs the real request. Verify:

- Status 200 and sensible transcript text.
- If the response extraction fails, the error includes a snippet of the actual
  response — adjust `response_text_path` accordingly and retry.
- `--send` without `--audio` (or with a nonexistent file) exits with a usage
  error instead of sending anything.

### Step 6 — Enable it

```yaml
# config.yaml
transcription:
  provider: crispasr    # your section name
```

### Step 7 — GNOME side

1. Open the extension preferences → **Transcription Provider** — your provider
   appears as `<name> (custom)`.
2. Add custom words in preferences — they flow into `{{ CUSTOM_WORDS }}` on
   every request.
