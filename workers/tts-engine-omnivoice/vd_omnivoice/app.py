"""FastAPI server for the OmniVoice neural-TTS engine pack.

Exposes the SAME contract as the bundled tts-worker / VieNeu engine so the
orchestrator's NeuralTtsProvider can call it unchanged (only the base URL differs):

    GET  /health               -> { status, engines, loaded, loadError }
    GET  /voices?language=…     -> { voices: [{ id, language, displayName, engine }] }
    POST /synthesize-segments  -> { segments: [...], engine, fallbackSegments }

OmniVoice is multilingual, so the target language from the request is passed
through to the model; the designed-voice set is the same for every language. Each
segment is synthesized independently; on any error a placeholder SILENT WAV is
written and `fallbackSegments` is incremented, so a run never hard-fails on TTS.
"""

from __future__ import annotations

import logging
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from . import voices
from .engine import OmniVoiceEngine
from .wavio import read_wav_duration_ms, write_silent_wav

logger = logging.getLogger("vd_omnivoice")

_engine = OmniVoiceEngine()


def _warmup() -> None:
    """Load the model in the background so /health + /voices answer immediately
    while the (one-time, multi-GB) download/load proceeds — keeping the heavy load
    OUT of the first /synthesize-segments request's timeout budget. Failures are
    stored on the engine (surfaced via /health.loadError) so the orchestrator can
    fail fast instead of waiting out the synth timeout."""
    try:
        _engine.warmup()
        logger.info("OmniVoice warm: model resident.")
    except Exception as exc:  # noqa: BLE001
        logger.error("OmniVoice warm-up failed: %s", exc)


@asynccontextmanager
async def _lifespan(_app: "FastAPI"):
    threading.Thread(target=_warmup, name="omnivoice-warmup", daemon=True).start()
    yield


app = FastAPI(title="VideoDubber Neural TTS (OmniVoice)", version="0.1.0", lifespan=_lifespan)


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
    engine: str = "omnivoice"
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
    loaded: bool = False
    loadError: str | None = None


# ---- routes ----------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        engines={voices.ENGINE_NAME: _engine.available(), "fallback": True},
        loaded=_engine.loaded(),
        loadError=_engine.load_error,
    )


@app.get("/voices", response_model=VoicesResponse)
def list_voices(language: str | None = None) -> VoicesResponse:
    items = [
        Voice(id=v.id, language=language or voices.ENGINE_LANGUAGE, displayName=v.display_name, engine=voices.ENGINE_NAME)
        for v in voices.voices_for_language(language)
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
            # Pass the on-screen window so OmniVoice can speak to fit it (bounded);
            # the engine falls back to natural rate when fitting is off / no window.
            _engine.synth(seg.text, str(out_path), req.voiceId, req.language, window_ms)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OmniVoice synth failed for %s (%s); writing silence.", seg.id, exc)
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

    engine_name = "omnivoice" if fallback_count < len(results) else "fallback"
    return SynthesizeResponse(segments=results, engine=engine_name, fallbackSegments=fallback_count)


# Pull the TRAILING digits out of an id like "seg_0001" -> 1; falls back to the
# 1-based ordinal. MUST match the orchestrator's segmentIdToIndex() and the other
# TTS workers so every backend writes the SAME `segment_NNNN.wav` the orchestrator
# probes at alignment and reads at audio-mix.
_DIGITS_RE = re.compile(r"(\d+)\s*$")


def segment_filename(segment_id: str, ordinal: int) -> str:
    match = _DIGITS_RE.search(segment_id or "")
    number = int(match.group(1)) if match else ordinal
    return f"segment_{number:04d}.wav"
