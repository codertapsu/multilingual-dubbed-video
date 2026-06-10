"""Structured error model and FastAPI exception handlers.

Mirrors the shared TypeScript ``AppError`` contract. Every error surfaced by a
worker is serialized as::

    { "error": { "code", "message", "remediation", "docsRef" } }

with an appropriate HTTP status code, so the orchestrator and desktop UI can
present consistent, actionable messages.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("videodubber.stt.errors")

# ---------------------------------------------------------------------------
# Error codes (subset of the shared ErrorCode union relevant to the STT worker)
# ---------------------------------------------------------------------------
ErrorCode = str  # one of the literals below; kept as str for forward-compat.

ERROR_PYTHON_NOT_FOUND = "PYTHON_NOT_FOUND"
ERROR_STT_MODEL_MISSING = "STT_MODEL_MISSING"
ERROR_UNSUPPORTED_MEDIA = "UNSUPPORTED_MEDIA"
ERROR_NO_AUDIO_STREAM = "NO_AUDIO_STREAM"
ERROR_INVALID_LANGUAGE = "INVALID_LANGUAGE"
ERROR_WORKER_UNAVAILABLE = "WORKER_UNAVAILABLE"
ERROR_WORKER_TIMEOUT = "WORKER_TIMEOUT"
ERROR_CANCELLED = "CANCELLED"
ERROR_UNKNOWN = "UNKNOWN"

# Default HTTP status for each error code.
_STATUS_BY_CODE: dict[str, int] = {
    ERROR_PYTHON_NOT_FOUND: 500,
    ERROR_STT_MODEL_MISSING: 503,
    ERROR_UNSUPPORTED_MEDIA: 415,
    ERROR_NO_AUDIO_STREAM: 422,
    ERROR_INVALID_LANGUAGE: 400,
    ERROR_WORKER_UNAVAILABLE: 503,
    ERROR_WORKER_TIMEOUT: 504,
    ERROR_CANCELLED: 499,
    ERROR_UNKNOWN: 500,
}

DOCS_REF = "docs/TROUBLESHOOTING.md#stt-worker"


class AppErrorBody(BaseModel):
    """The inner ``error`` object returned to clients."""

    code: str
    message: str
    remediation: Optional[str] = None
    docsRef: Optional[str] = None


class AppErrorResponse(BaseModel):
    """Top-level JSON error envelope: ``{ "error": { ... } }``."""

    error: AppErrorBody


class AppError(Exception):
    """An exception carrying a structured, client-facing :class:`AppErrorBody`.

    Raise this anywhere in request handling; the registered FastAPI handler
    converts it into the standard ``{ "error": {...} }`` JSON response.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        remediation: Optional[str] = None,
        docs_ref: Optional[str] = DOCS_REF,
        status_code: Optional[int] = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.remediation = remediation
        self.docs_ref = docs_ref
        self.status_code = status_code or _STATUS_BY_CODE.get(code, 500)
        if cause is not None:
            # Preserve the original traceback for server-side logging.
            self.__cause__ = cause

    def to_body(self) -> AppErrorBody:
        return AppErrorBody(
            code=self.code,
            message=self.message,
            remediation=self.remediation,
            docsRef=self.docs_ref,
        )

    def to_response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status_code,
            content=jsonable_encoder(AppErrorResponse(error=self.to_body())),
        )


def error_response(
    code: str,
    message: str,
    *,
    remediation: Optional[str] = None,
    docs_ref: Optional[str] = DOCS_REF,
    status_code: Optional[int] = None,
) -> JSONResponse:
    """Build a standard error JSON response without raising."""
    return AppError(
        code,
        message,
        remediation=remediation,
        docs_ref=docs_ref,
        status_code=status_code,
    ).to_response()


def register_exception_handlers(app: FastAPI) -> None:
    """Attach the worker's exception handlers to a FastAPI app.

    * :class:`AppError`            -> its declared status + structured body.
    * :class:`RequestValidationError` -> 400 INVALID_LANGUAGE-style envelope so
      malformed bodies do not leak FastAPI's default 422 shape.
    * Any other ``Exception``      -> 500 UNKNOWN (never leaks a stack trace to
      the client; the trace is logged server-side).
    """

    @app.exception_handler(AppError)
    async def _handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        # 5xx are server problems worth a stack trace; 4xx are client input.
        if exc.status_code >= 500:
            logger.error("AppError %s: %s", exc.code, exc.message, exc_info=exc)
        else:
            logger.warning("AppError %s: %s", exc.code, exc.message)
        return exc.to_response()

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Surface a compact, structured message instead of FastAPI's raw 422.
        detail = "; ".join(
            f"{'.'.join(str(p) for p in err.get('loc', []))}: {err.get('msg', '')}".strip(": ")
            for err in exc.errors()
        ) or "Invalid request body."
        logger.warning("Request validation failed: %s", detail)
        return error_response(
            ERROR_INVALID_LANGUAGE if "language" in detail.lower() else ERROR_UNSUPPORTED_MEDIA,
            f"Request validation failed: {detail}",
            remediation="Check the request body against POST /transcribe schema.",
            status_code=400,
        )

    @app.exception_handler(Exception)
    async def _handle_unknown(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error while processing request")
        return error_response(
            ERROR_UNKNOWN,
            "An unexpected error occurred in the STT worker.",
            remediation="Check the STT worker logs for details.",
            status_code=500,
        )
