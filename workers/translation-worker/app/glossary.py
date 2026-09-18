"""Glossary handling — enforce target terms via sentinel-token protection.

Approach (documented & intentionally simple)
---------------------------------------------
A glossary maps a *source* term to the exact *target* term the user wants in
the translation, e.g. ``{"VideoDubber": "VideoDubber", "CPU": "CPU"}`` (keep a
brand/acronym verbatim) or ``{"cat": "con mèo"}`` (force a specific rendering).

Naively pre-replacing the source term with the target term before translation
is wrong: the NMT model would then try to translate the *target* term again
(e.g. translating an English word that's already Vietnamese), producing
garbage. Instead we do:

1. **PRE-protect** — replace each glossary source term with an opaque sentinel
   token (``XQZ<n>``). We remember which sentinel maps to which desired target
   term (deterministically, from the glossary itself — no extra state).

2. **Translate** the protected text normally.

3. **VERIFY** — :func:`missing_sentinels` reports any sentinel the engine
   dropped, duplicated away or garbled. Callers that get a non-empty result
   must NOT ship that translation (see the incident below).

4. **POST-restore** — replace each sentinel with the glossary's *target* value.

Why the sentinel is plain ASCII (an incident, not a preference)
---------------------------------------------------------------
This module used to delimit sentinels with Unicode Private-Use-Area code points
(U+E000 / U+E001) on the theory that "the translation engine leaves them
untouched and never word-splits them". The real engine falsifies that. The PUA
code points are out-of-vocabulary for Argos' SentencePiece model, become unknown
tokens, and derail the decoder — it does not merely fail to protect the term, it
**deletes and hallucinates whole clauses**. Measured against the installed
en->vi Argos 1.11.0 package:

    source     : "VideoDubber runs on your CPU and never uploads your video."
    PUA-protect: "0 runs on your 1 and never uploads …"
    translated : "Không bao giờ đăng tải video của bạn."     <- first clause GONE

    source     : "The CPU is fast. VideoDubber is free."
    translated : "Máy bay phản lực 1 rất nhanh. Không có gì." <- "jet aircraft 1
                                                                 is fast. Nothing."

The unit tests did not catch it because the fake backend in ``tests/conftest.py``
was written to leave PUA tokens alone, i.e. it asserted the very assumption that
was wrong. ``tests/test_glossary_argos.py`` now runs the real round trip against
an installed Argos pair (skipped when absent).

``XQZ<n>`` survives the same model intact — it is in-vocabulary ASCII the
decoder copies verbatim — verified for en->vi and zh->vi (our primary pairs),
including repeated and multiple terms. It is still *verified* per request rather
than assumed: a different pair or a future engine may behave differently, and
:func:`missing_sentinels` is what turns that into a fallback instead of a silent
mistranslation.

Matching is **case-insensitive** and **whole-word** (regex word boundaries),
which is appropriate for Latin-script source languages.

Known limitations (documented on purpose)
------------------------------------------
* Whole-word boundaries (``\\b``) are weak for scripts without spaces (e.g.
  Chinese/Japanese/Thai source text). For such source languages the protect
  pass may under-match; this is acceptable for the local-first default where
  the common path is en/vi-style languages.
* Grammatical agreement (gender/case/inflection) around the inserted target
  term is not adjusted — the target term is inserted verbatim.
* If a glossary term is a substring of another glossary term, longer terms are
  protected first to avoid partial shadowing.
"""

from __future__ import annotations

import re

# Sentinel marker. Deliberately plain ASCII: the decoder must be able to copy it
# through verbatim (see the incident note above). "XQZ" is a trigram that does
# not occur in ordinary prose, so a literal collision with real source text is
# vanishingly unlikely.
_SENTINEL_MARKER = "XQZ"


def _sentinel(index: int) -> str:
    """Build the opaque sentinel token for a given glossary entry index."""
    return f"{_SENTINEL_MARKER}{index}"


# Matches any sentinel and captures its numeric index. Maximal-munch on the
# digits so XQZ12 is index 12, never index 1 followed by a stray "2".
_SENTINEL_RE = re.compile(re.escape(_SENTINEL_MARKER) + r"(\d+)")


def build_protection(glossary: dict[str, str] | None) -> dict[int, str]:
    """Return an ``index -> target_term`` map for a glossary.

    Entries are ordered by descending source-term length so that longer terms
    are protected before shorter ones that might be substrings of them.
    """
    if not glossary:
        return {}
    # Stable, deterministic ordering: longest source term first, then alpha.
    ordered = sorted(glossary.items(), key=lambda kv: (-len(kv[0]), kv[0]))
    return {idx: target for idx, (_src, target) in enumerate(ordered)}


def _ordered_sources(glossary: dict[str, str]) -> list[tuple[int, str, str]]:
    """``(index, source_term, target_term)`` in the canonical protect order."""
    ordered = sorted(glossary.items(), key=lambda kv: (-len(kv[0]), kv[0]))
    return [(idx, src, target) for idx, (src, target) in enumerate(ordered)]


def apply_glossary_pre(text: str, glossary: dict[str, str] | None) -> str:
    """PRE-pass: replace glossary source terms with opaque sentinel tokens.

    Case-insensitive, whole-word. Returns the protected text ready to translate.
    The mapping used here is derived deterministically from ``glossary`` via the
    same ordering as :func:`build_protection`, so :func:`apply_glossary_post`
    can restore it without extra state.
    """
    if not glossary or not text:
        return text

    protected = text
    for index, source_term, _target in _ordered_sources(glossary):
        source_term = source_term.strip()
        if not source_term:
            continue
        pattern = re.compile(r"\b" + re.escape(source_term) + r"\b", flags=re.IGNORECASE)
        protected = pattern.sub(_sentinel(index), protected)
    return protected


def _sentinel_counts(text: str) -> dict[int, int]:
    """How many times each sentinel index occurs in ``text``."""
    counts: dict[int, int] = {}
    for match in _SENTINEL_RE.finditer(text or ""):
        idx = int(match.group(1))
        counts[idx] = counts.get(idx, 0) + 1
    return counts


def missing_sentinels(protected: str, translated: str) -> list[int]:
    """Sentinel indices the engine lost between ``protected`` and ``translated``.

    A sentinel that went in twice and came back once is just as broken as one
    that vanished entirely — the clause around it is gone — so this compares
    *counts*, not mere presence. An empty list means the round trip is safe to
    restore; anything else means the translation must be discarded (callers fall
    back to translating the unprotected source).
    """
    before = _sentinel_counts(protected)
    after = _sentinel_counts(translated)
    return sorted(idx for idx, n in before.items() if after.get(idx, 0) < n)


def apply_glossary_post(text: str, glossary: dict[str, str] | None) -> str:
    """POST-pass: replace sentinel tokens with their glossary target values.

    Any sentinel left in the text (e.g. one the NMT engine spuriously emitted)
    that does not resolve to a known index is stripped so it never leaks to the
    user. Sentinels are resolved against the same deterministic ordering used in
    :func:`apply_glossary_pre`.
    """
    if not glossary or not text:
        # Still strip any stray sentinels even when there's no glossary.
        return _SENTINEL_RE.sub("", text) if _SENTINEL_MARKER in text else text

    index_to_target = build_protection(glossary)

    def _restore(match: re.Match[str]) -> str:
        idx = int(match.group(1))
        return index_to_target.get(idx, "")

    return _SENTINEL_RE.sub(_restore, text)


def apply_target_terms(text: str, glossary: dict[str, str] | None) -> str:
    """Enforce the glossary on ALREADY-TRANSLATED text (the fallback path).

    Used when sentinel protection did not survive the engine: we translate the
    untouched source instead and then rewrite any source term the engine copied
    through verbatim (brands, acronyms — the common glossary case) into the
    user's preferred target rendering.

    This is strictly weaker than sentinel protection: a term the engine actually
    *translated* is no longer findable, so it cannot be enforced. That is why it
    is the fallback and not the default. Matching is whole-word and
    case-insensitive, longest source term first, exactly like the PRE pass.

    Unlike the PRE pass this must run as a SINGLE pass over the text. The PRE
    pass substitutes opaque sentinels, which no later term can match; here we
    substitute real words, so term-by-term passes cascade — with
    ``{"New York": "New York City", "York": "Yorkshire"}`` a second pass turns
    the freshly-inserted "New York City" into "New Yorkshire City".
    """
    if not glossary or not text:
        return text

    terms = [(src.strip(), target) for _idx, src, target in _ordered_sources(glossary)]
    terms = [(src, target) for src, target in terms if src]
    if not terms:
        return text

    # One alternation, longest source term first, so the regex engine prefers
    # the longest match at each position and every character is rewritten at
    # most once.
    pattern = re.compile(
        r"\b(?:" + "|".join(re.escape(src) for src, _ in terms) + r")\b",
        flags=re.IGNORECASE,
    )
    by_lower = {src.lower(): target for src, target in reversed(terms)}

    def _replace(match: re.Match[str]) -> str:
        return by_lower.get(match.group(0).lower(), match.group(0))

    return pattern.sub(_replace, text)
