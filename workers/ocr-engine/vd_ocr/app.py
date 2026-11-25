"""HTTP face of the subtitle reader (the ocr-rapid engine pack).

  GET  /health  {"ok": true, "version", "engine", "threads"}
  POST /read    {framesPath, width, height, offset?, count?}
       -> {"results": [{"index", "text", "confidence", "lines"}], "processMs"}

`framesPath` is a file of raw grey frames (width × height bytes each, one after
another) that the media worker wrote: one crop of the subtitle band per
subtitle on screen. The orchestrator reads it in slices (offset, count) so a
4-hour video's 4,000 subtitles report progress instead of one silent request.
The recogniser (RapidOCR's PP-OCRv4, inside the rapidocr-onnxruntime wheel:
no download at run time) loads on the first request.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .core import read_frames

app = FastAPI(title="VideoDubber subtitle reader", version=__version__)

_lock = threading.Lock()
_engine = None


def _threads() -> int:
    """The thread count the orchestrator passes (0: the runtime's own choice)."""
    try:
        return max(0, int(os.environ.get("VD_OCR_THREADS", "0")))
    except ValueError:
        return 0


def _recogniser():
    """The PP-OCRv4 recogniser, loaded once (thread count: the performance cores the orchestrator passes)."""
    global _engine
    with _lock:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR

            threads = _threads()
            _engine = RapidOCR(intra_op_num_threads=threads) if threads > 0 else RapidOCR()
        return _engine


class ReadRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    frames_path: str = Field(alias="framesPath")
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=1024)
    offset: int = Field(default=0, ge=0)
    count: Optional[int] = Field(default=None, ge=1, le=5000)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "engine": "rapidocr-onnxruntime (PP-OCRv4)", "threads": _threads()}


@app.post("/read")
def read(req: ReadRequest) -> dict:
    if not os.path.isfile(req.frames_path):
        raise HTTPException(status_code=400, detail=f"No frames file at {req.frames_path}")
    size = req.width * req.height
    total = os.path.getsize(req.frames_path) // size
    if req.offset > total:
        raise HTTPException(status_code=400, detail=f"offset {req.offset} is past the {total} frames")
    count = total - req.offset if req.count is None else min(req.count, total - req.offset)
    started = time.perf_counter()
    frames = np.memmap(req.frames_path, dtype=np.uint8, mode="r", offset=req.offset * size, shape=(count, req.height, req.width))
    engine = _recogniser()

    def recognise(images):
        # RapidOCR's recogniser alone, batched: (results, elapsed).
        found, _ = engine.text_rec(list(images))
        return [(str(t), float(s)) for t, s in found]

    results = read_frames(np.asarray(frames), recognise, first_index=req.offset)
    return {
        "results": [{"index": r.index, "text": r.text, "confidence": r.confidence, "lines": r.lines} for r in results],
        "processMs": round((time.perf_counter() - started) * 1000),
    }
