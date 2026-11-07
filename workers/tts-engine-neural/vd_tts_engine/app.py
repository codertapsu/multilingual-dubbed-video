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

Resumability: a clip whose text and voice are unchanged since an earlier request
is copied from the per-project clip cache instead of re-synthesized
(`reusedSegments`), and every clip is written atomically. See clipcache.py.
"""

from __future__ import annotations

import logging
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from . import clipcache, voices
from .engine import VieNeuEngine
from .wavio import read_wav_duration_ms, write_silent_wav

logger = logging.getLogger("vd_tts_engine")

_engine = VieNeuEngine()


def _warmup() -> None:
    """Load the model in the background so /health + /voices answer immediately
    while the (one-time, possibly large) download/load proceeds — keeping the
    heavy load OUT of the first /synthesize-segments request's timeout budget.
    Failures are stored on the engine (surfaced via /health.loadError) so the
    orchestrator can fail fast instead of waiting out the synth timeout."""
    try:
        _engine.warmup()
        logger.info("VieNeu %s warm: model resident.", _engine.variant)
    except Exception as exc:  # noqa: BLE001
        logger.error("VieNeu %s warm-up failed: %s", _engine.variant, exc)


_warmup_started = threading.Event()


def _start_warmup() -> None:
    """Start the background model load once (idempotent)."""
    if not _warmup_started.is_set():
        _warmup_started.set()
        threading.Thread(target=_warmup, name="vieneu-warmup", daemon=True).start()


@asynccontextmanager
async def _lifespan(_app: "FastAPI"):
    # Kick off the load AFTER uvicorn binds the port (so /health is reachable at
    # once) but as early as possible — typically when the wizard lists voices,
    # well before a run starts.
    #
    # Except on the GPU. There the engine also starts just to LIST voices, and
    # loading then would put the model on the card wherever the orchestrator
    # happened to be (next to a resident 12B llama.cpp, say); an out-of-memory
    # there drops this process to the CPU for its whole life. The orchestrator
    # calls POST /warmup once it holds the GPU for synthesis instead.
    if _engine_wants_gpu():
        logger.info("GPU pack: model loads on POST /warmup, not at startup.")
    else:
        _start_warmup()
    yield


def _engine_wants_gpu() -> bool:
    from .engine import vieneu_device  # noqa: PLC0415

    return vieneu_device() == "cuda"


app = FastAPI(title="VideoDubber Neural TTS (VieNeu)", version="0.1.0", lifespan=_lifespan)


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
    # Clips answered from the clip cache (unchanged text + voice since an
    # earlier request) without running the model. See clipcache.py.
    reusedSegments: int = 0


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
    # True once the model is resident (warm). The orchestrator waits for this
    # before a long synthesis so the one-time model load isn't charged to the
    # /synthesize-segments timeout. (The bundled Piper worker has no load step,
    # so it omits this field — readers must treat a missing value as "unknown".)
    loaded: bool = False
    # Set if the background warm-up failed, so callers fail fast vs. timing out.
    loadError: str | None = None
    # Where synthesis runs once loaded ("cuda" | "cpu"), the GPU's name, and why
    # a GPU pack is running on the CPU instead (old driver, unsupported card...).
    device: str | None = None
    deviceName: str | None = None
    deviceNote: str | None = None


# ---- routes ----------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        engines={voices.ENGINE_NAME: _engine.available(), "fallback": True},
        loaded=_engine.loaded(),
        loadError=_engine.load_error,
        device=_engine.device,
        deviceName=_engine.device_name,
        deviceNote=_engine.device_note,
    )


@app.post("/warmup", response_model=HealthResponse)
def warmup() -> HealthResponse:
    """Start loading the model now (idempotent); poll /health for `loaded`."""
    _start_warmup()
    return health()


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

    fallback_count = 0
    reused_count = 0
    outs = [out_dir / segment_filename(seg.id, ordinal) for ordinal, seg in enumerate(req.segments, start=1)]
    failed: dict[int, BaseException] = {}
    # (segment index, cache-entry path) for every line that needs the model.
    misses: list[tuple[int, Path]] = []

    # 1. Reuse before synthesizing: a retry after a timeout or a crash resumes
    #    instead of redoing every finished clip (clipcache.py).
    for i, seg in enumerate(req.segments):
        try:
            key = _engine.clip_key(seg.text, req.voiceId)
            cached = clipcache.lookup(out_dir, key)
            if cached is not None:
                clipcache.materialize(cached, outs[i])
                reused_count += 1
            else:
                misses.append((i, clipcache.cached_clip(out_dir, key)))
        except Exception as exc:  # noqa: BLE001 - empty text, unloadable SDK...
            failed[i] = exc

    # 2. Synthesize every miss in ONE call, so the GPU build can generate the
    #    lines together (engine.synth_many); each into a unique partial file.
    if misses:
        clipcache.cache_dir(out_dir).mkdir(parents=True, exist_ok=True)
        partials = [clipcache.partial_for(final) for _, final in misses]
        try:
            errors = _engine.synth_many(
                [req.segments[i].text for i, _ in misses], [str(p) for p in partials], req.voiceId, req.speed
            )
        except Exception as exc:  # noqa: BLE001 - e.g. the model failed to load
            errors = [exc] * len(misses)
        for (i, final), partial, error in zip(misses, partials, errors):
            try:
                if error is not None:
                    raise error
                clipcache.publish(partial, final)
                clipcache.materialize(final, outs[i])
            except Exception as exc:  # noqa: BLE001
                partial.unlink(missing_ok=True)
                failed[i] = exc

    # 3. Graceful fallback: silence sized to the segment window. Never cached,
    #    so the line is synthesized for real once the engine works.
    for i, exc in failed.items():
        seg = req.segments[i]
        window_ms = max(0, seg.endMs - seg.startMs)
        logger.warning("Neural synth failed for %s (%s); writing silence.", seg.id, exc)
        clipcache.write_atomically(
            outs[i], lambda tmp, ms=window_ms: write_silent_wav(tmp, ms or 1000, sample_rate=_engine.sample_rate)
        )
        fallback_count += 1

    results: list[SegmentOut] = []
    for seg, out_path in zip(req.segments, outs):
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
    return SynthesizeResponse(
        segments=results, engine=engine_name, fallbackSegments=fallback_count, reusedSegments=reused_count
    )


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
