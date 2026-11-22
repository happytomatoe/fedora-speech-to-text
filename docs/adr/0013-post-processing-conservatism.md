# 0013 — Deterministic post-processing is deliberately conservative

- Status: Accepted
- Date: 2026-11-22

## Context

`postprocess.py` cleans raw transcription output without an LLM. Filler-word removal and
stutter collapsing are destructive: they delete user speech, so a wrong match is a silent
content loss. The language of the transcription is known only from the configured language
code, and providers do not classify languages per utterance.

## Decisions

### 1. Unknown languages use a reduced fallback list

`FILLER_FALLBACK` omits `um`, `eh` and `ha`. Those tokens are filler in English but real
words in other languages (for example Polish `ha`, Spanish `eh`). A wrong language guess
must not delete a real word, so the fallback only contains tokens that are not words in any
supported language. Per-language lists may be more aggressive because the language is known.

### 2. Stutter collapse requires three or more identical words

`STUTTER_MIN_COUNT = 3`. Two identical consecutive words are preserved because doubling is
intentional emphasis in several languages ("no no is fine"). Only three or more identical
alphabetic words are collapsed to one.

### 3. Processing is order-independent and stateless

Filler removal runs before whitespace normalization on the whole text; stutter collapsing
operates on whitespace-separated words. Neither step depends on provider, model or
streaming mode, so batch and streaming results post-process identically.
