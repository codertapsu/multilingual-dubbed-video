"""Structured error model — Python mirror of the shared TS ``AppError``.

Workers serialize failures as JSON::

    { "error": { "code", "message", "remediation?", "docsRef?", "cause?" } }

with an appropriate HTTP status. This module defines :class:`AppError` (the
serializable payload), :class:`AppErrorException` (raisable, carries an
``AppError`` + status code), :func:`to_app_error` (coerce any exception), and
the FastAPI exception handlers that render them.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel

if TYPE_CHECKING:  # imported lazily inside handlers to keep the core FastAPI-free
    from fastapi import Request
    from fastapi.responses import JSONResponse

logger = logging.getLogger("translation_worker.errors")

# Mirror of shared ErrorCode (only the codes this worker can emit are used,
# but the full union is listed for parity/documentation).
ErrorCode = Literal[
    "FFMPEG_NOT_FOUND",
    "FFPROBE_NOT_FOUND",
    "PYTHON_NOT_FOUND",
    "STT_MODEL_MISSING",
    "TRANSLATION_PACKAGE_MISSING",
    "PIPER_MISSING",
    "TTS_VOICE_MISSING",
    "UNSUPPORTED_MEDIA",
    "NO_AUDIO_STREAM",
    "INVALID_LANGUAGE",
    "OUTPUT_NOT_WRITABLE",
    "WORKER_UNAVAILABLE",
    "WORKER_TIMEOUT",
    "CANCELLED",
    "UNKNOWN",
]


class AppError(BaseModel):
    """Serializable error payload (matches shared ``AppError`` interface)."""

    code: str
    message: str
    cause: str | None = None
    remediation: str | None = None
    docsRef: str | None = None


class AppErrorException(Exception):
    """Raisable exception carrying a structured :class:`AppError`.

    Parameters
    ----------
    error:
        The structured error payload to return to the client.
    status_code:
        HTTP status to respond with (default 400).
    """

    def __init__(self, error: AppError, status_code: int = 400) -> None:
        super().__init__(error.message)
        self.error = error
        self.status_code = status_code

    @classmethod
    def make(
        cls,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        cause: str | None = None,
        remediation: str | None = None,
        docs_ref: str | None = None,
    ) -> "AppErrorException":
        """Convenience constructor that builds the :class:`AppError` for you."""
        return cls(
            AppError(
                code=code,
                message=message,
                cause=cause,
                remediation=remediation,
                docsRef=docs_ref,
            ),
            status_code=status_code,
        )


def to_app_error(err: Any) -> AppError:
    """Coerce an arbitrary value/exception into an :class:`AppError`.

    Already-structured :class:`AppErrorException` instances are unwrapped;
    everything else becomes an ``UNKNOWN`` error with the string form attached
    as ``cause`` (never the full traceback, to avoid leaking internals/secrets).
    """
    if isinstance(err, AppErrorException):
        return err.error
    if isinstance(err, AppError):
        return err
    return AppError(
        code="UNKNOWN",
        message="An unexpected error occurred.",
        cause=str(err) if err is not None else None,
    )


def _error_response(error: AppError, status_code: int) -> "JSONResponse":
    """Render the standard ``{ "error": {...} }`` envelope."""
    from fastapi.responses import JSONResponse  # local import: keeps core FastAPI-free

    return JSONResponse(status_code=status_code, content={"error": error.model_dump()})


async def app_error_exception_handler(_: "Request", exc: AppErrorException) -> "JSONResponse":
    """FastAPI handler for raised :class:`AppErrorException`."""
    # Log at warning level — these are expected, structured failures.
    logger.warning("AppError %s: %s", exc.error.code, exc.error.message)
    return _error_response(exc.error, exc.status_code)


async def unhandled_exception_handler(_: "Request", exc: Exception) -> "JSONResponse":
    """Catch-all handler so clients always receive the structured envelope."""
    logger.exception("Unhandled exception: %s", exc)
    return _error_response(to_app_error(exc), status_code=500)
