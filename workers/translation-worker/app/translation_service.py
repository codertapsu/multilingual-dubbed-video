"""Translation orchestration: per-segment translation with glossary handling.

This layer sits between the HTTP routes and the pluggable
:class:`~app.providers.TranslationBackend`. Responsibilities:

* Reduce request language codes to Argos base subtags (``to_argos_language``),
  honoring the vi-VI -> vi-VN normalization.
* Translate **each segment separately** (never concatenated) so subtitle timing
  stays 1:1 with the source.
* Preserve segment **ids and order** exactly.
* Apply the glossary **PRE-protect** / **POST-restore** passes around each
  segment's translation.
* Surface a structured ``TRANSLATION_PACKAGE_MISSING`` error when the requested
  language pair is not installed.

The active backend is process-global and overridable
(:func:`set_backend`) so tests can inject a fake backend without Argos packages.
"""

from __future__ import annotations

import logging
import threading

from .errors import AppErrorException
from .glossary import apply_glossary_post, apply_glossary_pre
from .lang import to_argos_language
from .providers import ArgosBackend, TranslationBackend
from .schemas import (
    LanguagePair,
    LanguagesResponse,
    ResultSegment,
    Segment,
    TranslateResponse,
)

logger = logging.getLogger("translation_worker.service")

# Process-global backend, lazily created. Guarded so concurrent requests don't
# race on first construction.
_backend: TranslationBackend | None = None
_backend_lock = threading.Lock()


def get_backend() -> TranslationBackend:
    """Return the active translation backend, creating the default if needed."""
    global _backend
    if _backend is None:
        with _backend_lock:
            if _backend is None:
                _backend = ArgosBackend()
    return _backend


def set_backend(backend: TranslationBackend | None) -> None:
    """Override (or reset, with ``None``) the active backend.

    Primarily for tests: inject a fake backend so the service runs without any
    Argos packages installed.
    """
    global _backend
    with _backend_lock:
        _backend = backend


def _dedupe_pairs(pairs: list[tuple[str, str]]) -> list[LanguagePair]:
    """De-duplicate and stably sort ``(from, to)`` pairs into LanguagePair models."""
    seen: set[tuple[str, str]] = set()
    out: list[LanguagePair] = []
    for from_code, to_code in sorted(pairs):
        key = (from_code, to_code)
        if key in seen:
            continue
        seen.add(key)
        out.append(LanguagePair(**{"from": from_code, "to": to_code}))
    return out


def list_languages() -> LanguagesResponse:
    """Build the ``GET /languages`` payload from the active backend."""
    backend = get_backend()
    installed = _dedupe_pairs(backend.installed_pairs())
    available = _dedupe_pairs(backend.available_pairs())
    return LanguagesResponse(installed=installed, available=available)


def installed_pair_count() -> int:
    """Number of installed language pairs (for ``/health``). Never raises."""
    try:
        return len(get_backend().installed_pairs())
    except AppErrorException as exc:
        # Engine not installed yet — report 0 rather than failing the health probe.
        logger.warning("Could not enumerate installed pairs: %s", exc.error.message)
        return 0
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Unexpected error enumerating installed pairs: %s", exc)
        return 0


def translate_segments(
    source_language: str,
    target_language: str,
    segments: list[Segment],
    glossary: dict[str, str] | None = None,
) -> TranslateResponse:
    """Translate a batch of segments, preserving ids and order.

    Parameters
    ----------
    source_language, target_language:
        Language codes from the client (any casing / region). Reduced to Argos
        base subtags internally.
    segments:
        Ordered source segments.
    glossary:
        Optional source-term -> target-term map (see :mod:`app.glossary`).

    Returns
    -------
    TranslateResponse
        One :class:`ResultSegment` per input segment, in the same order.

    Raises
    ------
    AppErrorException
        ``INVALID_LANGUAGE`` if a code cannot be reduced to a base subtag;
        ``TRANSLATION_PACKAGE_MISSING`` if the pair is not installed.
    """
    from_lang = to_argos_language(source_language)
    to_lang = to_argos_language(target_language)

    if not from_lang or not to_lang:
        raise AppErrorException.make(
            code="INVALID_LANGUAGE",
            message=(
                f"Could not resolve a base language subtag from "
                f"source='{source_language}', target='{target_language}'."
            ),
            status_code=400,
            remediation="Provide BCP-47 codes such as 'en' / 'vi' (or 'en-US' / 'vi-VN').",
        )

    backend = get_backend()
    logger.info(
        "Translating %d segment(s): %s -> %s (backend=%s, glossary=%d terms)",
        len(segments),
        from_lang,
        to_lang,
        getattr(backend, "id", "?"),
        len(glossary) if glossary else 0,
    )

    results: list[ResultSegment] = []
    for segment in segments:
        # 1) PRE-protect glossary source terms with sentinels.
        protected = apply_glossary_pre(segment.sourceText, glossary)

        # 2) Translate this segment on its own (never merged with others).
        translated = backend.translate(protected, from_lang, to_lang)

        # 3) POST-restore sentinels to the desired target terms.
        finalized = apply_glossary_post(translated, glossary)

        results.append(ResultSegment(id=segment.id, translatedText=finalized))

    return TranslateResponse(segments=results)
