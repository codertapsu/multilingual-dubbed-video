"""Diarization without the web server: read the audio, run sherpa-onnx, shape turns.

sherpa-onnx's offline diarization: pyannote segmentation 3.0 finds speech and
speaker changes in 10 s windows, a speaker-embedding model turns each stretch
into a voice print, and clustering groups the prints into speakers (a threshold
on their distance, or a known number of speakers). The models are files the
engine pack downloaded with pinned sha256 digests (enginePackCatalog.ts); this
module never fetches anything.

Measured in Phase 0 (2026-11-18) on 10-minute clips of real projects: about
0.07-0.09 of real time on 4 CPU threads. That does NOT hold for a whole long
file: one pass over 10 hours ran 2 h 56 min and died with HTTP 500 (field
report 2026-11-21, B2), most likely in sherpa's clustering, which compares
every window embedding with every other. Long audio is therefore detected in
10-minute windows (`read_wav_window`, POST /diarize-chunk) and the speakers
are linked across them afterwards (linking.py).
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


def _check_format(w: wave.Wave_read) -> None:
    if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
        raise ValueError(
            f"expected 16 kHz mono 16-bit audio, got {w.getframerate()} Hz, "
            f"{w.getnchannels()} channel(s), {8 * w.getsampwidth()}-bit"
        )


def read_wav_16k_mono(path: str) -> np.ndarray:
    """The 16 kHz mono 16-bit WAV the pipeline extracts, as float32 in [-1, 1]."""
    with wave.open(path, "rb") as w:
        _check_format(w)
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def wav_duration_ms(path: str) -> int:
    """Length of the 16 kHz mono WAV, from its header only."""
    with wave.open(path, "rb") as w:
        _check_format(w)
        return w.getnframes() * 1000 // SAMPLE_RATE


def read_wav_window(path: str, start_ms: int, end_ms: int) -> np.ndarray:
    """[start_ms, end_ms) of the 16 kHz mono WAV, as float32 in [-1, 1].

    Seeks instead of reading the file: a 10-hour track is 1.15 GB on disk and
    2.3 GB as float32, which the one-pass request of the field report loaded
    whole. A window past the end is cut at the end (or empty).
    """
    with wave.open(path, "rb") as w:
        _check_format(w)
        total = w.getnframes()
        first = min(total, max(0, int(start_ms) * SAMPLE_RATE // 1000))
        last = min(total, max(first, int(end_ms) * SAMPLE_RATE // 1000))
        w.setpos(first)
        data = w.readframes(last - first)
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


class AudioTooLong(ValueError):
    """A recording longer than the caller allows."""


def _pcm_to_float(data: bytes, width: int) -> np.ndarray:
    if width == 1:  # unsigned 8-bit
        return (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if width == 2:
        return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    if width == 3:
        b = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        return v.astype(np.float32) / float(1 << 23)
    if width == 4:
        return (np.frombuffer(data, dtype="<i4").astype(np.float64) / float(1 << 31)).astype(np.float32)
    raise ValueError(f"unsupported sample width: {8 * width}-bit")


def resample_to_16k(x: np.ndarray, rate: int) -> np.ndarray:
    """Band-limited FFT resampling (voice_embed.py's), numpy only."""
    if rate == SAMPLE_RATE or x.size == 0:
        return x.astype(np.float32)
    n_out = int(round(x.size * SAMPLE_RATE / rate))
    spectrum = np.fft.rfft(x.astype(np.float64))
    return (np.fft.irfft(spectrum[: n_out // 2 + 1], n_out) * (n_out / x.size)).astype(np.float32)


def read_audio_window(path: str, start_ms: Optional[int] = None, end_ms: Optional[int] = None, max_ms: Optional[int] = None) -> np.ndarray:
    """Any PCM WAV (any rate, channels, 8-32 bit), or a window of it, as 16 kHz
    mono float32. A cloned voice's preview is what the TTS engine wrote (VieNeu:
    24 kHz), not the pipeline's 16 kHz mono track. Raises AudioTooLong past
    `max_ms`, ValueError (or wave.Error) for anything that is not PCM WAV."""
    with wave.open(path, "rb") as w:
        rate, channels, width, total = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        first = min(total, max(0, (start_ms or 0) * rate // 1000))
        last = total if end_ms is None else min(total, max(first, end_ms * rate // 1000))
        if max_ms is not None and (last - first) * 1000 > max_ms * rate:
            raise AudioTooLong(f"{(last - first) / rate:.0f} s of audio; at most {max_ms // 1000} s")
        w.setpos(first)
        data = w.readframes(last - first)
    x = _pcm_to_float(data, width)
    if channels > 1:
        x = x[: x.size - x.size % channels].reshape(-1, channels).mean(axis=1)
    return resample_to_16k(x, rate)


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


class Embedder:
    """The diarizer's own embedding model on its own, for voice prints.

    sherpa-onnx's diarizer keeps its window embeddings to itself (its result
    has only start, end and speaker), so the prints are computed again over
    each speaker's clean pieces, with the very same model file: prints and
    clustering then measure voices the same way. Loaded once, like Diarizer.
    """

    def __init__(self, threads: int, factory: Optional[Callable[[], Any]] = None) -> None:
        self.threads = max(1, threads)
        self._factory = factory
        self._extractor: Any = None

    def _build(self) -> Any:
        if self._factory is not None:
            return self._factory()
        import sherpa_onnx

        _, emb = model_paths()
        if not emb.is_file():
            raise FileNotFoundError(f"model missing: {emb} (reinstall the speaker detection engine)")
        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(emb), num_threads=self.threads, debug=False, provider="cpu"
        )
        if not cfg.validate():
            raise RuntimeError("the speaker embedding model did not validate")
        return sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def embed(self, samples: np.ndarray) -> Optional[np.ndarray]:
        """L2-normalised embedding of `samples`; None when there is too little audio for one."""
        if self._extractor is None:
            self._extractor = self._build()
        ext = self._extractor
        stream = ext.create_stream()
        stream.accept_waveform(SAMPLE_RATE, np.ascontiguousarray(samples, dtype=np.float32))
        stream.input_finished()
        if not ext.is_ready(stream):
            return None
        vec = np.asarray(ext.compute(stream), dtype=np.float64)
        norm = float(np.linalg.norm(vec))
        return vec / norm if norm > 0 and np.isfinite(norm) else None
