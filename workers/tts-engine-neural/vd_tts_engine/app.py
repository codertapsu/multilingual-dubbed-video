"""FastAPI server for the VieNeu neural-TTS engine pack.

Exposes the SAME contract as the bundled tts-worker so the orchestrator's
NeuralTtsProvider can call it unchanged (only the base URL differs):

    GET  /health               -> { status, engines }
    GET  /voices?language=…     -> { voices: [{ id, language, displayName, engine }] }
    POST /synthesize-segments  -> { segments: [...], engine, fallbackSegments }

Robustness: each segment is synthesized independently; if the neural engine isn't
loadable (deps/weights missing) or a segment errors, a placeholder SILENT WAV is
written for that segment and `fallbackSegments` is incremented — so a run never
hard-fails on TTS. The orchestrator's alignment/ffmpeg stage stretches each clip
to its timing window, so reported durations are the real measured WAV durations.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from . import voices
from .engine import VieNeuEngine
from .prereqs import espeak_ng_available
from .wavio import read_wav_duration_ms, write_silent_wav

logger = logging.getLogger("vd_tts_engine")

app = FastAPI(title="VideoDubber Neural TTS (VieNeu)", version="0.1.0")
_engine = VieNeuEngine()


# ---- schemas (mirror tts-worker app/schemas.py) ----------------------------


class SegmentIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    text: str
    startMs: int = Field(..., ge=0)
    endMs: int = Field(..., ge=0)


class SynthesizeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    language: str
    voiceId: str | None = None
    segments: list[SegmentIn] = Field(default_factory=list)
    outputDir: str
    speed: float = Field(default=1.0, gt=0.0)


class SegmentOut(BaseModel):
    segmentId: str
    audioPath: str
    durationMs: int
    startMs: int
    endMs: int
    speedRatio: float


class SynthesizeResponse(BaseModel):
    segments: list[SegmentOut]
    engine: str = "neural-tts"
    fallbackSegments: int = 0


class Voice(BaseModel):
    id: str
    language: str
    displayName: str
    engine: str


class VoicesResponse(BaseModel):
    voices: list[Voice]


class HealthResponse(BaseModel):
    status: str = "ok"
    engines: dict[str, bool]
    # System prerequisites the neural path needs (espeak-ng for phonemization).
    prerequisites: dict[str, bool] = Field(default_factory=dict)


# ---- routes ----------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        engines={voices.ENGINE_NAME: _engine.available(), "fallback": True},
        prerequisites={"espeak_ng": espeak_ng_available()},
    )


@app.get("/voices", response_model=VoicesResponse)
def list_voices(language: str | None = None) -> VoicesResponse:
    items = [
        Voice(id=v.id, language=voices.ENGINE_LANGUAGE, displayName=v.display_name, engine=voices.ENGINE_NAME)
        for v in voices.voices_for_language(language)
    ]
    return VoicesResponse(voices=items)


@app.post("/synthesize-segments", response_model=SynthesizeResponse)
def synthesize_segments(req: SynthesizeRequest) -> SynthesizeResponse:
    out_dir = Path(req.outputDir)
    out_dir.mkdir(parents=True, exist_ok=True)

    results: list[SegmentOut] = []
    fallback_count = 0

    for seg in req.segments:
        out_path = out_dir / f"{_safe_name(seg.id)}.wav"
        window_ms = max(0, seg.endMs - seg.startMs)
        try:
            _engine.synth(seg.text, str(out_path), req.voiceId, req.speed)
        except Exception as exc:  # noqa: BLE001
            # Graceful fallback: silence sized to the segment window.
            logger.warning("Neural synth failed for %s (%s); writing silence.", seg.id, exc)
            write_silent_wav(out_path, window_ms or 1000)
            fallback_count += 1

        results.append(
            SegmentOut(
                segmentId=seg.id,
                audioPath=str(out_path),
                durationMs=read_wav_duration_ms(out_path),
                startMs=seg.startMs,
                endMs=seg.endMs,
                # Synthesized at natural rate; downstream stretch fits the window.
                speedRatio=1.0,
            )
        )

    engine_name = "neural-tts" if fallback_count < len(results) else "fallback"
    return SynthesizeResponse(segments=results, engine=engine_name, fallbackSegments=fallback_count)


def _safe_name(segment_id: str) -> str:
    """Filesystem-safe basename from a segment id (no dots/slashes/traversal)."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", segment_id) or "segment"
