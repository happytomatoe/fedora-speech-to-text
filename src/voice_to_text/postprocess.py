"""Transcription text post-processing.

Deterministic cleanup of transcription output: filler word removal,
stutter collapsing, and fuzzy custom word correction. No LLM dependency.

Ported from Handy (src-tauri/src/audio_toolkit/text.rs).
"""

import re

import jellyfish
from rapidfuzz import fuzz

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

            if count >= 3:
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


# ── Custom word correction ───────────────────────────────────────


def _build_match_key(word: str) -> str:
    """Lowercase, strip non-alphanumeric, concatenate."""
    return "".join(c.lower() for c in word if c.isalnum())


def _is_supported_fuzzy_key(key: str) -> bool:
    """True if key is non-empty and ASCII alphanumeric only."""
    return bool(key) and all(c.isascii() and c.isalnum() for c in key)


def _supports_soundex(key: str) -> bool:
    """True if key is non-empty and ASCII alphabetic only."""
    return bool(key) and all(c.isascii() and c.isalpha() for c in key)


def _soundex(word: str) -> str | None:
    """Compute Soundex code via jellyfish. Returns None for non-ASCII."""
    if not _supports_soundex(word):
        return None
    return jellyfish.soundex(word)


def _extract_punctuation(word: str) -> tuple[str, str]:
    """Extract leading and trailing punctuation from a word.

    Uses char indices for correct Unicode handling.
    """
    chars = list(word)

    prefix_end = 0
    for i, c in enumerate(chars):
        if c.isalnum():
            prefix_end = i
            break
    else:
        return (word, "")

    suffix_start = len(chars)
    for i in range(len(chars) - 1, -1, -1):
        if chars[i].isalnum():
            suffix_start = i + 1
            break

    prefix = "".join(chars[:prefix_end])
    suffix = "".join(chars[suffix_start:])
    return (prefix, suffix)


def _preserve_case_pattern(original: str, replacement: str) -> str:
    """Apply the original's case pattern to the replacement."""
    if original.isupper():
        return replacement.upper()
    elif original and original[0].isupper():
        return replacement[0].upper() + replacement[1:] if replacement else replacement
    return replacement


def _find_best_match(  # noqa: S3776 - fuzzy matching logic
    candidate: str,
    custom_words: list[str],
    custom_keys: list[tuple[int, str]],
    threshold: float,
) -> tuple[str, float] | None:
    """Find the best matching custom word for a candidate string.

    Uses Levenshtein distance + optional Soundex phonetic boost.
    """
    if not _is_supported_fuzzy_key(candidate) or len(candidate) > 50:
        return None

    best_match: str | None = None
    best_score = -1.0

    for word_idx, key in custom_keys:
        candidate_len = len(candidate)
        key_len = len(key)
        len_diff = abs(candidate_len - key_len)
        # Stricter length filter: reject if candidate is >50% longer than key
        if candidate_len > key_len * 1.5:
            continue
        # Also reject if key is much shorter (e.g. 2-char key matching 4-char candidate)
        if key_len < 3 and len_diff > 1:
            continue
        # Reject very short candidates (< 3 chars) unless exact match
        if candidate_len < 3 and candidate != key:
            continue

        # Levenshtein ratio via rapidfuzz (0.0-100.0 scale, convert to 0.0-1.0)
        lev_score = fuzz.ratio(candidate, key) / 100.0

        # Soundex phonetic match — boost score for phonetically similar words
        c_soundex = _supports_soundex(candidate) and _soundex(candidate)
        k_soundex = _supports_soundex(key) and _soundex(key)
        phonetic_match = bool(c_soundex and k_soundex and c_soundex == k_soundex)

        combined_score = lev_score * 1.5 if phonetic_match else lev_score

        if combined_score > threshold and combined_score > best_score:
            best_match = custom_words[word_idx]
            best_score = combined_score

    return (best_match, best_score) if best_match is not None else None


def apply_custom_words(  # noqa: S3776 - n-gram matching logic
    text: str,
    custom_words: list[str],
    threshold: float = 0.5,
) -> str:
    """Apply fuzzy custom word corrections to transcribed text.

    Matches 1-grams, 2-grams, and 3-grams against the custom word list
    using Levenshtein distance + Soundex phonetic matching.

    Args:
        text: Input text to correct.
        custom_words: List of words to match against.
        threshold: Maximum score to accept (0.0 = exact, 1.0 = any).
    """
    if not custom_words:
        return text

    # Pre-compute normalized keys
    custom_keys: list[tuple[int, str]] = []
    for i, word in enumerate(custom_words):
        key = _build_match_key(word)
        if _is_supported_fuzzy_key(key):
            custom_keys.append((i, key))
        # Handle '&' expansion (e.g. "R&D" → "randd")
        if "&" in word:
            expanded = _build_match_key(word.replace("&", " and "))
            if _is_supported_fuzzy_key(expanded) and expanded != key:
                custom_keys.append((i, expanded))

    words = text.split()
    result: list[str] = []
    i = 0

    while i < len(words):
        best_match: tuple[int, str, float, float] | None = None  # (n, replacement, score, adjusted_score)

        # Try 4-gram, 3-gram, 2-gram, 1-gram (longest first)
        for n in range(min(4, len(words) - i), 0, -1):
            ngram_words = words[i : i + n]

            # Don't cross punctuation boundaries
            if n > 1 and any(_extract_punctuation(w)[1] for w in ngram_words[:-1]):
                continue

            ngram_key = "".join(_build_match_key(w) for w in ngram_words)

            match = _find_best_match(ngram_key, custom_words, custom_keys, threshold)
            if match:
                replacement, score = match
                # Prefer matches where first word starts with same letter as custom word
                first_word_key = _build_match_key(ngram_words[0])
                replacement_key = _build_match_key(replacement)
                has_matching_first_letter = (
                    first_word_key and replacement_key and first_word_key[0] == replacement_key[0]
                )
                first_letter_bonus = 0.3 if has_matching_first_letter else 0.0
                adjusted_score = score + first_letter_bonus
                if best_match is None or adjusted_score > best_match[3]:
                    best_match = (n, replacement, score, adjusted_score)

        if best_match:
            n, replacement, _, _ = best_match
            ngram_words = words[i : i + n]
            prefix, _ = _extract_punctuation(ngram_words[0])
            _, suffix = _extract_punctuation(ngram_words[-1])
            corrected = _preserve_case_pattern(ngram_words[0], replacement)
            result.append(f"{prefix}{corrected}{suffix}")
            i += n
        else:
            result.append(words[i])
            i += 1

    return " ".join(result)


# ── Convenience function ─────────────────────────────────────────


def postprocess(
    text: str,
    lang: str = "en",
    custom_words: list[str] | None = None,
    custom_words_threshold: float = 0.5,
    custom_filler_words: list[str] | None = None,
) -> str:
    """Apply all post-processing steps to transcription output.

    Order: filter_transcription_output → apply_custom_words.
    """
    text = filter_transcription_output(text, lang, custom_filler_words)
    if custom_words:
        text = apply_custom_words(text, custom_words, custom_words_threshold)
    return text
