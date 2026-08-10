"""Transcription text post-processing.

Deterministic cleanup of transcription output: filler word removal,
stutter collapsing. No LLM dependency.

Ported from Handy (src-tauri/src/audio_toolkit/text.rs).
"""

import re

# ── Filler word removal ──────────────────────────────────────────

FILLER_WORDS: dict[str, list[str]] = {
    "en": ["uh", "um", "uhm", "umm", "uhh", "uhhh", "ah", "hmm", "hm", "mmm", "mm", "mh", "eh", "ehh", "ha"],
    "es": ["ehm", "mmm", "hmm", "hm"],
    "pt": ["ahm", "hmm", "mmm", "hm"],
    "fr": ["euh", "hmm", "hm", "mmm"],
    "de": ["äh", "ähm", "hmm", "hm", "mmm"],
    "it": ["ehm", "hmm", "mmm", "hm"],
    "cs": ["ehm", "hmm", "mmm", "hm"],
    "pl": ["hmm", "mmm", "hm"],
    "tr": ["hmm", "mmm", "hm"],
    "ru": ["хм", "ммм", "hmm", "mmm"],
    "uk": ["хм", "ммм", "hmm", "mmm"],
    "ar": ["hmm", "mmm"],
    "ja": ["hmm", "mmm"],
    "ko": ["hmm", "mmm"],
    "vi": ["hmm", "mmm", "hm"],
    "zh": ["hmm", "mmm"],
}
# Conservative fallback — no "um", "eh", "ha" (real words in some languages)
FILLER_FALLBACK = ["uh", "uhm", "umm", "uhh", "uhhh", "ah", "hmm", "hm", "mmm", "mm", "mh", "ehh"]

# Minimum consecutive repetitions to collapse as stutter
STUTTER_MIN_COUNT = 3


def get_filler_words(lang: str) -> list[str]:
    """Return filler words for a language code (e.g. 'en', 'pt-BR')."""
    base = re.split(r"[-_]", lang)[0]
    return FILLER_WORDS.get(base, FILLER_FALLBACK)


# ── Stutter collapse ─────────────────────────────────────────────


def collapse_stutters(text: str) -> str:
    """Collapse 3+ consecutive identical words to one instance.

    "wh wh wh wh why" → "w wh why"
    "I I I I think" → "I think"
    "no no is fine" → "no no is fine"  (2 repetitions preserved)
    """
    words = text.split()
    if not words:
        return text

    result: list[str] = []
    i = 0
    while i < len(words):
        word = words[i]
        word_lower = word.lower()

        if word_lower.isalpha():
            count = 1
            while i + count < len(words) and words[i + count].lower() == word_lower:
                count += 1

            if count >= STUTTER_MIN_COUNT:
                result.append(word)
                i += count
            else:
                result.append(word)
                i += 1
        else:
            result.append(word)
            i += 1

    return " ".join(result)


_MULTI_SPACE = re.compile(r"\s{2,}")


def filter_transcription_output(
    text: str,
    lang: str,
    custom_filler_words: list[str] | None = None,
) -> str:
    """Remove filler words, collapse stutters, clean whitespace.

    Args:
        text: Raw transcription text.
        lang: Language code (e.g. "en", "pt-BR").
        custom_filler_words: Override filler list. None = language defaults.
            Empty list = disable filler removal.

    """
    if custom_filler_words is not None:
        patterns = [re.compile(rf"(?i)\b{re.escape(w)}\b[,.]?", re.IGNORECASE) for w in custom_filler_words]
    else:
        patterns = [re.compile(rf"(?i)\b{re.escape(w)}\b[,.]?", re.IGNORECASE) for w in get_filler_words(lang)]

    filtered = text
    for pat in patterns:
        filtered = pat.sub("", filtered)

    filtered = collapse_stutters(filtered)
    filtered = _MULTI_SPACE.sub(" ", filtered)
    return filtered.strip()


# ── Convenience function ─────────────────────────────────────────


def postprocess(
    text: str,
    lang: str = "en",
    custom_filler_words: list[str] | None = None,
) -> str:
    """Apply all post-processing steps to transcription output.

    Order: filter_transcription_output.
    """
    text = filter_transcription_output(text, lang, custom_filler_words)
    return text
