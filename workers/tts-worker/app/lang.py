"""Language-code normalization, mirroring packages/shared/normalizeLanguageCode.

The rules MUST stay consistent across the whole monorepo:

* Trim whitespace.
* Fix casing: language subtag lowercased, region subtag uppercased
  (e.g. "EN" -> "en", "vi-vn" -> "vi-VN").
* Special rule: "vi-VI" (in any case) normalizes to "vi-VN" — the Vietnamese
  standard locale is "vi-VN".
* Base-subtag reduction for engines: "vi-VN" -> "vi", "en-US" -> "en".
"""

from __future__ import annotations


def normalize_language_code(code: str | None) -> str:
    """Normalize a BCP-47-ish language code.

    Examples:
        "EN"      -> "en"
        "vi-vn"   -> "vi-VN"
        "vi-VI"   -> "vi-VN"   (special Vietnamese fix, any case)
        "en_us"   -> "en-US"   (underscore separators are accepted)
        ""        -> ""
    """
    if not code:
        return ""

    raw = code.strip()
    if not raw:
        return ""

    # Accept both "-" and "_" as subtag separators; emit "-".
    parts = raw.replace("_", "-").split("-")
    lang = parts[0].lower()

    if len(parts) == 1:
        return lang

    region = parts[1].upper()

    # Special case: Vietnamese "vi-VI" (any case) -> "vi-VN".
    if lang == "vi" and region == "VI":
        region = "VN"

    return f"{lang}-{region}"


def _base_subtag(code: str | None) -> str:
    """Return the lowercased base language subtag, after normalization."""
    normalized = normalize_language_code(code)
    if not normalized:
        return ""
    return normalized.split("-")[0].lower()


def to_whisper_language(code: str | None) -> str:
    """Reduce to the base subtag for Whisper, e.g. "vi-VN" -> "vi"."""
    return _base_subtag(code)


def to_argos_language(code: str | None) -> str:
    """Reduce to the base subtag for Argos Translate, e.g. "vi-VN" -> "vi"."""
    return _base_subtag(code)


def to_tts_language(code: str | None) -> str:
    """Reduce to the base subtag used to pick TTS voices/engines."""
    return _base_subtag(code)
