"""Male, female or unknown per speaker: voice prints first, pitch only as a seed.

The rule the 10-hour drama of the field report (2026-11-21, B2) was cast with,
checked against its dialogue. Pitch alone got it wrong: 25 groups of shouting
men measured 300-400 Hz. What decided it was a voice-print "signature":

1. Subtract the file's mean print, so what every voice of this soundtrack
   shares (the mix, the channel) stops making them look alike.
2. Seeds, where pitch is unambiguous and there is enough of the voice: male
   under 135 Hz with 2 minutes of talk; female at 195-285 Hz with under 10 %
   of the voiced frames below 165 Hz (a raised male voice keeps its low
   frames) and 2 minutes.
3. Grow the reference sets over three rounds by mean similarity to them
   (simF, simM): female when simF > 0.4 and above simM; male when simM > 0.15,
   above simF and the speaker talks a minute or more.
4. Label: female when simF > max(simM, 0.2); male when simM > max(simF, 0.05);
   otherwise unknown. Children and unclear voices stay unknown: a guess here
   becomes the wrong default voice.

Without a single seed of a gender, its similarity cannot be measured; pitch
alone then names that gender, with a low confidence. So does a voice under
the male seed pitch whose print says nothing either way: on the drama's
table eight such speakers (95-130 Hz, a minute or less each) came out
unknown, and no woman or child speaks that low. The two minutes a seed needs
make it a stable reference, they are not what makes the pitch male. Pure numpy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

MALE_SEED_MAX_HZ = 135.0
FEMALE_SEED_MIN_HZ = 195.0
FEMALE_SEED_MAX_HZ = 285.0
FEMALE_SEED_MAX_LOW_SHARE = 0.10
SEED_MIN_SEC = 120.0
GROW_ROUNDS = 3
GROW_FEMALE_MIN_SIM = 0.4
GROW_MALE_MIN_SIM = 0.15
GROW_MALE_MIN_SEC = 60.0
LABEL_FEMALE_MIN_SIM = 0.2
LABEL_MALE_MIN_SIM = 0.05

SEED_CONFIDENCE = 0.9
PITCH_ONLY_CONFIDENCE = 0.3


@dataclass(frozen=True)
class Gender:
    label: str  # 'male' | 'female' | 'unknown'
    confidence: float


def is_male_seed(f0_hz: Optional[float], low_share: Optional[float], sec: float) -> bool:
    return f0_hz is not None and f0_hz < MALE_SEED_MAX_HZ and sec >= SEED_MIN_SEC


def is_female_seed(f0_hz: Optional[float], low_share: Optional[float], sec: float) -> bool:
    return (
        f0_hz is not None
        and FEMALE_SEED_MIN_HZ <= f0_hz <= FEMALE_SEED_MAX_HZ
        and low_share is not None
        and low_share < FEMALE_SEED_MAX_LOW_SHARE
        and sec >= SEED_MIN_SEC
    )


def pitch_gender(f0_hz: Optional[float], low_share: Optional[float]) -> Optional[str]:
    """Pitch alone (refine_speakers.py's table), for a gender without seeds.
    Above 300 Hz it cannot tell a child or a woman from a shouting man."""
    if f0_hz is None:
        return None
    if f0_hz < 165:
        return "male"
    if f0_hz <= 180:
        return "male" if (low_share if low_share is not None else 0.5) >= 0.5 else "female"
    if f0_hz <= 300:
        return "female"
    return None


def _confidence(win: float, lose: Optional[float], floor: float) -> float:
    margin = win - max(lose if lose is not None else -1.0, floor)
    return round(min(0.85, max(0.5, 0.5 + margin)), 2)


def genders(
    prints: Sequence[Optional[np.ndarray]],
    f0s: Sequence[Optional[float]],
    low_shares: Sequence[Optional[float]],
    secs: Sequence[float],
) -> list[Gender]:
    """A gender per speaker (same order as the inputs)."""
    n = len(prints)
    male_seeds = {i for i in range(n) if is_male_seed(f0s[i], low_shares[i], secs[i])}
    female_seeds = {i for i in range(n) if is_female_seed(f0s[i], low_shares[i], secs[i])}

    have = [i for i in range(n) if prints[i] is not None]
    pos = {i: k for k, i in enumerate(have)}
    sims = np.zeros((0, 0))
    if have:
        p = np.stack([np.asarray(prints[i], dtype=np.float64) for i in have])
        centred = p - p.mean(axis=0)
        norms = np.linalg.norm(centred, axis=1, keepdims=True)
        centred = np.divide(centred, norms, out=np.zeros_like(centred), where=norms > 0)
        sims = centred @ centred.T

    def ref_sim(i: int, group: set[int]) -> Optional[float]:
        members = [pos[j] for j in group if j != i and j in pos]
        if i not in pos or not members:
            return None
        return float(sims[pos[i], members].mean())

    males = male_seeds & set(have)
    females = female_seeds & set(have)
    # A gender whose seeds give no print to compare with is judged by pitch.
    pitch_male, pitch_female = not males, not females
    for _ in range(GROW_ROUNDS):
        add_f, add_m = set(), set()
        for i in have:
            if i in males or i in females:
                continue
            sm, sf = ref_sim(i, males), ref_sim(i, females)
            if sf is not None and sf > GROW_FEMALE_MIN_SIM and (sm is None or sf > sm):
                add_f.add(i)
            elif sm is not None and sm > GROW_MALE_MIN_SIM and (sf is None or sm > sf) and secs[i] >= GROW_MALE_MIN_SEC:
                add_m.add(i)
        if not add_f and not add_m:
            break
        females |= add_f
        males |= add_m

    out: list[Gender] = []
    for i in range(n):
        if i in male_seeds:
            out.append(Gender("male", SEED_CONFIDENCE))
            continue
        if i in female_seeds:
            out.append(Gender("female", SEED_CONFIDENCE))
            continue
        sm, sf = ref_sim(i, males), ref_sim(i, females)
        if sf is not None and sf > max(sm if sm is not None else -1.0, LABEL_FEMALE_MIN_SIM):
            out.append(Gender("female", _confidence(sf, sm, LABEL_FEMALE_MIN_SIM)))
        elif sm is not None and sm > max(sf if sf is not None else -1.0, LABEL_MALE_MIN_SIM):
            out.append(Gender("male", _confidence(sm, sf, LABEL_MALE_MIN_SIM)))
        else:
            guess = pitch_gender(f0s[i], low_shares[i])
            deep = f0s[i] is not None and f0s[i] < MALE_SEED_MAX_HZ
            if (guess == "male" and (pitch_male or deep)) or (guess == "female" and pitch_female):
                out.append(Gender(guess, PITCH_ONLY_CONFIDENCE))
            else:
                out.append(Gender("unknown", 0.0))
    return out
