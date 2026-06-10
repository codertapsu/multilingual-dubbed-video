"""Language-code normalization for the STT worker.

These helpers MUST stay behaviourally identical to the TypeScript
``normalizeLanguageCode`` / ``toWhisperLanguage`` helpers in
``@videodubber/shared`` so the same language string round-trips consistently
across the whole pipeline.

Rules
-----
``normalize_language(code)``
    * Trim surrounding whitespace.
    * Fix casing: the base subtag is lowercased, an optional region subtag is
      uppercased, an optional script subtag is title-cased.
        - ``"EN"``     -> ``"en"``
        - ``"vi-vn"``  -> ``"vi-VN"``
        - ``"zh-hant"``-> ``"zh-Hant"``
    * Special rule: ``"vi-VI"`` (in ANY casing) MUST become ``"vi-VN"``.
      The standard Vietnamese locale is ``vi-VN``.

``to_whisper_language(code)``
    * Reduce to the base language subtag only, lowercased.
        - ``"vi-VN"`` -> ``"vi"``
        - ``"en-US"`` -> ``"en"``
    * Returns ``None`` for empty / falsy input so callers can let Whisper
      auto-detect the language.
"""

from __future__ import annotations

from typing import Optional

__all__ = ["normalize_language", "to_whisper_language"]


def _split_subtags(code: str) -> list[str]:
    """Split a BCP-47-ish tag on ``-`` or ``_`` into non-empty subtags."""
    # Accept both hyphen and underscore separators (e.g. ``en_US``).
    raw = code.replace("_", "-")
    return [part for part in raw.split("-") if part]


def normalize_language(code: Optional[str]) -> str:
    """Normalize a language code's casing and apply the vi-VI special rule.

    Returns an empty string for ``None`` / blank input (mirrors the TS helper,
    which preserves an "auto detect" sentinel as empty).
    """
    if not code:
        return ""

    parts = _split_subtags(code.strip())
    if not parts:
        return ""

    # Base subtag is always lowercased.
    base = parts[0].lower()
    normalized = [base]

    for part in parts[1:]:
        if len(part) == 4 and part.isalpha():
            # Script subtag, e.g. "Hant" / "Latn" -> Title case.
            normalized.append(part[:1].upper() + part[1:].lower())
        elif len(part) in (2, 3) and part.isalpha():
            # Region subtag, e.g. "us" -> "US" / "gbr" -> "GBR" (matches the TS
            # normalizeLanguageCode rule: uppercase 2-3 letter alpha regions).
            normalized.append(part.upper())
        elif len(part) == 3 and part.isdigit():
            # UN M.49 numeric region code, kept as-is.
            normalized.append(part)
        else:
            # Variant / unknown subtag: lowercase to keep things deterministic.
            normalized.append(part.lower())

    result = "-".join(normalized)

    # Special rule: vi-VI (any case) -> vi-VN. After normalization above the
    # value would be "vi-VI"; rewrite the region to the standard VN locale.
    if result.lower() == "vi-vi":
        return "vi-VN"

    return result


def to_whisper_language(code: Optional[str]) -> Optional[str]:
    """Reduce a language code to the base subtag Whisper expects.

    ``"vi-VN"`` -> ``"vi"``, ``"en-US"`` -> ``"en"``. Returns ``None`` for
    empty input so the caller can let faster-whisper auto-detect.
    """
    normalized = normalize_language(code)
    if not normalized:
        return None
    base = _split_subtags(normalized)[0].lower()
    return base or None
