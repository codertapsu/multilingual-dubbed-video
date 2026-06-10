"""FastAPI application for the VideoDubber STT worker (port 5101).

Endpoints
---------
* ``GET  /health``     -> liveness + capabilities (model, device, loaded?).
* ``POST /transcribe`` -> faster-whisper transcription into timed segments.

The whisper model is loaded lazily on the first ``/transcribe`` call (or via the
optional ``STT_WARMUP=1`` startup hook), so ``/health`` works instantly even
before any model is downloaded.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from . import whisper_service
from .config import get_settings
from .errors import register_exception_handlers
from .schemas import (
    EnsureModelRequest,
    EnsureModelResponse,
    HealthResponse,
    InstalledModelsResponse,
    TranscribeRequest,
    TranscribeResponse,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_settings = get_settings()
logging.basicConfig(
    level=getattr(logging, _settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("videodubber.stt")


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
def create_app() -> FastAPI:
    app = FastAPI(
        title="VideoDubber STT Worker",
        version=__version__,
        summary="Local speech-to-text using faster-whisper.",
    )

    # CORS: allow localhost origins (orchestrator + Tauri webview in dev).
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        """Liveness probe + capability report. Never loads the model itself."""
        settings = get_settings()
        return HealthResponse(
            status="ok",
            model=settings.model,
            device=settings.device,
            compute_type=settings.compute_type,
            loaded=whisper_service.is_model_loaded(),
        )

    @app.post("/transcribe", response_model=TranscribeResponse)
    async def transcribe(req: TranscribeRequest) -> TranscribeResponse:
        """Transcribe an audio file into timed transcript segments.

        Heavy/blocking work runs in a worker thread so the event loop stays
        responsive (e.g. /health and SSE consumers in the orchestrator).
        """
        from anyio import to_thread

        return await to_thread.run_sync(whisper_service.transcribe, req)

    @app.get("/models", response_model=InstalledModelsResponse)
    async def list_models() -> InstalledModelsResponse:
        """List Whisper models already cached locally (best-effort, never raises)."""
        return InstalledModelsResponse(installed=whisper_service.list_installed_models())

    @app.post("/models/ensure", response_model=EnsureModelResponse)
    async def ensure_model(req: EnsureModelRequest) -> EnsureModelResponse:
        """Ensure a Whisper model is downloaded + cached (first-run setup wizard).

        Long-running on a cache miss (downloads weights from HuggingFace), so the
        blocking work runs in a worker thread to keep the event loop responsive.
        Raises the structured ``STT_MODEL_MISSING`` error on failure.
        """
        from anyio import to_thread

        model, already = await to_thread.run_sync(whisper_service.ensure_model, req.model)
        logger.info("Ensured Whisper model '%s' (alreadyCached=%s).", model, already)
        return EnsureModelResponse(ok=True, model=model, alreadyCached=already)

    @app.on_event("startup")
    async def _maybe_warm_up() -> None:
        # Opt-in eager model load. Failures here are non-fatal: /health stays up
        # and the structured error surfaces on the first /transcribe call.
        if os.environ.get("STT_WARMUP", "").lower() in ("1", "true", "yes"):
            try:
                from anyio import to_thread

                await to_thread.run_sync(whisper_service.warm_up)
                logger.info("STT warm-up complete; model preloaded.")
            except Exception:  # noqa: BLE001 - best-effort warm-up
                logger.warning("STT warm-up failed; will load lazily.", exc_info=True)

    return app


app = create_app()


def run() -> None:
    """Entry point for `python -m app.main` / programmatic launch."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    run()
