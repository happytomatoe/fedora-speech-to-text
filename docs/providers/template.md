# Template Provider Reference

The `template` provider type lets you define a custom speech-to-text provider
entirely in `config.yaml` — no Python changes. The HTTP request is described as a
Jinja2-templated blueprint, rendered fresh for every transcription.

For a step-by-step walkthrough, see [add-custom-provider.md](add-custom-provider.md).

## Config schema

```yaml
<provider-name>:
  type: template
  endpoint: http://host:port/v1/audio/transcriptions   # required, full URL
  headers:                    # optional; values are templates
    Authorization: "Bearer {{ API_KEY }}"
  form:                       # multipart form fields; values are templates → strings
    model: "{{ MODEL }}"
    hotwords: "{{ CUSTOM_WORDS | join(', ') }}"
    hotwords_boost: "2.0"
  json:                       # extra body fields; template values render to native types
    keyterms: "{{ CUSTOM_WORDS }}"     # list → repeated multipart keys
  response_text_path: text    # dotted path to the transcript in the JSON response (default: text)
  model: whisper-1            # exposed to templates as MODEL (not sent unless templated)
  api_key: "..."              # or api_key_env: NAME; supports !command; exposed as API_KEY
  timeout: 120                # seconds (default 120)
```

At least one of `form` or `json` is required.

## Context variables

The only "API" of the template system — these variables are available in every
template (`headers`, `form`, `json`):

| Variable | Type | Value |
|---|---|---|
| `API_KEY` | str | Resolved API key, or `""` if none configured |
| `LANGUAGE` | str | Request language code (e.g. `en`) |
| `CUSTOM_WORDS` | list[str] | Custom words from GNOME prefs / config; may be empty |
| `MODEL` | str | The `model` config value |

Everything else is plain Jinja2 — use built-in filters (`join`, `default`, …),
conditionals (`{% if %}`), etc. No custom filters exist.

## Body styles

Audio is always uploaded as a multipart file part (`file`). Because of that,
**both `form` and `json` fields are sent as multipart form fields**:

- `form` values render to strings.
- `json` values render to **native Python types** — a template producing a list
  becomes repeated multipart keys (`keyterms=a&keyterms=b` style), the standard
  way arrays are sent in multipart form data.

## Auth headers

Headers whose templates reference `API_KEY` while no key is configured are
**omitted entirely** (instead of sending an invalid `Authorization: Bearer `).
When a key is configured, it resolves through the standard mechanism:
`api_key_env` env var, `api_key` config value, or `!command` substitution.

## Response extraction

The response JSON is walked along `response_text_path` (dotted segments; integer
segments index lists, e.g. `segments.0.text`). A miss raises an error that
includes a snippet of the actual response body so you can correct the path.

## Multiple template providers

You can define any number of named sections with `type: template` in
`config.yaml` (`crispasr:`, `openai-local:`, `weird-vendor:`, …). Each is an
independent provider; select one with `transcription.provider: <name>`. They
also appear in the GNOME preferences provider dropdown as "<name> (custom)"
entries.

## Testing your template

```sh
just provider-test <name>                          # dry-run: print the rendered blueprint
just provider-test <name> --words "ROCm,K8s"       # override sample custom words
just provider-test <name> --language de            # override language
just provider-test <name> --send --audio test.wav  # real request against the endpoint
just config-check                                  # validate all configs (dry)
```

The dry-run masks API-key-derived values (`Bearer ****`).

## Worked example: CrispASR (local Parakeet)

```yaml
crispasr:
  type: template
  endpoint: http://localhost/speech-to-text/v1/audio/transcriptions
  model: whisper-1
  form:
    model: "{{ MODEL }}"
    hotwords: "{{ CUSTOM_WORDS | join(', ') }}"
    hotwords_boost: "2.0"
    beam_size: "2"
  response_text_path: text
```
