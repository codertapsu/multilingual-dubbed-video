"""Service-level glossary behaviour: verify the sentinel round trip, or fall back.

The unit tests in ``test_glossary.py`` cover the passes in isolation. These
cover the decision the service makes between them, which is the part that
shipped broken: the old code restored whatever the engine returned, so an engine
that ate the sentinels produced a fluent, confident mistranslation with no
signal anywhere.
"""

from __future__ import annotations

from app import translation_service
from app.schemas import Segment

from .conftest import DroppingBackend, FakeBackend

_GLOSSARY = {"VideoDubber": "VideoDubber", "CPU": "CPU"}
_SOURCE = "VideoDubber runs on your CPU and never uploads your video."


def _translate(backend, glossary):
    translation_service.set_backend(backend)
    try:
        return translation_service.translate_segments(
            "en-US",
            "vi-VN",
            [Segment(id="seg_0001", sourceText=_SOURCE, startMs=0, endMs=1000)],
            glossary=glossary,
        ).segments[0].translatedText
    finally:
        translation_service.set_backend(None)


def test_surviving_sentinels_are_restored_without_a_second_call() -> None:
    backend = FakeBackend()
    out = _translate(backend, _GLOSSARY)

    assert "XQZ" not in out  # every sentinel resolved
    assert "VideoDubber" in out and "CPU" in out
    assert len(backend.calls) == 1  # no wasteful re-translation on the happy path


def test_lost_sentinels_trigger_a_clean_retranslate_and_target_side_enforcement() -> None:
    backend = DroppingBackend()
    out = _translate(backend, _GLOSSARY)

    # The hallucinated clause the engine produced for the protected text must
    # NOT be what the user gets.
    assert "HALLUCINATED" not in out
    assert "XQZ" not in out
    # Two calls: the protected attempt, then the unprotected source.
    assert len(backend.calls) == 2
    assert backend.calls[1][0] == _SOURCE
    # The glossary is still enforced, on the target text this time.
    assert "VIDEODUBBER" not in out  # rewritten to the glossary's casing
    assert "VideoDubber" in out and "CPU" in out


def test_no_glossary_never_pays_for_verification() -> None:
    backend = DroppingBackend()
    out = _translate(backend, None)

    assert len(backend.calls) == 1
    assert out == f"[vi] {_SOURCE.upper()}"
