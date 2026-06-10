"""Language normalization tests — must match the shared TS rules."""

from __future__ import annotations

import pytest

from app.lang import (
    normalize_language_code,
    to_argos_language,
    to_tts_language,
    to_whisper_language,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("EN", "en"),
        ("en", "en"),
        ("vi-vn", "vi-VN"),
        ("VI-VN", "vi-VN"),
        ("en_us", "en-US"),
        ("  en-US  ", "en-US"),
        ("", ""),
        (None, ""),
        # Special Vietnamese rule, any case:
        ("vi-VI", "vi-VN"),
        ("vi-vi", "vi-VN"),
        ("VI-vi", "vi-VN"),
    ],
)
def test_normalize_language_code(raw, expected):
    assert normalize_language_code(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("vi-VN", "vi"),
        ("en-US", "en"),
        ("vi-VI", "vi"),  # special-cased to vi-VN then reduced
        ("EN", "en"),
        ("", ""),
    ],
)
def test_base_subtag_reductions(raw, expected):
    assert to_whisper_language(raw) == expected
    assert to_argos_language(raw) == expected
    assert to_tts_language(raw) == expected
