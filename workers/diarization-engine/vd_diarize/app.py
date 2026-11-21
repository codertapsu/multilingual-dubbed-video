"""HTTP face of the diarization engine.

  GET  /health                         {"ok": true, "version", "models": {...}}
  POST /diarize {audioPath, threshold?, numSpeakers?, withSpeakers?}
       -> {"turns": [{"startMs", "endMs", "speaker"}], "speakers", "processMs",
           "speakerInfo"?: [{"speaker", "sec", "printSec", "print", "f0Hz",
                             "lowShare", "gender", "genderConfidence"}]}
  POST /diarize-chunk {audioPath, startMs, endMs, threshold?, numSpeakers?,
                       maxPrintPieces?, maxPieceSec?, maxPrintSec?}
       -> {"turns": [{"startMs", "endMs", "speaker"}], "speakers":
           [{"local", "sec", "printSec", "print", "f0Hz", "lowShare"}], "processMs"}
  POST /link {items: [{chunk, local, sec, printSec, print, f0Hz?, lowShare?}],
              minPrintSec?, maxSpeakers?, linkThreshold?, cannotLinkSim?}
       -> {"assignments": [{"chunk", "local", "speaker"}], "speakers":
           [{"speaker", "sec", "f0Hz", "gender", "genderConfidence", "print"}],
           "thresholds": {"link", "cannotLink", "derived"}}
  POST /embed {audioPath, startMs?, endMs?}
       -> {"print", "f0Hz", "lowShare", "speechSec"}
     the voice of one short clean recording (a cloned voice's preview.wav, any
     PCM WAV), its print in the same space as the detected speakers': a clone's
     gender is judged against the cast by print, since pitch misleads (a male
     clone at 194 Hz sits above a female one at 174 Hz).

`audioPath` is the project's audio/original_16k_mono.wav (the orchestrator
sends only that). /diarize reads it in one pass and numbers speakers from 0 in
order of first appearance; it is for audio under 20 minutes. Longer audio goes
through /diarize-chunk, one 10-minute window per request (turns in absolute ms,
speakers numbered locally per window), then /link, which numbers the speakers
of the whole file by talk time (0 talks most). Field report 2026-11-21, B2:
one /diarize over 10 hours ran 2 h 56 min, held 2.3 GB of samples, and ended
in HTTP 500 with no speakers.
"""

from __future__ import annotations

import os
import threading
import time
import wave
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .core import (
    AudioTooLong,
    Diarizer,
    Embedder,
    model_paths,
    read_audio_window,
    read_wav_16k_mono,
    read_wav_window,
    wav_duration_ms,
)
from .gender import genders
from .linking import LinkItem, link_speakers
from .prints import profile_json, recording_voice, speaker_profiles

# The threshold measured for the pack's embedding model, ERes2Net (Phase 0,
# 0.6-diarization; the orchestrator's DIARIZATION_EMBEDDING says why). The
# orchestrator sends its own; this is only the fallback.
DEFAULT_THRESHOLD = float(os.environ.get("VD_DIARIZE_THRESHOLD", "0.7"))

# One pass holds every sample and clusters every window embedding at once.
# The orchestrator goes to chunks from 20 minutes; past an hour a single pass
# is refused outright instead of failing hours later.
ONE_PASS_MAX_MS = 60 * 60_000
# /embed is for a short recording read whole into memory: a preview, a clip.
EMBED_MAX_MS = 10 * 60_000


def _threads() -> int:
    try:
        return int(os.environ.get("VD_DIARIZE_THREADS", "0")) or min(8, os.cpu_count() or 4)
    except ValueError:
        return 4


app = FastAPI(title="VideoDubber speaker diarization", version=__version__)
_diarizer: Optional[Diarizer] = None
_embedder: Optional[Embedder] = None
# FastAPI runs these handlers on a thread pool, and two projects detecting at
# once would share one loaded model: one request at a time uses them.
_models_lock = threading.Lock()


def diarizer() -> Diarizer:
    global _diarizer
    if _diarizer is None:
        _diarizer = Diarizer(_threads())
    return _diarizer


def embedder() -> Embedder:
    global _embedder
    if _embedder is None:
        _embedder = Embedder(_threads())
    return _embedder


class DiarizeRequest(BaseModel):
    audioPath: str
    threshold: Optional[float] = Field(default=None, gt=0.0, lt=2.0)
    # -1: decide from the threshold; otherwise exactly this many speakers.
    numSpeakers: int = Field(default=-1, ge=-1, le=50)
    # Also each speaker's voice print, pitch and gender (for casting voices).
    withSpeakers: bool = False


class ChunkRequest(BaseModel):
    audioPath: str
    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)
    threshold: Optional[float] = Field(default=None, gt=0.0, lt=2.0)
    numSpeakers: int = Field(default=-1, ge=-1, le=50)
    # At most this many pieces per print: 20 made each 10-minute chunk of the
    # production run cost about 4 minutes.
    maxPrintPieces: int = Field(default=8, ge=1, le=50)
    maxPieceSec: float = Field(default=8.0, ge=0.5, le=60.0)
    maxPrintSec: float = Field(default=45.0, ge=0.5, le=600.0)


class EmbedRequest(BaseModel):
    audioPath: str
    startMs: Optional[int] = Field(default=None, ge=0)
    endMs: Optional[int] = Field(default=None, gt=0)


class LinkItemBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    chunk: int = Field(ge=0)
    local: int = Field(ge=0)
    sec: float = Field(ge=0.0)
    printSec: float = Field(default=0.0, ge=0.0)
    vector: list[float] = Field(default_factory=list, alias="print")
    f0Hz: Optional[float] = Field(default=None, gt=0.0)
    lowShare: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class LinkRequest(BaseModel):
    items: list[LinkItemBody]
    minPrintSec: float = Field(default=3.0, ge=0.0)
    maxSpeakers: int = Field(default=100, ge=1, le=1000)
    linkThreshold: Optional[float] = Field(default=None, gt=0.0, lt=2.0)
    cannotLinkSim: Optional[float] = Field(default=None, gt=-1.0, lt=1.0)


def _turn_json(t, offset_ms: int = 0) -> dict:
    return {"startMs": t.start_ms + offset_ms, "endMs": t.end_ms + offset_ms, "speaker": t.speaker}


def _print_json(vec: Optional[np.ndarray]) -> list[float]:
    return [round(float(v), 6) for v in vec] if vec is not None else []


@app.get("/health")
def health() -> dict:
    seg, emb = model_paths()
    return {
        "ok": True,
        "version": __version__,
        "models": {"segmentation": seg.is_file(), "embedding": emb.is_file()},
        "threads": diarizer().threads,
    }


@app.post("/diarize")
def diarize(req: DiarizeRequest) -> dict:
    if not os.path.isfile(req.audioPath):
        raise HTTPException(status_code=400, detail="audioPath does not exist")
    try:
        if wav_duration_ms(req.audioPath) > ONE_PASS_MAX_MS:
            raise HTTPException(
                status_code=413,
                detail="audio too long for one pass: detect it in chunks (POST /diarize-chunk, then /link)",
            )
        samples = read_wav_16k_mono(req.audioPath)
    except (ValueError, EOFError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if samples.size == 0:
        return {"turns": [], "speakers": 0, "processMs": 0, **({"speakerInfo": []} if req.withSpeakers else {})}
    threshold = req.threshold if req.threshold is not None else DEFAULT_THRESHOLD
    t0 = time.perf_counter()
    try:
        with _models_lock:
            turns, _ = diarizer().run(samples, threshold, req.numSpeakers)
            profiles = speaker_profiles(samples, turns, embedder().embed) if req.withSpeakers else []
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    body: dict = {
        "turns": [_turn_json(t) for t in turns],
        "speakers": len({t.speaker for t in turns}),
    }
    if req.withSpeakers:
        found = genders([p.print for p in profiles], [p.f0_hz for p in profiles], [p.low_share for p in profiles], [p.sec for p in profiles])
        body["speakerInfo"] = [
            {
                "speaker": p.local,
                "sec": round(p.sec, 2),
                "printSec": round(p.print_sec, 2),
                "print": _print_json(p.print),
                "f0Hz": p.f0_hz,
                "lowShare": p.low_share,
                "gender": g.label,
                "genderConfidence": g.confidence,
            }
            for p, g in zip(profiles, found)
        ]
    body["processMs"] = int((time.perf_counter() - t0) * 1000)
    return body


@app.post("/diarize-chunk")
def diarize_chunk(req: ChunkRequest) -> dict:
    if not os.path.isfile(req.audioPath):
        raise HTTPException(status_code=400, detail="audioPath does not exist")
    if req.endMs <= req.startMs:
        raise HTTPException(status_code=400, detail="endMs must be after startMs")
    try:
        samples = read_wav_window(req.audioPath, req.startMs, req.endMs)
    except (ValueError, EOFError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    t0 = time.perf_counter()
    # Under a second there is no speaker to tell apart (diar_chunks.py).
    if samples.size < 16_000:
        return {"turns": [], "speakers": [], "processMs": 0}
    threshold = req.threshold if req.threshold is not None else DEFAULT_THRESHOLD
    try:
        with _models_lock:
            turns, _ = diarizer().run(samples, threshold, req.numSpeakers)
            profiles = speaker_profiles(
                samples,
                turns,
                embedder().embed,
                max_pieces=req.maxPrintPieces,
                max_piece_ms=int(req.maxPieceSec * 1000),
                max_print_ms=int(req.maxPrintSec * 1000),
            )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "turns": [_turn_json(t, req.startMs) for t in turns],
        "speakers": [profile_json(p) for p in profiles],
        "processMs": int((time.perf_counter() - t0) * 1000),
    }


@app.post("/embed")
def embed(req: EmbedRequest) -> dict:
    if not os.path.isfile(req.audioPath):
        raise HTTPException(status_code=400, detail="audioPath does not exist")
    if req.startMs is not None and req.endMs is not None and req.endMs <= req.startMs:
        raise HTTPException(status_code=400, detail="endMs must be after startMs")
    try:
        audio = read_audio_window(req.audioPath, req.startMs, req.endMs, max_ms=EMBED_MAX_MS)
    except AudioTooLong as exc:
        raise HTTPException(status_code=413, detail=f"too long to embed whole ({exc}): send a window") from exc
    except (ValueError, EOFError, wave.Error) as exc:
        raise HTTPException(status_code=400, detail=f"not a PCM WAV file: {exc}") from exc
    try:
        with _models_lock:
            return recording_voice(audio, embedder().embed)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/link")
def link(req: LinkRequest) -> dict:
    dims = {len(it.vector) for it in req.items if it.vector}
    if len(dims) > 1:
        raise HTTPException(status_code=400, detail=f"voice prints of different sizes: {sorted(dims)}")
    if len({(it.chunk, it.local) for it in req.items}) != len(req.items):
        raise HTTPException(status_code=400, detail="each (chunk, local) speaker may appear once")
    items = [
        LinkItem(
            chunk=it.chunk,
            local=it.local,
            sec=it.sec,
            print_sec=it.printSec,
            print=np.asarray(it.vector, dtype=np.float64) if it.vector else None,
            f0_hz=it.f0Hz,
            low_share=it.lowShare,
        )
        for it in req.items
    ]
    found = link_speakers(
        items,
        min_print_sec=req.minPrintSec,
        max_speakers=req.maxSpeakers,
        link_distance=req.linkThreshold,
        cannot_link_sim=req.cannotLinkSim,
    )
    return {
        "assignments": [{"chunk": it.chunk, "local": it.local, "speaker": s} for it, s in zip(items, found.labels)],
        "speakers": [
            {
                "speaker": s.speaker,
                "sec": round(s.sec, 2),
                "f0Hz": s.f0_hz,
                "gender": s.gender.label,
                "genderConfidence": s.gender.confidence,
                "print": _print_json(s.print),
            }
            for s in found.speakers
        ],
        "thresholds": {"link": found.link_distance, "cannotLink": found.cannot_link_sim, "derived": found.derived},
    }
