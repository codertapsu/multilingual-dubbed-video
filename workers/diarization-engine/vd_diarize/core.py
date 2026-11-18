"""Diarization without the web server: read the audio, run sherpa-onnx, shape turns.

sherpa-onnx's offline diarization: pyannote segmentation 3.0 finds speech and
speaker changes in 10 s windows, a speaker-embedding model turns each stretch
into a voice print, and clustering groups the prints into speakers (a threshold
on their distance, or a known number of speakers). The models are files the
engine pack downloaded with pinned sha256 digests (enginePackCatalog.ts); this
module never fetches anything.

Measured in Phase 0 (2026-11-18) on 10-minute clips of real projects: about
0.07-0.09 of real time on 4 CPU threads.
"""

from __future__ import annotations

import os
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

SAMPLE_RATE = 16_000

# Where the pack's artifacts land (enginePackCatalog.ts `diarization-sherpa`).
SEGMENTATION_FILE = Path("sherpa-onnx-pyannote-segmentation-3-0") / "model.onnx"
EMBEDDING_FILE = Path("models") / "embedding.onnx"


def pack_dir() -> Path:
    return Path(os.environ.get("VD_PACK_DIR", ".")).resolve()


def model_paths(base: Optional[Path] = None) -> tuple[Path, Path]:
    root = base or pack_dir()
    return root / SEGMENTATION_FILE, root / EMBEDDING_FILE


def read_wav_16k_mono(path: str) -> np.ndarray:
    """The 16 kHz mono 16-bit WAV the pipeline extracts, as float32 in [-1, 1]."""
    with wave.open(path, "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(
                f"expected 16 kHz mono 16-bit audio, got {w.getframerate()} Hz, "
                f"{w.getnchannels()} channel(s), {8 * w.getsampwidth()}-bit"
            )
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


@dataclass(frozen=True)
class Turn:
    start_ms: int
    end_ms: int
    speaker: int


def shape_turns(raw: list[tuple[float, float, int]], min_ms: int = 0) -> list[Turn]:
    """Seconds to milliseconds, sorted, speakers renumbered by first appearance,
    turns shorter than `min_ms` dropped. Pure."""
    order: dict[int, int] = {}
    out: list[Turn] = []
    for start, end, speaker in sorted(raw, key=lambda t: (t[0], t[1])):
        s, e = int(round(start * 1000)), int(round(end * 1000))
        if e - s < max(1, min_ms):
            continue
        if speaker not in order:
            order[speaker] = len(order)
        out.append(Turn(s, e, order[speaker]))
    return out


class Diarizer:
    """One loaded sherpa-onnx diarizer per (threshold, speaker count)."""

    def __init__(self, threads: int, factory: Optional[Callable[..., Any]] = None) -> None:
        self.threads = max(1, threads)
        self._factory = factory
        self._cache: dict[tuple[float, int], Any] = {}

    def _build(self, threshold: float, num_speakers: int) -> Any:
        if self._factory is not None:
            return self._factory(threshold=threshold, num_speakers=num_speakers)
        import sherpa_onnx

        seg, emb = model_paths()
        for p in (seg, emb):
            if not p.is_file():
                raise FileNotFoundError(f"model missing: {p} (reinstall the speaker detection engine)")
        cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)),
                num_threads=self.threads,
                debug=False,
                provider="cpu",
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(emb), num_threads=self.threads, debug=False, provider="cpu"
            ),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=threshold),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not cfg.validate():
            raise RuntimeError("the diarization models did not validate")
        return sherpa_onnx.OfflineSpeakerDiarization(cfg)

    def run(self, samples: np.ndarray, threshold: float, num_speakers: int = -1) -> tuple[list[Turn], float]:
        key = (round(threshold, 3), num_speakers)
        if key not in self._cache:
            self._cache = {key: self._build(threshold, num_speakers)}  # one at a time: they hold the models
        t0 = time.perf_counter()
        result = self._cache[key].process(samples).sort_by_start_time()
        elapsed = time.perf_counter() - t0
        raw = [(float(r.start), float(r.end), int(r.speaker)) for r in result]
        return shape_turns(raw, min_ms=200), elapsed
