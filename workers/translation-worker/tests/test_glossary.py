"""Tests for the sentinel-token glossary protect/restore passes."""

from __future__ import annotations

from app.glossary import (
    _sentinel,
    apply_glossary_post,
    apply_glossary_pre,
    apply_target_terms,
    missing_sentinels,
)


def _roundtrip(text: str, glossary: dict[str, str]) -> str:
    """Simulate a no-op translator that leaves sentinels untouched."""
    protected = apply_glossary_pre(text, glossary)
    # A real translator would translate around the sentinels; here we pass through.
    return apply_glossary_post(protected, glossary)


def test_pre_replaces_source_terms_with_sentinels() -> None:
    glossary = {"VideoDubber": "VideoDubber"}
    protected = apply_glossary_pre("Welcome to VideoDubber app", glossary)
    assert "VideoDubber" not in protected  # source term hidden behind a sentinel
    assert "Welcome to" in protected


def test_post_restores_target_term() -> None:
    glossary = {"cat": "con mèo"}
    assert _roundtrip("the cat sat", glossary) == "the con mèo sat"


def test_case_insensitive_whole_word() -> None:
    glossary = {"CPU": "CPU"}
    # whole-word, case-insensitive: "cpu" matches, but "cpuload" must not.
    out = _roundtrip("the cpu and the cpuload value", glossary)
    assert "CPU and the cpuload" in out


def test_longer_terms_protected_first() -> None:
    glossary = {"New York": "New York", "York": "York"}
    out = _roundtrip("I love New York", glossary)
    assert out == "I love New York"


def test_no_glossary_is_passthrough() -> None:
    assert apply_glossary_pre("hello", None) == "hello"
    assert apply_glossary_post("hello", None) == "hello"


def test_stray_sentinels_are_stripped() -> None:
    # A sentinel index with no matching glossary entry resolves to "".
    glossary = {"foo": "bar"}
    # Manually craft a translated string containing a valid + an out-of-range sentinel.
    crafted = apply_glossary_pre("foo", glossary) + _sentinel(99)
    restored = apply_glossary_post(crafted, glossary)
    assert restored == "bar"  # index-0 -> "bar"; index-99 stray -> stripped


def test_missing_sentinels_detects_a_dropped_term() -> None:
    glossary = {"VideoDubber": "VideoDubber", "CPU": "CPU"}
    protected = apply_glossary_pre("VideoDubber runs on your CPU.", glossary)
    # The engine kept one sentinel and dropped the clause around the other.
    mangled = protected.replace(_sentinel(0), "")
    assert missing_sentinels(protected, mangled) == [0]
    assert missing_sentinels(protected, protected) == []


def test_missing_sentinels_counts_occurrences_not_presence() -> None:
    # A term used twice that comes back once has still lost a clause.
    glossary = {"CPU": "CPU"}
    protected = apply_glossary_pre("the CPU and the CPU again", glossary)
    dropped_one = protected.replace(_sentinel(0), "", 1)
    assert missing_sentinels(protected, dropped_one) == [0]


def test_apply_target_terms_rewrites_copied_through_terms() -> None:
    # The fallback path: the engine copied the brand verbatim into the target
    # text, so the user's preferred rendering can still be enforced there.
    glossary = {"VideoDubber": "Trình lồng tiếng"}
    assert (
        apply_target_terms("VideoDubber chạy trên CPU của bạn.", glossary)
        == "Trình lồng tiếng chạy trên CPU của bạn."
    )


def test_apply_target_terms_is_whole_word_and_longest_first() -> None:
    glossary = {"New York": "New York City", "York": "Yorkshire"}
    assert apply_target_terms("I love New York", glossary) == "I love New York City"
    assert apply_target_terms("no match here", glossary) == "no match here"
