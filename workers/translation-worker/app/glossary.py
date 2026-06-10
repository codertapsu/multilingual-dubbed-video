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
   token (``{n}``). Sentinels use Unicode Private-Use-Area code
   points so the translation engine leaves them untouched and never word-splits
   them. We remember which sentinel maps to which desired target term.

2. **Translate** the protected text normally.

3. **POST-restore** — replace each sentinel with the glossary's *target* value.

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

# Private-Use-Area delimiters make the sentinel extremely unlikely to collide
# with real text and discourage the NMT engine from splitting/translating it.
_SENTINEL_OPEN = ""
_SENTINEL_CLOSE = ""


def _sentinel(index: int) -> str:
    """Build the opaque sentinel token for a given glossary entry index."""
    return f"{_SENTINEL_OPEN}{index}{_SENTINEL_CLOSE}"


# Matches any sentinel and captures its numeric index.
_SENTINEL_RE = re.compile(re.escape(_SENTINEL_OPEN) + r"(\d+)" + re.escape(_SENTINEL_CLOSE))


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


def apply_glossary_pre(text: str, glossary: dict[str, str] | None) -> str:
    """PRE-pass: replace glossary source terms with opaque sentinel tokens.

    Case-insensitive, whole-word. Returns the protected text ready to translate.
    The mapping used here is derived deterministically from ``glossary`` via the
    same ordering as :func:`build_protection`, so :func:`apply_glossary_post`
    can restore it without extra state.
    """
    if not glossary or not text:
        return text

    ordered = sorted(glossary.items(), key=lambda kv: (-len(kv[0]), kv[0]))
    protected = text
    for index, (source_term, _target) in enumerate(ordered):
        source_term = source_term.strip()
        if not source_term:
            continue
        pattern = re.compile(r"\b" + re.escape(source_term) + r"\b", flags=re.IGNORECASE)
        protected = pattern.sub(_sentinel(index), protected)
    return protected


def apply_glossary_post(text: str, glossary: dict[str, str] | None) -> str:
    """POST-pass: replace sentinel tokens with their glossary target values.

    Any sentinel left in the text (e.g. one the NMT engine spuriously emitted)
    that does not resolve to a known index is stripped so it never leaks to the
    user. Sentinels are resolved against the same deterministic ordering used in
    :func:`apply_glossary_pre`.
    """
    if not glossary or not text:
        # Still strip any stray sentinels even when there's no glossary.
        return _SENTINEL_RE.sub("", text) if _SENTINEL_OPEN in text else text

    index_to_target = build_protection(glossary)

    def _restore(match: re.Match[str]) -> str:
        idx = int(match.group(1))
        return index_to_target.get(idx, "")

    return _SENTINEL_RE.sub(_restore, text)
