"""What each speaker of a stretch of audio sounds like: a voice print and a pitch.

Ported from the scripts that rescued the 10-hour drama of the field report
(2026-11-21, B2: diar_chunks.py, local_pitch.py, speaker_pitch2.py), whose
prints linked 60 ten-minute chunks into the speakers of the whole video.

A voice print is the duration-weighted mean of the L2-normalised embeddings of
a speaker's longest CLEAN pieces (no other speaker's turn over them), each cut
to its middle `max_piece_ms`, at most `max_pieces` of them and `max_print_ms`
in all, normalised again. The production run took up to 20 pieces and each
chunk then cost about 4 minutes; the longest 8 carry nearly all of the print.

Pitch (F0, YIN, numpy only) is measured on the same pieces. It is a soft
gender hint and a casting aid, never a linking distance: shouting men measured
300-400 Hz in that drama, and a pitch penalty in the linking split a man's
shouting from his normal voice.

Pure apart from the injected `embed` function (Embedder.embed in production).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Sequence

import numpy as np

from .core import SAMPLE_RATE, Turn

# A clean piece shorter than this is mostly a word's edge: it does not count.
MIN_CLEAN_PIECE_MS = 800
# Without clean pieces, the speaker's own turns down to this length.
MIN_PIECE_MS = 400
# Pitch is read from at most this much of a speaker (local_pitch.py: 30 s).
PITCH_MAX_MS = 30_000
# Below this a voice is "low": the share of such frames tells a deep voice
# from a raised one at the same median (refine_speakers.py's table).
LOW_PITCH_HZ = 165.0
# Fewer voiced frames than this (0.2 s) say nothing about a voice.
MIN_VOICED_FRAMES = 20

Interval = tuple[int, int]


@dataclass(frozen=True)
class SpeakerProfile:
    """One local speaker: talk time, voice print (None when no piece could be embedded), pitch."""

    local: int
    sec: float
    print_sec: float
    print: Optional[np.ndarray]
    f0_hz: Optional[float]
    low_share: Optional[float]


def subtract(interval: Interval, others: Sequence[Interval]) -> list[Interval]:
    """The parts of `interval` that no interval of `others` covers. Pure."""
    out = [interval]
    for c, d in others:
        if d <= interval[0] or c >= interval[1]:
            continue
        nxt: list[Interval] = []
        for a, b in out:
            if d <= a or c >= b:
                nxt.append((a, b))
                continue
            if c > a:
                nxt.append((a, c))
            if d < b:
                nxt.append((d, b))
        out = nxt
    return out


def print_pieces(
    mine: Sequence[Interval],
    others: Sequence[Interval],
    max_pieces: int,
    max_piece_ms: int,
    max_total_ms: int,
) -> list[Interval]:
    """The stretches a speaker's print is made of: the longest clean pieces,
    each cut to its middle `max_piece_ms`, until `max_pieces` or `max_total_ms`.
    Falls back to the speaker's own turns (overlapped or not), then to the
    longest one whatever its length. Pure."""
    clean = [p for iv in mine for p in subtract(iv, others) if p[1] - p[0] >= MIN_CLEAN_PIECE_MS]
    pool = clean or [iv for iv in mine if iv[1] - iv[0] >= MIN_PIECE_MS]
    if not pool and mine:
        pool = [max(mine, key=lambda iv: (iv[1] - iv[0], -iv[0]))]
    pool = sorted(pool, key=lambda p: (-(p[1] - p[0]), p[0]))
    out: list[Interval] = []
    used = 0
    for a, b in pool:
        if len(out) >= max_pieces:
            break
        room = max_total_ms - used
        if room < MIN_PIECE_MS and out:
            break
        length = min(b - a, max_piece_ms, max(room, 0))
        if length <= 0:
            break
        start = (a + b) // 2 - length // 2
        out.append((start, start + length))
        used += length
    return out


def _samples(audio: np.ndarray, piece: Interval) -> np.ndarray:
    a, b = piece
    return audio[a * SAMPLE_RATE // 1000 : b * SAMPLE_RATE // 1000]


def voice_print(
    audio: np.ndarray,
    pieces: Sequence[Interval],
    embed: Callable[[np.ndarray], Optional[np.ndarray]],
) -> tuple[Optional[np.ndarray], float]:
    """Duration-weighted mean of the pieces' normalised embeddings, normalised;
    with the seconds it was made from. (None, 0) when nothing could be embedded."""
    vectors: list[np.ndarray] = []
    weights: list[float] = []
    for piece in pieces:
        clip = _samples(audio, piece)
        if clip.size == 0:
            continue
        vec = embed(clip)
        if vec is None:
            continue
        vec = np.asarray(vec, dtype=np.float64)
        norm = float(np.linalg.norm(vec))
        if norm == 0 or not np.isfinite(norm):
            continue
        vectors.append(vec / norm)
        weights.append(clip.size / SAMPLE_RATE)
    if not vectors:
        return None, 0.0
    mean = (np.stack(vectors) * np.asarray(weights)[:, None]).sum(axis=0)
    norm = float(np.linalg.norm(mean))
    if norm == 0 or not np.isfinite(norm):
        return None, 0.0
    return mean / norm, float(sum(weights))


# YIN over 40 ms frames every 10 ms, F0 between 70 and 450 Hz (speaker_pitch2.py).
_FRAME = int(0.04 * SAMPLE_RATE)
_HOP = int(0.01 * SAMPLE_RATE)
_TAU_MIN = SAMPLE_RATE // 450
_TAU_MAX = SAMPLE_RATE // 70
_FFT = 1 << int(np.ceil(np.log2(2 * (_FRAME + _TAU_MAX))))
# Frames per FFT batch: bounds the memory to some tens of MB whatever the length.
_BATCH = 1024


def yin_f0(x: np.ndarray, threshold: float = 0.15) -> np.ndarray:
    """F0 in Hz of each voiced frame of `x` (YIN, vectorised over frames). Frames
    quieter than an RMS of 0.01 or without a dip below `threshold` are left out."""
    x = np.asarray(x, dtype=np.float64)
    if x.size < _FRAME + _TAU_MAX + 1:
        return np.zeros(0)
    windows = np.lib.stride_tricks.sliding_window_view(x, _FRAME + _TAU_MAX)[: x.size - _FRAME - _TAU_MAX : _HOP]
    taus = np.arange(_TAU_MAX + 1)
    out: list[np.ndarray] = []
    for first in range(0, len(windows), _BATCH):
        frames = np.array(windows[first : first + _BATCH])
        rms = np.sqrt((frames[:, :_FRAME] ** 2).mean(axis=1))
        frames = frames[rms >= 0.01]
        if len(frames) == 0:
            continue
        # d(tau) = sum_j (x_j - x_{j+tau})^2 through energies and one correlation.
        a = np.fft.rfft(frames[:, :_FRAME], _FFT)
        b = np.fft.rfft(frames, _FFT)
        cross = np.fft.irfft(np.conj(a) * b, _FFT)[:, : _TAU_MAX + 1]
        energy = np.concatenate([np.zeros((len(frames), 1)), np.cumsum(frames**2, axis=1)], axis=1)
        d = energy[:, _FRAME][:, None] + (energy[:, taus + _FRAME] - energy[:, taus]) - 2 * cross
        d[:, 0] = 0
        cmnd = np.ones_like(d)
        cmnd[:, 1:] = d[:, 1:] * np.arange(1, _TAU_MAX + 1) / np.maximum(np.cumsum(d[:, 1:], axis=1), 1e-12)
        below = cmnd[:, _TAU_MIN:] < threshold
        voiced = below.any(axis=1)
        if not voiced.any():
            continue
        rows = np.nonzero(voiced)[0]
        tau = below[voiced].argmax(axis=1) + _TAU_MIN
        # Walk down to the dip's bottom, as YIN does.
        for _ in range(_TAU_MAX):
            step = np.minimum(tau + 1, _TAU_MAX)
            move = (tau < _TAU_MAX) & (cmnd[rows, step] < cmnd[rows, tau])
            if not move.any():
                break
            tau = np.where(move, tau + 1, tau)
        out.append(SAMPLE_RATE / tau)
    return np.concatenate(out) if out else np.zeros(0)


def pitch_stats(audio: np.ndarray, pieces: Sequence[Interval], max_ms: int = PITCH_MAX_MS) -> tuple[Optional[float], Optional[float]]:
    """Median F0 of the voiced frames of `pieces` (up to `max_ms` of them), and
    the share of those frames under LOW_PITCH_HZ. (None, None) with too few frames."""
    found: list[np.ndarray] = []
    used = 0
    for a, b in pieces:
        if used >= max_ms:
            break
        b = min(b, a + (max_ms - used))
        found.append(yin_f0(_samples(audio, (a, b))))
        used += b - a
    frames = np.concatenate(found) if found else np.zeros(0)
    if frames.size < MIN_VOICED_FRAMES:
        return None, None
    return round(float(np.median(frames)), 1), round(float((frames < LOW_PITCH_HZ).mean()), 3)


def speaker_profiles(
    audio: np.ndarray,
    turns: Sequence[Turn],
    embed: Callable[[np.ndarray], Optional[np.ndarray]],
    max_pieces: int = 8,
    max_piece_ms: int = 8_000,
    max_print_ms: int = 45_000,
) -> list[SpeakerProfile]:
    """A profile per speaker of `turns` (timed in ms from the start of `audio`), by speaker number."""
    by_speaker: dict[int, list[Interval]] = {}
    for t in turns:
        by_speaker.setdefault(t.speaker, []).append((t.start_ms, t.end_ms))
    profiles: list[SpeakerProfile] = []
    for speaker in sorted(by_speaker):
        mine = by_speaker[speaker]
        others = [iv for s, ivs in by_speaker.items() if s != speaker for iv in ivs]
        pieces = print_pieces(mine, others, max_pieces, max_piece_ms, max_print_ms)
        vec, print_sec = voice_print(audio, pieces, embed)
        f0, low = pitch_stats(audio, pieces)
        profiles.append(
            SpeakerProfile(
                local=speaker,
                sec=sum(b - a for a, b in mine) / 1000,
                print_sec=print_sec,
                print=vec,
                f0_hz=f0,
                low_share=low,
            )
        )
    return profiles


def speech_runs(audio: np.ndarray, frame_ms: int = 20, floor: float = 0.005) -> list[Interval]:
    """Where a clean recording speaks: 20 ms frames within 20 dB of its loud
    level (and above a floor for silent files), runs closer than 300 ms joined,
    runs under 200 ms dropped. Enough for a voice preview; a soundtrack needs
    the diarizer. Pure."""
    step = SAMPLE_RATE * frame_ms // 1000
    frames = audio.size // step
    if frames == 0:
        return []
    rms = np.sqrt((audio[: frames * step].astype(np.float64).reshape(frames, step) ** 2).mean(axis=1))
    loud = np.nonzero(rms >= max(floor, 0.1 * float(np.percentile(rms, 95))))[0]
    runs: list[Interval] = []
    for f in loud:
        a, b = int(f) * frame_ms, (int(f) + 1) * frame_ms
        if runs and a - runs[-1][1] < 300:
            runs[-1] = (runs[-1][0], b)
        else:
            runs.append((a, b))
    return [r for r in runs if r[1] - r[0] >= 200]


def recording_voice(
    audio: np.ndarray,
    embed: Callable[[np.ndarray], Optional[np.ndarray]],
    max_pieces: int = 8,
    max_piece_ms: int = 8_000,
    max_print_ms: int = 45_000,
) -> dict:
    """POST /embed: the voice of one recording, its print made exactly like a
    detected speaker's so the two compare (a clone against the cast)."""
    runs = speech_runs(audio)
    pieces = print_pieces(runs, [], max_pieces, max_piece_ms, max_print_ms)
    vec, _ = voice_print(audio, pieces, embed)
    f0, low = pitch_stats(audio, pieces)
    return {
        "print": [round(float(v), 6) for v in vec] if vec is not None else [],
        "f0Hz": f0,
        "lowShare": low,
        "speechSec": round(sum(b - a for a, b in runs) / 1000, 2),
    }


def profile_json(p: SpeakerProfile) -> dict:
    """The wire form of a profile (POST /diarize-chunk's `speakers`)."""
    return {
        "local": p.local,
        "sec": round(p.sec, 2),
        "printSec": round(p.print_sec, 2),
        "print": [round(float(v), 6) for v in p.print] if p.print is not None else [],
        "f0Hz": p.f0_hz,
        "lowShare": p.low_share,
    }
