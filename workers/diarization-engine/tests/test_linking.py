"""Linking chunk speakers into the file's speakers, and their gender: pure numpy, synthetic prints."""

from __future__ import annotations

from typing import Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

from vd_diarize import app as app_mod
from vd_diarize.gender import genders
from vd_diarize.linking import (
    FALLBACK_CANNOT_LINK_SIM,
    FALLBACK_LINK_DISTANCE,
    LinkItem,
    derive_thresholds,
    link_speakers,
    upgma,
)

DIM = 32


def unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def basis(k: int) -> np.ndarray:
    e = np.zeros(DIM)
    e[k] = 1.0
    return e


def alike(a: np.ndarray, sim: float, k: int) -> np.ndarray:
    """A unit vector with similarity `sim` to unit `a`, leaning on basis vector k (orthogonal to a)."""
    w = unit(basis(k) - (basis(k) @ a) * a)
    return sim * a + np.sqrt(1 - sim**2) * w


def item(chunk: int, local: int, vec: Optional[np.ndarray], sec: float = 60.0, print_sec: float = 20.0, f0: Optional[float] = None, low: Optional[float] = None) -> LinkItem:
    return LinkItem(chunk=chunk, local=local, sec=sec, print_sec=print_sec, print=vec, f0_hz=f0, low_share=low)


# ---- upgma ------------------------------------------------------------------


def test_upgma_merges_within_the_threshold_and_never_across_an_infinite_pair() -> None:
    d = np.array(
        [
            [0.0, 0.1, 0.9, 0.9],
            [0.1, 0.0, 0.9, 0.9],
            [0.9, 0.9, 0.0, 0.2],
            [0.9, 0.9, 0.2, 0.0],
        ]
    )
    assert upgma(d, 0.5).tolist() == [0, 0, 1, 1]
    assert upgma(d, 0.15).tolist() == [0, 0, 1, 2]
    assert upgma(d, 1.0).tolist() == [0, 0, 0, 0]
    # 0 and 1 may never meet: once 0 has joined 2, 1 stays out of that group for good.
    d = np.array([[0.0, np.inf, 0.1], [np.inf, 0.0, 0.1], [0.1, 0.1, 0.0]])
    assert upgma(d, 0.5).tolist() == [0, 1, 0]
    assert upgma(np.zeros((0, 0)), 0.5).tolist() == []


def test_upgma_uses_the_average_of_every_pair() -> None:
    # 2 is close to 0 (0.2) and far from 1 (0.6): to the pair {0,1} it is 0.4 on average.
    d = np.array([[0.0, 0.05, 0.2], [0.05, 0.0, 0.6], [0.2, 0.6, 0.0]])
    assert upgma(d, 0.35).tolist() == [0, 0, 1]
    assert upgma(d, 0.45).tolist() == [0, 0, 0]


# ---- linking ----------------------------------------------------------------


def three_voices(rng: np.random.Generator) -> list[np.ndarray]:
    return [basis(0), basis(1), basis(2)]


def noisy(v: np.ndarray, rng: np.random.Generator, scale: float = 0.04) -> np.ndarray:
    return unit(v + rng.normal(0.0, scale, DIM))


def test_links_one_voice_across_chunks_and_numbers_speakers_by_talk_time() -> None:
    rng = np.random.default_rng(1)
    a, b, c = three_voices(rng)
    items = [
        item(0, 0, noisy(a, rng), sec=30),
        item(0, 1, noisy(b, rng), sec=100),
        item(1, 0, noisy(b, rng), sec=100),
        item(1, 1, noisy(c, rng), sec=50),
        item(2, 3, noisy(a, rng), sec=30),
        item(2, 0, noisy(c, rng), sec=50),
    ]
    res = link_speakers(items, link_distance=0.35, cannot_link_sim=0.78)
    # b talks 200 s, c 100 s, a 60 s.
    assert res.labels == [2, 0, 0, 1, 2, 1]
    assert [round(s.sec) for s in res.speakers] == [200, 100, 60]
    assert all(abs(np.linalg.norm(s.print) - 1) < 1e-9 for s in res.speakers)
    assert not res.derived


def test_a_chunk_keeps_apart_what_it_heard_as_two_people() -> None:
    a = basis(0)
    b = alike(a, 0.7, 1)  # distance 0.3: within the link distance on their own
    together = [item(0, 0, a, sec=30), item(0, 1, b, sec=30)]
    assert link_speakers(together, link_distance=0.35, cannot_link_sim=0.78).labels == [0, 1]
    # Heard again in other chunks, alone: still two people.
    again = together + [item(1, 0, a, sec=30), item(2, 0, b, sec=30)]
    assert link_speakers(again, link_distance=0.35, cannot_link_sim=0.78).labels == [0, 1, 0, 1]
    # One of them too brief for the chunk's verdict to count: they merge.
    brief = [item(0, 0, a, sec=30), item(0, 1, b, sec=10)]
    assert link_speakers(brief, link_distance=0.35, cannot_link_sim=0.78).labels == [0, 0]
    # Near-identical prints in one chunk are the diarizer splitting one voice: merged.
    split = [item(0, 0, a, sec=30), item(0, 1, alike(a, 0.9, 1), sec=30)]
    assert link_speakers(split, link_distance=0.35, cannot_link_sim=0.78).labels == [0, 0]


def test_small_prints_join_the_nearest_group_only_when_close_enough() -> None:
    a, b = basis(0), basis(1)
    items = [
        item(0, 0, a, sec=60),
        item(1, 0, b, sec=40),
        item(1, 1, alike(a, 0.6, 3), sec=5, print_sec=1.0),  # distance 0.4: within 0.35 + 0.15
        item(2, 0, alike(b, 0.3, 4), sec=3, print_sec=1.0),  # distance 0.7: on its own
        item(2, 1, None, sec=2, print_sec=0.0),  # no print at all: on its own
    ]
    res = link_speakers(items, link_distance=0.35, cannot_link_sim=0.78)
    assert res.labels == [0, 1, 0, 2, 3]
    assert [s.sec for s in res.speakers] == [65, 40, 3, 2]


def test_a_confident_man_and_woman_never_link() -> None:
    man = basis(0)
    woman = alike(man, 0.8, 1)  # alike enough to merge at 0.35
    items = [
        item(0, 0, man, sec=150, f0=110.0, low=0.9),
        item(1, 0, woman, sec=150, f0=230.0, low=0.02),
    ]
    assert link_speakers(items, link_distance=0.35, cannot_link_sim=0.78).labels == [0, 1]
    # Without the pitch evidence (too little talk for a seed) they merge.
    unsure = [item(0, 0, man, sec=100, f0=110.0, low=0.9), item(1, 0, woman, sec=100, f0=230.0, low=0.02)]
    assert link_speakers(unsure, link_distance=0.35, cannot_link_sim=0.78).labels == [0, 0]


def test_past_the_cap_the_tail_merges_into_the_nearest_speaker_of_its_gender() -> None:
    man = basis(0)
    woman = basis(1)
    girl = alike(man, 0.8, 2)  # by print nearer the man than the woman
    items = [
        item(0, 0, man, sec=600, f0=110.0, low=0.9),
        item(1, 0, woman, sec=400, f0=230.0, low=0.02),
        item(2, 0, girl, sec=150, f0=240.0, low=0.03),
    ]
    uncapped = link_speakers(items, link_distance=0.35, cannot_link_sim=0.78)
    assert uncapped.labels == [0, 1, 2]
    assert [s.gender.label for s in uncapped.speakers] == ["male", "female", "female"]
    capped = link_speakers(items, max_speakers=2, link_distance=0.35, cannot_link_sim=0.78)
    assert capped.labels == [0, 1, 1]
    assert [round(s.sec) for s in capped.speakers] == [600, 550]
    # The kept speaker keeps its own voice print and gender.
    assert capped.speakers[1].print == pytest.approx(woman)


def test_thresholds_from_the_files_own_distributions() -> None:
    separated = np.linspace(0.40, 0.76, 50)  # median 0.58
    same_voice = np.linspace(0.80, 0.98, 50)
    p10 = float(np.percentile(same_voice, 10))
    link, cannot = derive_thresholds(separated, same_voice)
    assert cannot == pytest.approx(round(p10 - 0.03, 3))
    assert link == pytest.approx(round(1 - (0.58 + 0.3 * (p10 - 0.58)), 3))
    # The field report's own figures give the validated values.
    assert derive_thresholds(np.full(30, 0.58), np.full(30, 0.81)) == (0.351, 0.78)
    # Too little data, or two distributions that do not separate: no opinion.
    assert derive_thresholds(separated[:10], same_voice) is None
    assert derive_thresholds(np.full(30, 0.7), np.full(30, 0.72)) is None
    # Extreme files are held to a sane range.
    assert derive_thresholds(np.full(30, 0.1), np.full(30, 0.99)) == (0.45, 0.9)


def test_linking_derives_its_thresholds_when_the_file_has_enough_speakers() -> None:
    rng = np.random.default_rng(7)
    voices = [basis(k) for k in range(8)]
    items: list[LinkItem] = []
    for chunk in range(12):
        # Every chunk: five of the eight voices, each heard 30 s.
        for local, v in enumerate(rng.choice(8, size=5, replace=False)):
            items.append(item(chunk, local, noisy(voices[v], rng, 0.08), sec=30))
    res = link_speakers(items)
    assert res.derived
    assert 0.25 <= res.link_distance <= 0.45 and 0.65 <= res.cannot_link_sim <= 0.9
    assert len(res.speakers) == 8
    # Too few speakers to measure: the validated fallback.
    small = link_speakers(items[:3])
    assert (small.link_distance, small.cannot_link_sim, small.derived) == (FALLBACK_LINK_DISTANCE, FALLBACK_CANNOT_LINK_SIM, False)


def test_link_http_contract() -> None:
    client = TestClient(app_mod.app)
    a, b = basis(0).tolist(), basis(1).tolist()
    body = {
        "items": [
            {"chunk": 0, "local": 0, "sec": 30, "printSec": 20, "print": a, "f0Hz": 120.0, "lowShare": 0.9},
            {"chunk": 0, "local": 1, "sec": 90, "printSec": 20, "print": b},
            {"chunk": 1, "local": 0, "sec": 30, "printSec": 20, "print": a},
        ],
        "linkThreshold": 0.35,
        "cannotLinkSim": 0.78,
    }
    res = client.post("/link", json=body).json()
    assert res["assignments"] == [
        {"chunk": 0, "local": 0, "speaker": 1},
        {"chunk": 0, "local": 1, "speaker": 0},
        {"chunk": 1, "local": 0, "speaker": 1},
    ]
    assert [(s["speaker"], s["sec"]) for s in res["speakers"]] == [(0, 90.0), (1, 60.0)]
    assert res["speakers"][1]["f0Hz"] == 120.0 and len(res["speakers"][1]["print"]) == DIM
    assert set(res["speakers"][0]) == {"speaker", "sec", "f0Hz", "gender", "genderConfidence", "print"}
    assert res["thresholds"] == {"link": 0.35, "cannotLink": 0.78, "derived": False}

    mixed = {"items": [body["items"][0], {**body["items"][1], "print": [1.0, 0.0]}]}
    assert client.post("/link", json=mixed).status_code == 400
    twice = {"items": [body["items"][0], body["items"][0]]}
    assert client.post("/link", json=twice).status_code == 400
    assert client.post("/link", json={"items": []}).json()["assignments"] == []


# ---- gender -----------------------------------------------------------------


def cast_prints(rng: np.random.Generator) -> dict[str, np.ndarray]:
    """Prints that share a large common part (the soundtrack) plus a male, female or child direction."""
    common = 2.0 * basis(0)

    def voice(direction: int, k: int) -> np.ndarray:
        return unit(common + basis(direction) + 0.35 * basis(10 + k) + rng.normal(0.0, 0.02, DIM))

    return {
        "m1": voice(1, 0),
        "m2": voice(1, 1),
        "m3": voice(1, 2),
        "f1": voice(2, 3),
        "f2": voice(2, 4),
        "f3": voice(2, 5),
        "kid": voice(3, 6),
    }


def test_gender_from_seeds_grown_by_voice_print() -> None:
    p = cast_prints(np.random.default_rng(3))
    rows = [
        # name, F0, share of low frames, talk seconds
        ("m1", 110.0, 0.9, 300.0),  # male seed
        ("m2", 125.0, 0.85, 200.0),  # male seed
        ("m3", 320.0, 0.05, 90.0),  # a man who shouts: his print says male, his pitch would not
        ("f1", 220.0, 0.05, 300.0),  # female seed
        ("f2", 240.0, 0.02, 150.0),  # female seed
        ("f3", None, None, 30.0),  # no pitch, a female print
        ("kid", 330.0, 0.0, 100.0),  # neither: stays unknown
    ]
    out = genders([p[r[0]] for r in rows], [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows])
    labels = {r[0]: g.label for r, g in zip(rows, out)}
    assert labels == {"m1": "male", "m2": "male", "m3": "male", "f1": "female", "f2": "female", "f3": "female", "kid": "unknown"}
    conf = {r[0]: g.confidence for r, g in zip(rows, out)}
    assert conf["m1"] == conf["f1"] == 0.9
    assert 0.5 <= conf["m3"] <= 0.85 and 0.5 <= conf["f3"] <= 0.85
    assert conf["kid"] == 0.0


def test_gender_falls_back_to_pitch_for_a_gender_without_seeds() -> None:
    p = cast_prints(np.random.default_rng(4))
    rows = [
        ("m1", 110.0, 0.9, 300.0),
        ("m2", 125.0, 0.85, 200.0),
        ("f1", 230.0, 0.05, 60.0),  # a woman, but too little of her for a seed
        ("kid", 330.0, 0.0, 100.0),  # pitch cannot tell above 300 Hz
    ]
    out = genders([p[r[0]] for r in rows], [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows])
    assert [(g.label, g.confidence) for g in out] == [("male", 0.9), ("male", 0.9), ("female", 0.3), ("unknown", 0.0)]


def test_a_deep_voice_with_an_unclear_print_is_male_at_low_confidence() -> None:
    p = cast_prints(np.random.default_rng(5))
    odd = unit(2.0 * basis(0) + basis(5) + np.random.default_rng(6).normal(0.0, 0.02, DIM))
    prints = [p["m1"], p["m2"], p["f1"], p["f2"], odd, odd]
    f0s = [110.0, 125.0, 220.0, 240.0, 100.0, 150.0]
    lows = [0.9, 0.85, 0.05, 0.02, 0.95, 0.7]
    secs = [300.0, 200.0, 300.0, 150.0, 40.0, 40.0]
    out = genders(prints, f0s, lows, secs)
    # 100 Hz is no woman's or child's voice; 150 Hz could be a low one: unknown.
    assert [(g.label, g.confidence) for g in out[4:]] == [("male", 0.3), ("unknown", 0.0)]


def test_gender_without_prints_or_pitch_is_unknown() -> None:
    out = genders([None, None], [None, 400.0], [None, 0.0], [10.0, 10.0])
    assert [g.label for g in out] == ["unknown", "unknown"]
