"""Link the speakers of separately detected chunks into the speakers of the file.

Each 10-minute chunk is diarized on its own (POST /diarize-chunk), so its
speakers are numbered locally; the same person in two chunks has two local
numbers. This module groups the local speakers by voice print. Ported from
diar_link.py, the script that rescued the field report's 10-hour drama
(2026-11-21, B2): 92 % of its lines then passed the app's own speaker rule.

- Average linkage (UPGMA) on cosine distance, numpy only, merging while the
  closest pair of groups is within the link distance.
- Cannot-links: two local speakers of one chunk whose prints are less alike
  than the cannot-link similarity never end in one group: the chunk's
  diarizer had both voices in front of it and kept them apart. Without this,
  0.30 merged the drama's two main co-occurring voices (53 and 49 minutes)
  into one; with it the result held from 0.30 to 0.40. It first held only
  between speakers who talk 15 s or more in their chunk, and in 《反相之地》
  (claude-dubber, 2026-11-25: an AI-voiced drama, 692 local speakers in 25
  chunks, most of them under 15 s) the main voice then took in 72 local
  speakers, 51 of them from chunks it already had a speaker in, prints as
  little as 0.11 alike, and its lines called three different students by
  name. Every pair whose prints can be trusted (`min_print_sec`) counts now,
  and the two later steps keep the chunk's verdict too: a print too short to
  trust never joins a group holding a speaker of its own chunk, and past
  `max_speakers` a speaker merges into the nearest one with no chunk in
  common when there is one. Same-chunk merges in that drama: 276 -> 54.
  Confident male and female seeds (gender.py) never link either. Their
  distance is infinite, and average linkage carries an infinite pair into
  every merge that contains it.
- The thresholds come from the file itself when it has the data: the
  similarity of the prints a chunk kept apart (that drama: median 0.58, p90
  0.79) against the similarity of one voice across chunks (median 0.89, p10
  0.81), both over the speakers that talk 15 s or more in their chunk (the
  smaller ones' prints are noisier and pulled the medians down by 0.15).
- Prints from under `min_print_sec` of clean speech are too noisy to link by;
  each joins the nearest group afterwards, when close enough.
- Past `max_speakers` (a project's speaker voices hold 100), the speakers who
  talk least merge into the nearest group OF THEIR GENDER: a minor woman's
  lines must not go to a man's voice.

No pitch distance: shouting men measured 300-400 Hz, and the production run's
pitch penalty split a man's shouting from his normal voice.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

from .gender import Gender, genders, is_female_seed, is_male_seed

FALLBACK_LINK_DISTANCE = 0.35
FALLBACK_CANNOT_LINK_SIM = 0.78
CANNOT_LINK_MIN_SEC = 15.0
# How much farther than the link distance a small print may still join a group.
JOIN_SLACK = 0.15
# Fewer pairs than this on either side and the file's own thresholds are noise.
MIN_SAMPLES_TO_DERIVE = 20


@dataclass(frozen=True)
class LinkItem:
    """A local speaker of one chunk (POST /link's item)."""

    chunk: int
    local: int
    sec: float
    print_sec: float
    print: Optional[np.ndarray]
    f0_hz: Optional[float] = None
    low_share: Optional[float] = None


@dataclass(frozen=True)
class GlobalSpeaker:
    speaker: int
    sec: float
    f0_hz: Optional[float]
    gender: Gender
    print: Optional[np.ndarray]


@dataclass(frozen=True)
class LinkResult:
    """`labels[i]` is item i's speaker; speakers are numbered by talk time (0 talks most)."""

    labels: list[int]
    speakers: list[GlobalSpeaker]
    link_distance: float
    cannot_link_sim: float
    derived: bool


def upgma(distances: np.ndarray, stop: float) -> np.ndarray:
    """Average-linkage clustering: merge the closest pair of groups while their
    distance is at most `stop`. Infinite distances never merge, and an infinite
    pair keeps the groups containing it apart for good (Lance-Williams
    averaging of inf). Labels are 0.. in order of each group's first member.

    The closest pair is found from a per-row minimum kept up to date, so a
    merge costs O(n) instead of a scan of the whole matrix: two thousand local
    speakers (60 chunks) link in well under a second.
    """
    n = len(distances)
    if n == 0:
        return np.zeros(0, dtype=int)
    d = np.array(distances, dtype=np.float64)
    np.fill_diagonal(d, np.inf)
    size = np.ones(n)
    alive = np.ones(n, dtype=bool)
    owner = np.arange(n)  # the surviving row each item was merged into
    row_min = d.min(axis=1)
    row_arg = d.argmin(axis=1)
    while True:
        i = int(np.argmin(row_min))
        if not np.isfinite(row_min[i]) or row_min[i] > stop:
            break
        j = int(row_arg[i])
        a, b = min(i, j), max(i, j)
        merged = (size[a] * d[a] + size[b] * d[b]) / (size[a] + size[b])
        merged[a] = merged[b] = np.inf
        d[a, :] = merged
        d[:, a] = merged
        d[b, :] = np.inf
        d[:, b] = np.inf
        size[a] += size[b]
        alive[b] = False
        owner[owner == b] = a
        row_min[b] = np.inf
        row_min[a] = d[a].min()
        row_arg[a] = d[a].argmin()
        # Rows that pointed at a or b must look again; the rest only compare
        # with their new distance to the merged group.
        stale = np.nonzero(alive & ((row_arg == a) | (row_arg == b)))[0]
        for k in stale:
            if k != a:
                row_min[k] = d[k].min()
                row_arg[k] = d[k].argmin()
        closer = alive & (merged < row_min)
        closer[a] = False
        row_min[closer] = merged[closer]
        row_arg[closer] = a
    _, labels = np.unique(owner, return_inverse=True)
    # np.unique numbers by owner index, and an owner is its group's first member.
    return labels.astype(int)


def _cannot_links(items: Sequence[LinkItem], sims: np.ndarray, cannot_link_sim: float, min_print_sec: float = 3.0) -> np.ndarray:
    chunk = np.array([it.chunk for it in items])
    trusted = np.array([it.print_sec >= min_print_sec for it in items])
    out = (chunk[:, None] == chunk[None, :]) & trusted[:, None] & trusted[None, :] & (sims < cannot_link_sim)
    male = np.array([is_male_seed(it.f0_hz, it.low_share, it.sec) for it in items])
    female = np.array([is_female_seed(it.f0_hz, it.low_share, it.sec) for it in items])
    out |= (male[:, None] & female[None, :]) | (female[:, None] & male[None, :])
    np.fill_diagonal(out, False)
    return out


def _cluster(
    items: Sequence[LinkItem], prints: np.ndarray, link_distance: float, cannot_link_sim: float, min_print_sec: float = 3.0
) -> np.ndarray:
    sims = prints @ prints.T
    dist = 1.0 - sims
    dist[_cannot_links(items, sims, cannot_link_sim, min_print_sec)] = np.inf
    return upgma(dist, link_distance)


def _substantial(items: Sequence[LinkItem]) -> np.ndarray:
    return np.array([it.sec >= CANNOT_LINK_MIN_SEC for it in items], dtype=bool)


def separated_similarities(items: Sequence[LinkItem], prints: np.ndarray) -> np.ndarray:
    """Similarities of the pairs of substantial speakers one chunk kept apart."""
    keep = np.nonzero(_substantial(items))[0]
    chunk = np.array([items[i].chunk for i in keep])
    same = np.triu(chunk[:, None] == chunk[None, :], k=1)
    return (prints[keep] @ prints[keep].T)[same]


def cross_chunk_similarities(items: Sequence[LinkItem], prints: np.ndarray) -> np.ndarray:
    """Each substantial speaker's best match among those of the OTHER chunks:
    mostly the same person heard again, the way a recurring cast is."""
    keep = np.nonzero(_substantial(items))[0]
    chunk = np.array([items[i].chunk for i in keep])
    sims = prints[keep] @ prints[keep].T
    sims[chunk[:, None] == chunk[None, :]] = -np.inf
    best = sims.max(axis=1) if len(keep) else np.zeros(0)
    return best[np.isfinite(best)]


def derive_thresholds(separated: np.ndarray, same_voice: np.ndarray) -> Optional[tuple[float, float]]:
    """(link distance, cannot-link similarity) from this file's own distributions,
    or None when it has too little data or the two do not separate.

    The cannot-link cutoff sits just under the low end (p10) of one voice
    across chunks: a pair a chunk kept apart that is less alike than that is
    two people. The link similarity sits 30 % of the way from the typical
    separated pair (median) up to that low end: close to the separated side,
    because the cannot-links already guard the separated pairs that look
    alike, while a stricter link leaves a recurring voice in pieces. The field
    report's figures (0.58, 0.81) give the validated 0.35 / 0.78; its recorded
    chunks, measured here (0.60, 0.815), give 0.33 / 0.785, inside the range
    that run found stable (0.30-0.40).
    """
    if len(separated) < MIN_SAMPLES_TO_DERIVE or len(same_voice) < MIN_SAMPLES_TO_DERIVE:
        return None
    sep_median = float(np.median(separated))
    same_low = float(np.percentile(same_voice, 10))
    if same_low - sep_median < 0.05:
        return None
    cannot = float(np.clip(same_low - 0.03, 0.65, 0.9))
    link_sim = sep_median + 0.3 * (same_low - sep_median)
    link = float(np.clip(1.0 - link_sim, 0.25, 0.45))
    return round(link, 3), round(cannot, 3)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values, kind="stable")
    cum = np.cumsum(weights[order]) / weights.sum()
    return float(values[order][min(len(order) - 1, int(np.searchsorted(cum, 0.5)))])


def link_speakers(
    items: Sequence[LinkItem],
    min_print_sec: float = 3.0,
    max_speakers: int = 100,
    link_distance: Optional[float] = None,
    cannot_link_sim: Optional[float] = None,
) -> LinkResult:
    n = len(items)
    link = link_distance if link_distance is not None else FALLBACK_LINK_DISTANCE
    cannot = cannot_link_sim if cannot_link_sim is not None else FALLBACK_CANNOT_LINK_SIM
    derived = False
    if n == 0:
        return LinkResult([], [], link, cannot, derived)

    dim = next((len(it.print) for it in items if it.print is not None), 0)
    prints = np.zeros((n, dim))
    for i, it in enumerate(items):
        if it.print is not None:
            prints[i] = it.print
    has_print = np.array([it.print is not None for it in items])
    reliable = np.nonzero(has_print & np.array([it.print_sec >= min_print_sec for it in items]))[0]
    unreliable = np.nonzero(has_print & np.array([it.print_sec < min_print_sec for it in items]))[0]

    rel_items = [items[i] for i in reliable]
    rel_prints = prints[reliable]
    if (link_distance is None or cannot_link_sim is None) and len(reliable) >= 2:
        found = derive_thresholds(
            separated_similarities(rel_items, rel_prints),
            cross_chunk_similarities(rel_items, rel_prints),
        )
        if found is not None:
            if link_distance is None:
                link, derived = found[0], True
            if cannot_link_sim is None:
                cannot, derived = found[1], True

    labels = np.full(n, -1)
    groups = 0
    if len(reliable) > 0:
        rel_labels = _cluster(rel_items, rel_prints, link, cannot, min_print_sec)
        labels[reliable] = rel_labels
        groups = int(rel_labels.max()) + 1
    # The chunks each group has a speaker in: a chunk's verdict holds in the later steps too.
    chunks_of: dict[int, set[int]] = {}
    for i in reliable:
        chunks_of.setdefault(int(labels[i]), set()).add(items[i].chunk)

    weights = np.array([it.sec for it in items], dtype=np.float64)
    if len(unreliable) > 0 and groups > 0:
        cent = np.zeros((groups, dim))
        for g in range(groups):
            members = reliable[labels[reliable] == g]
            cent[g] = (prints[members] * np.maximum(weights[members], 1e-6)[:, None]).sum(axis=0)
        cent /= np.maximum(np.linalg.norm(cent, axis=1, keepdims=True), 1e-12)
        sims = prints[unreliable] @ cent.T
        for row, i in enumerate(unreliable):
            # The nearest group close enough that has no speaker of this chunk:
            # the chunk's diarizer heard this voice apart from the one it has there.
            for g in np.argsort(-sims[row], kind="stable"):
                if 1.0 - sims[row, g] > link + JOIN_SLACK:
                    break
                if items[i].chunk in chunks_of.get(int(g), set()):
                    continue
                labels[i] = int(g)
                chunks_of.setdefault(int(g), set()).add(items[i].chunk)
                break
    for i in np.nonzero(labels < 0)[0]:
        labels[i] = groups
        chunks_of.setdefault(groups, set()).add(items[i].chunk)
        groups += 1

    # Each group as one speaker: talk time, print, pitch.
    sec = np.zeros(groups)
    g_prints: list[Optional[np.ndarray]] = []
    g_f0: list[Optional[float]] = []
    g_low: list[Optional[float]] = []
    for g in range(groups):
        members = np.nonzero(labels == g)[0]
        w = weights[members]
        sec[g] = w.sum()
        voiced = members[has_print[members]]
        if len(voiced) > 0:
            total = (prints[voiced] * np.maximum(weights[voiced], 1e-6)[:, None]).sum(axis=0)
            norm = float(np.linalg.norm(total))
            g_prints.append(total / norm if norm > 0 else None)
        else:
            g_prints.append(None)
        pitched = [m for m in members if items[m].f0_hz is not None]
        g_f0.append(
            round(_weighted_median(np.array([items[m].f0_hz for m in pitched]), np.maximum(weights[pitched], 1e-6)), 1)
            if pitched
            else None
        )
        shared = [m for m in members if items[m].low_share is not None]
        g_low.append(
            float(np.average([items[m].low_share for m in shared], weights=np.maximum(weights[shared], 1e-6))) if shared else None
        )
    g_gender = genders(g_prints, g_f0, g_low, list(sec))

    # The speakers who talk least merge into the nearest group of their gender.
    order = sorted(range(groups), key=lambda g: (-sec[g], g))
    keep, tail = order[:max_speakers], order[max_speakers:]
    target = {g: g for g in keep}
    for t in tail:
        same = [k for k in keep if g_gender[t].label != "unknown" and g_gender[k].label == g_gender[t].label]
        pool = same or keep
        # One that shares no chunk with it, when there is one: in a chunk they share, the diarizer kept them apart.
        apart = [k for k in pool if not (chunks_of.get(k, set()) & chunks_of.get(t, set()))]
        pool = apart or pool
        printed = [k for k in pool if g_prints[k] is not None]
        if g_prints[t] is not None and printed:
            target[t] = max(printed, key=lambda k: (float(g_prints[t] @ g_prints[k]), -k))
        else:
            target[t] = pool[0]  # the one who talks most
        chunks_of.setdefault(target[t], set()).update(chunks_of.get(t, set()))
    final_sec = {k: 0.0 for k in keep}
    for g in range(groups):
        final_sec[target[g]] += sec[g]
    ranked = sorted(keep, key=lambda k: (-final_sec[k], k))
    rank = {k: r for r, k in enumerate(ranked)}

    return LinkResult(
        labels=[rank[target[int(labels[i])]] for i in range(n)],
        speakers=[
            GlobalSpeaker(speaker=rank[k], sec=float(final_sec[k]), f0_hz=g_f0[k], gender=g_gender[k], print=g_prints[k])
            for k in ranked
        ],
        link_distance=link,
        cannot_link_sim=cannot,
        derived=derived,
    )
