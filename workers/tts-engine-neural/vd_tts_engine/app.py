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


# ---- routes ----------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(engines={voices.ENGINE_NAME: _engine.available(), "fallback": True})


@app.get("/voices", response_model=VoicesResponse)
def list_voices(language: str | None = None) -> VoicesResponse:
    items = [
        Voice(id=v.id, language=voices.ENGINE_LANGUAGE, displayName=v.display_name, engine=voices.ENGINE_NAME)
        for v in voices.voices_for_language(_engine.variant, language)
    ]
    return VoicesResponse(voices=items)


@app.post("/synthesize-segments", response_model=SynthesizeResponse)
def synthesize_segments(req: SynthesizeRequest) -> SynthesizeResponse:
    out_dir = Path(req.outputDir)
    out_dir.mkdir(parents=True, exist_ok=True)

    results: list[SegmentOut] = []
    fallback_count = 0

    for ordinal, seg in enumerate(req.segments, start=1):
        out_path = out_dir / segment_filename(seg.id, ordinal)
        window_ms = max(0, seg.endMs - seg.startMs)
        try:
            _engine.synth(seg.text, str(out_path), req.voiceId, req.speed)
        except Exception as exc:  # noqa: BLE001
            # Graceful fallback: silence sized to the segment window.
            logger.warning("Neural synth failed for %s (%s); writing silence.", seg.id, exc)
            write_silent_wav(out_path, window_ms or 1000, sample_rate=_engine.sample_rate)
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


# Pull the TRAILING digits out of an id like "seg_0001" -> 1, falling back to the
# 1-based ordinal if the id has no number. This MUST match BOTH the orchestrator's
# segmentIdToIndex() (/(\d+)\s*$/) and the bundled Piper tts-worker, so every TTS
# backend writes the SAME `segment_NNNN.wav` the orchestrator later probes at
# alignment and reads at audio-mix. (Naming files by the raw id, e.g.
# "seg_0001.wav", is why mixing failed with "input file does not exist".)
_DIGITS_RE = re.compile(r"(\d+)\s*$")


def segment_filename(segment_id: str, ordinal: int) -> str:
    """Map a segment id to its WAV filename `segment_<4-digit>.wav` (e.g.
    "seg_0007" -> "segment_0007.wav"); falls back to the 1-based ordinal when the
    id has no digits."""
    match = _DIGITS_RE.search(segment_id or "")
    number = int(match.group(1)) if match else ordinal
    return f"segment_{number:04d}.wav"
