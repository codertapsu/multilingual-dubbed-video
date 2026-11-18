"""HTTP face of the diarization engine.

  GET  /health                         {"ok": true, "version", "models": {...}}
  POST /diarize {audioPath, threshold?, numSpeakers?}
       -> {"turns": [{"startMs", "endMs", "speaker"}], "speakers", "processMs"}

`audioPath` is the project's audio/original_16k_mono.wav (the orchestrator
sends only that); `speaker` numbers start at 0 in order of first appearance.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .core import Diarizer, model_paths, read_wav_16k_mono

# The threshold measured for the pack's embedding model, ERes2Net (Phase 0,
# 0.6-diarization; the orchestrator's DIARIZATION_EMBEDDING says why). The
# orchestrator sends its own; this is only the fallback.
DEFAULT_THRESHOLD = float(os.environ.get("VD_DIARIZE_THRESHOLD", "0.7"))


def _threads() -> int:
    try:
        return int(os.environ.get("VD_DIARIZE_THREADS", "0")) or min(8, os.cpu_count() or 4)
    except ValueError:
        return 4


app = FastAPI(title="VideoDubber speaker diarization", version=__version__)
_diarizer: Optional[Diarizer] = None


def diarizer() -> Diarizer:
    global _diarizer
    if _diarizer is None:
        _diarizer = Diarizer(_threads())
    return _diarizer


class DiarizeRequest(BaseModel):
    audioPath: str
    threshold: Optional[float] = Field(default=None, gt=0.0, lt=2.0)
    # -1: decide from the threshold; otherwise exactly this many speakers.
    numSpeakers: int = Field(default=-1, ge=-1, le=50)


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
        samples = read_wav_16k_mono(req.audioPath)
    except (ValueError, EOFError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if samples.size == 0:
        return {"turns": [], "speakers": 0, "processMs": 0}
    threshold = req.threshold if req.threshold is not None else DEFAULT_THRESHOLD
    try:
        turns, elapsed = diarizer().run(samples, threshold, req.numSpeakers)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "turns": [{"startMs": t.start_ms, "endMs": t.end_ms, "speaker": t.speaker} for t in turns],
        "speakers": len({t.speaker for t in turns}),
        "processMs": int(elapsed * 1000),
    }
