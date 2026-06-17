"""FastAPI application for the VideoDubber translation worker (port 5102).

Routes
------
GET  /health              -> { "status": "ok", "installed_pairs": int, "backend": str }
GET  /languages           -> { "installed": [{from,to}], "available": [{from,to}] }
POST /translate-segments  -> { "segments": [{id, translatedText}] }

Run locally::

    uvicorn app.main:app --port 5102

All failures are rendered as the structured ``{ "error": {...} }`` envelope by
the exception handlers in :mod:`app.errors`.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .errors import (
    AppErrorException,
    app_error_exception_handler,
    unhandled_exception_handler,
)
from .schemas import (
    EnsurePackageRequest,
    EnsurePackageResponse,
    HealthResponse,
    LanguagesResponse,
    PackagesResponse,
    RemovePackageResponse,
    TranslateRequest,
    TranslateResponse,
)
from .translation_service import (
    ensure_package,
    get_backend,
    installed_pair_count,
    list_languages,
    list_packages,
    remove_package,
    translate_segments,
)


def _configure_logging(level: str) -> None:
    """Configure structured-ish stdlib logging once at startup."""
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


def create_app() -> FastAPI:
    """Application factory — builds and wires the FastAPI app."""
    settings = get_settings()
    settings.apply_to_environment()  # propagate ARGOS_PACKAGES_DIR etc.
    _configure_logging(settings.log_level)

    log = logging.getLogger("translation_worker")

    app = FastAPI(
        title="VideoDubber Translation Worker",
        version=__version__,
        description="Local/offline-first translation via Argos Translate.",
    )

    # CORS: allow the localhost desktop/dev origins.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Structured error handlers.
    app.add_exception_handler(AppErrorException, app_error_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        """Liveness + installed package count. Never raises (best-effort count)."""
        backend = get_backend()
        return HealthResponse(
            status="ok",
            installed_pairs=installed_pair_count(),
            backend=getattr(backend, "id", "argos"),
        )

    @app.get("/languages", response_model=LanguagesResponse)
    def languages() -> LanguagesResponse:
        """List installed (and, if known, available) language pairs.

        Installed pairs are sourced from ``get_installed_packages()`` so a
        freshly-installed pair is reported even before any translation has wired
        up the language graph.
        """
        return list_languages()

    @app.get("/packages", response_model=PackagesResponse)
    def packages(refresh: bool = False) -> PackagesResponse:
        """List installed translation packages.

        ``?refresh=true`` also fetches the full downloadable Argos index (network)
        for the Settings pack manager; the default is installed-only (fast,
        offline-tolerant — used by first-run setup).
        """
        return list_packages(refresh=refresh)

    @app.post("/packages/remove", response_model=RemovePackageResponse)
    def remove_pkg(req: EnsurePackageRequest) -> RemovePackageResponse:
        """Uninstall an Argos language package (idempotent)."""
        removed = remove_package(req.from_, req.to)
        log.info("Removed translation package %s->%s (removed=%s)", req.from_, req.to, removed)
        return RemovePackageResponse(ok=True, removed=removed)

    @app.post("/packages/ensure", response_model=EnsurePackageResponse)
    def ensure_pkg(req: EnsurePackageRequest) -> EnsurePackageResponse:
        """Download + install an Argos language package (idempotent).

        Long-running on a cache miss (fetches the package index + model over the
        network). FastAPI runs this sync handler in a worker thread, so the
        event loop (and ``/health``) stays responsive. Raises the structured
        ``TRANSLATION_PACKAGE_MISSING`` / ``INVALID_LANGUAGE`` error on failure.
        """
        installed = ensure_package(req.from_, req.to)
        log.info(
            "Ensured translation package %s->%s (newly_installed=%s)",
            req.from_,
            req.to,
            installed,
        )
        return EnsurePackageResponse(ok=True, installed=installed)

    @app.post("/translate-segments", response_model=TranslateResponse)
    def translate(req: TranslateRequest) -> TranslateResponse:
        """Translate each segment separately, preserving ids/order + glossary."""
        return translate_segments(
            source_language=req.sourceLanguage,
            target_language=req.targetLanguage,
            segments=req.segments,
            glossary=req.glossary,
        )

    log.info("Translation worker initialized (v%s) on %s:%d", __version__, settings.host, settings.port)
    return app


# Module-level ASGI app for `uvicorn app.main:app`.
app = create_app()


def main() -> None:
    """Console entry point: run uvicorn with resolved host/port."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
