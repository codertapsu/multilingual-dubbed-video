"""Tests for language-code normalization (must match shared TS rules)."""

from __future__ import annotations

import pytest

from app.lang import normalize_language_code, to_argos_language


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("EN", "en"),
        ("en", "en"),
        ("  en-us  ", "en-US"),
        ("en_US", "en-US"),
        ("vi-vn", "vi-VN"),
        ("VI-VN", "vi-VN"),
        # The special rule: vi-VI (any case) -> vi-VN.
        ("vi-VI", "vi-VN"),
        ("VI-VI", "vi-VN"),
        ("vi-vi", "vi-VN"),
        ("", ""),
        (None, ""),
    ],
)
def test_normalize_language_code(raw, expected) -> None:
    assert normalize_language_code(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("vi-VN", "vi"),
        ("en-US", "en"),
        ("VI-VI", "vi"),  # vi-VI -> vi-VN -> vi
        ("EN", "en"),
        ("vi", "vi"),
        ("", ""),
        (None, ""),
    ],
)
def test_to_argos_language(raw, expected) -> None:
    assert to_argos_language(raw) == expected
