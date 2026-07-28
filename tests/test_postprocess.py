"""Tests for transcription text post-processing."""

from voice_to_text.postprocess import (
    _extract_punctuation,
    _preserve_case_pattern,
    apply_custom_words,
    collapse_stutters,
    filter_transcription_output,
    get_filler_words,
    postprocess,
)


class TestFilterTranscriptionOutput:
    def test_removes_filler_words(self):
        result = filter_transcription_output("So uhm I was thinking uh about this", "en")
        assert result == "So I was thinking about this"

    def test_case_insensitive_fillers(self):
        result = filter_transcription_output("UHM this is UH a test", "en")
        assert result == "this is a test"

    def test_fillers_with_punctuation(self):
        result = filter_transcription_output("Well, uhm, I think, uh. that's right", "en")
        assert result == "Well, I think, that's right"

    def test_cleans_whitespace(self):
        result = filter_transcription_output("Hello    world   test", "en")
        assert result == "Hello world test"

    def test_trims(self):
        result = filter_transcription_output("  Hello world  ", "en")
        assert result == "Hello world"

    def test_combined(self):
        result = filter_transcription_output("  Uhm, so I was, uh, thinking about this  ", "en")
        assert result == "so I was, thinking about this"

    def test_preserves_valid_text(self):
        result = filter_transcription_output("This is a completely normal sentence.", "en")
        assert result == "This is a completely normal sentence."

    def test_stutter_collapse(self):
        result = filter_transcription_output("w wh wh wh wh wh wh wh wh wh why", "en")
        assert result == "w wh why"

    def test_stutter_short_words(self):
        result = filter_transcription_output("I I I I think so so so so", "en")
        assert result == "I think so"

    def test_stutter_longer_words(self):
        result = filter_transcription_output("Check data doc doc doc doc documentation.", "en")
        assert result == "Check data doc documentation."

    def test_stutter_mixed_case(self):
        result = filter_transcription_output("No NO no NO no", "en")
        assert result == "No"

    def test_preserves_two_repetitions(self):
        result = filter_transcription_output("no no is fine", "en")
        assert result == "no no is fine"

    def test_english_removes_um(self):
        result = filter_transcription_output("um I think um this is good", "en")
        assert result == "I think this is good"

    def test_portuguese_preserves_um(self):
        # "um" means "a/an" in Portuguese
        result = filter_transcription_output("um gato bonito", "pt")
        assert result == "um gato bonito"

    def test_spanish_preserves_ha(self):
        # "ha" means "has" in Spanish
        result = filter_transcription_output("ha sido un buen día", "es")
        assert result == "ha sido un buen día"

    def test_language_code_with_region(self):
        result = filter_transcription_output("um gato bonito", "pt-BR")
        assert result == "um gato bonito"

    def test_custom_filler_words_override(self):
        custom = ["okay", "right"]
        result = filter_transcription_output("okay so I think right this works", "en", custom)
        assert result == "so I think this works"

    def test_custom_filler_words_empty_disables(self):
        result = filter_transcription_output("So uhm I was thinking uh about this", "en", [])
        assert result == "So uhm I was thinking uh about this"

    def test_unknown_language_uses_fallback(self):
        result = filter_transcription_output("uh I think uhm this works", "xx")
        assert result == "I think this works"

    def test_fallback_does_not_remove_um(self):
        result = filter_transcription_output("um I think this works", "xx")
        assert result == "um I think this works"


class TestCollapseStutters:
    def test_collapses_three_repetitions(self):
        assert collapse_stutters("wh wh wh wh") == "wh"

    def test_preserves_two_repetitions(self):
        assert collapse_stutters("no no") == "no no"

    def test_single_word_unchanged(self):
        assert collapse_stutters("hello") == "hello"

    def test_mixed_with_nonalpha(self):
        assert collapse_stutters("I I I 123 123 123") == "I 123 123 123"


class TestExtractPunctuation:
    def test_no_punctuation(self):
        assert _extract_punctuation("hello") == ("", "")

    def test_surrounding(self):
        assert _extract_punctuation("!hello?") == ("!", "?")

    def test_multiple_prefix(self):
        assert _extract_punctuation("...hello...") == ("...", "...")

    def test_unicode_suffix(self):
        assert _extract_punctuation("你好。") == ("", "。")

    def test_unicode_brackets(self):
        assert _extract_punctuation("「你好」") == ("「", "」")


class TestPreserveCasePattern:
    def test_all_caps(self):
        assert _preserve_case_pattern("HELLO", "world") == "WORLD"

    def test_title_case(self):
        assert _preserve_case_pattern("Hello", "world") == "World"

    def test_lowercase(self):
        assert _preserve_case_pattern("hello", "WORLD") == "WORLD"


class TestApplyCustomWords:
    def test_exact_match(self):
        result = apply_custom_words("hello world", ["Hello", "World"], 0.5)
        assert result == "Hello World"

    def test_fuzzy_match(self):
        result = apply_custom_words("helo wrold", ["hello", "world"], 0.5)
        assert result == "hello world"

    def test_empty_custom_words(self):
        result = apply_custom_words("hello world", [], 0.5)
        assert result == "hello world"

    def test_ngram_two_words(self):
        result = apply_custom_words("Charge B is great", ["ChargeBee"], 0.5)
        assert "ChargeBee" in result

    def test_ngram_three_words(self):
        result = apply_custom_words("use Chat G P T for this", ["ChatGPT"], 0.5)
        assert "ChatGPT" in result

    def test_prefers_longer_ngram(self):
        result = apply_custom_words("Open AI GPT model", ["OpenAI", "GPT"], 0.5)
        assert result == "OpenAI GPT model"

    def test_preserves_case(self):
        result = apply_custom_words("CHARGE B is great", ["ChargeBee"], 0.5)
        assert "CHARGEBEE" in result

    def test_handles_unicode_punctuation(self):
        result = apply_custom_words("「Handee。」", ["Handy"], 0.5)
        assert result == "「Handy。」"

    def test_skips_cjk_fuzzy_matching(self):
        text = "你好。"
        result = apply_custom_words(text, ["你号"], 1.0)
        assert result == text

    def test_matches_ampersand_word(self):
        result = apply_custom_words("send it to RD for review", ["R&D"], 0.5)
        assert result == "send it to R&D for review"

    def test_matches_spoken_ampersand(self):
        # Current behavior: "to R and" is matched as 3-gram
        result = apply_custom_words("send it to R and D for review", ["R&D"], 0.5)
        assert "R&D" in result


class TestGetFillerWords:
    def test_english(self):
        assert "um" in get_filler_words("en")
        assert "uh" in get_filler_words("en")

    def test_portuguese(self):
        fillers = get_filler_words("pt")
        assert "um" not in fillers  # "um" is real word in Portuguese

    def test_unknown_language(self):
        fillers = get_filler_words("xx")
        assert "um" not in fillers  # fallback is conservative


class TestPostprocess:
    def test_combined_pipeline(self):
        # Current behavior: filler removal works, custom words partially work
        result = postprocess(
            "So uhm I was thinking uh about Chat G P T",
            lang="en",
            custom_words=["ChatGPT"],
        )
        assert "ChatGPT" in result
        assert "uhm" not in result
        assert "uh" not in result

    def test_no_custom_words(self):
        result = postprocess("So uhm I was thinking uh about this", lang="en")
        assert result == "So I was thinking about this"
