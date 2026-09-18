"""The one test that would have caught the PUA-sentinel incident.

Every other glossary test runs against a fake backend, and a fake backend can
only ever confirm the assumption it was written with. The old fake was written
to leave Private-Use-Area sentinels alone "mirroring how a real NMT engine
should leave PUA tokens alone"; the real engine instead deleted and hallucinated
whole clauses around them (see :mod:`app.glossary`). So this module runs the
protect -> translate -> restore round trip through an ACTUALLY INSTALLED Argos
pair, and is skipped when the machine has none.

It asserts the property that matters and nothing model-specific: the source's
content survives, and the glossary terms come back. It deliberately does not
assert an exact Vietnamese string — that would break on every Argos model bump
for no benefit.
"""

from __future__ import annotations

import pytest

from app.glossary import apply_glossary_post, apply_glossary_pre, missing_sentinels

pytestmark = pytest.mark.argos


def _installed_translation(from_code: str, to_code: str):
    """The argostranslate translation object for a pair, or None if unavailable."""
    try:
        from argostranslate import translate as argos_translate
    except Exception:  # pragma: no cover - library not installed
        return None
    languages = {lang.code: lang for lang in argos_translate.get_installed_languages()}
    source, target = languages.get(from_code), languages.get(to_code)
    if source is None or target is None:
        return None
    return source.get_translation(target)


@pytest.fixture(scope="module")
def en_vi():
    translation = _installed_translation("en", "vi")
    if translation is None:
        pytest.skip("no installed Argos en->vi package on this machine")
    return translation


def test_sentinels_survive_a_real_argos_round_trip(en_vi) -> None:
    glossary = {"VideoDubber": "VideoDubber", "CPU": "CPU"}
    source = "VideoDubber runs on your CPU and never uploads your video."

    protected = apply_glossary_pre(source, glossary)
    translated = en_vi.translate(protected)

    # This is the assertion that was false for the PUA sentinels: the engine
    # gave back "Không bao giờ đăng tải video của bạn." — the first clause,
    # and both sentinels, simply gone.
    assert missing_sentinels(protected, translated) == []

    restored = apply_glossary_post(translated, glossary)
    assert "VideoDubber" in restored
    assert "CPU" in restored
    # The second clause must still be there — the old failure ate the first one,
    # so check the sentence is not a truncated fragment.
    assert len(restored.split()) >= 8


def test_sentinels_survive_repeats_and_many_terms(en_vi) -> None:
    glossary = {f"Term{n}": f"Term{n}" for n in range(6)}
    source = "Term0 and Term1 and Term2 and Term3 and Term4 and Term5, then Term0 again."

    protected = apply_glossary_pre(source, glossary)
    translated = en_vi.translate(protected)

    assert missing_sentinels(protected, translated) == []
    restored = apply_glossary_post(translated, glossary)
    assert restored.count("Term0") == 2
