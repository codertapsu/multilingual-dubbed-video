"""FastAPI application for the VideoDubber TTS worker (port 5103).

Endpoints:
    GET  /health             -> { status:"ok", engines:{piper,system,fallback} }
    GET  /voices?language=   -> { voices:[{id,language,displayName,engine}] }
    POST /synthesize-segments-> { segments:[SegmentOut...] }

Local/offline-first: the fallback engine guarantees synthesis always succeeds.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.config import settings
from app.engines import EngineRegistry
from app.errors import TtsError
from app.lang import to_tts_language
from app.schemas import (
    HealthResponse,
    SynthesizeRequest,
    SynthesizeResponse,
    Voice,
    VoicesResponse,
)
from app.tts_service import TtsService

# --- structured logging -----------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("tts.main")

# --- app + shared singletons -------------------------------------------------
app = FastAPI(title="VideoDubber TTS Worker", version=__version__)

# CORS: allow localhost origins (desktop webview / dev servers).
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registry = EngineRegistry(settings)
service = TtsService(settings, registry)


# --- error handling ----------------------------------------------------------
@app.exception_handler(TtsError)
async def _tts_error_handler(_: Request, exc: TtsError) -> JSONResponse:
    """Render TtsError as the shared { "error": {...} } envelope."""
    logger.warning("TtsError %s: %s", exc.code, exc.message)
    return JSONResponse(
        status_code=exc.status_code,
        content=exc.to_response().model_dump(),
    )


@app.exception_handler(Exception)
async def _unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler so clients always get a structured error."""
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "UNKNOWN",
                "message": str(exc) or "Internal TTS worker error.",
                "remediation": "Check the TTS worker logs for details.",
                "docsRef": "docs/TROUBLESHOOTING.md",
            }
        },
    )


# --- routes ------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness + engine capability flags."""
    return HealthResponse(status="ok", engines=registry.capabilities())


@app.get("/voices", response_model=VoicesResponse)
async def voices(
    language: str | None = Query(default=None, description="Filter by language code."),
) -> VoicesResponse:
    """List selectable voices for the available engines.

    Always includes the fallback voice. Real engines expose at least one
    representative voice id when they are available on this machine.
    """
    lang = to_tts_language(language) if language else ""
    listed: list[Voice] = []

    caps = registry.capabilities()

    if caps["piper"]:
        # The Piper voice is whatever .onnx model is configured. We can't easily
        # enumerate the model's language, so we report the requested language
        # (or "*") and a stable id; callers force it via "piper:" if desired.
        listed.append(
            Voice(
                id="piper:default",
                language=lang or "*",
                displayName="Piper (configured voice model)",
                engine="piper",
            )
        )

    if caps["system"]:
        listed.append(
            Voice(
                id="system:default",
                language=lang or "*",
                displayName="System TTS (OS built-in)",
                engine="system",
            )
        )

    # Fallback is always available.
    listed.append(
        Voice(
            id="fallback",
            language=lang or "*",
            displayName="Dev fallback (silent/sine placeholder)",
            engine="fallback",
        )
    )

    return VoicesResponse(voices=listed)


@app.post("/synthesize-segments", response_model=SynthesizeResponse)
async def synthesize_segments(req: SynthesizeRequest) -> SynthesizeResponse:
    """Synthesize one WAV per segment into req.outputDir."""
    segments = service.synthesize_segments(
        language=req.language,
        voice_id=req.voiceId,
        segments=req.segments,
        output_dir=req.outputDir,
        speed=req.speed,
    )
    return SynthesizeResponse(segments=segments)


def run() -> None:
    """Entry point for `python -m app.main` style invocation."""
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    run()
