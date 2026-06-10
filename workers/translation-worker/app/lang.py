"""Language-code normalization — Python mirror of the shared TS utilities.

These rules MUST stay byte-for-byte consistent with
``packages/shared/src/lang.ts`` so that codes produced by the UI/orchestrator
round-trip correctly through this worker.

Rules
-----
normalize_language_code(code)
    * Trim whitespace.
    * Lowercase the base subtag; uppercase a 2-letter region subtag
      (e.g. "EN" -> "en", "vi-vn" -> "vi-VN").
    * Special case: "vi-VI" (any case) -> "vi-VN". The standard Vietnamese
      locale is "vi-VN"; "vi-VI" is a common mistake.

to_argos_language(code)
    * Base language subtag only, lowercased (e.g. "vi-VN" -> "vi",
      "en-US" -> "en"). Argos packages are keyed by ISO-639-1 base codes.
"""

from __future__ import annotations


def normalize_language_code(code: str | None) -> str:
    """Normalize a BCP-47-ish language code to canonical casing.

    Examples
    --------
    >>> normalize_language_code("EN")
    'en'
    >>> normalize_language_code("vi-vn")
    'vi-VN'
    >>> normalize_language_code("VI-VI")
    'vi-VN'
    >>> normalize_language_code(" en-us ")
    'en-US'
    """
    if not code:
        return ""

    trimmed = code.strip()
    if not trimmed:
        return ""

    # Split on the first hyphen/underscore into base + region (ignore extra parts).
    parts = trimmed.replace("_", "-").split("-")
    base = parts[0].lower()

    if len(parts) == 1:
        return base

    region_raw = parts[1]
    # Canonical region casing: 2-letter -> UPPER (country), else as-is upper.
    region = region_raw.upper()

    # Special rule: Vietnamese standard locale is vi-VN; "vi-VI" is wrong.
    if base == "vi" and region == "VI":
        region = "VN"

    return f"{base}-{region}"


def to_argos_language(code: str | None) -> str:
    """Reduce a language code to the base subtag Argos uses (lowercased).

    Applies :func:`normalize_language_code` first so the vi-VI -> vi-VN fix is
    honored before the region subtag is dropped.

    Examples
    --------
    >>> to_argos_language("vi-VN")
    'vi'
    >>> to_argos_language("en-US")
    'en'
    >>> to_argos_language("VI-VI")
    'vi'
    """
    normalized = normalize_language_code(code)
    if not normalized:
        return ""
    return normalized.split("-")[0].lower()


# Alias kept for parity with the STT worker's ``to_whisper_language`` helper;
# Argos and Whisper both want the lowercased base subtag, so it's the same op.
to_whisper_language = to_argos_language
