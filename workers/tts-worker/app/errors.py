"""Structured error handling for the TTS worker.

Errors are surfaced to clients as a JSON envelope matching the shared contract:

    { "error": { "code", "message", "remediation"?, "docsRef"? } }

with an appropriate HTTP status code.
"""

from __future__ import annotations

from app.schemas import ErrorBody, ErrorResponse

# Documentation reference shared by TTS-related errors.
TTS_DOCS_REF = "docs/MODEL_SETUP.md#tts-piper"


class TtsError(Exception):
    """Domain error carrying a structured payload + HTTP status.

    Raise this anywhere in the service layer; the FastAPI exception handler
    converts it into the JSON error envelope.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        remediation: str | None = None,
        docs_ref: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.remediation = remediation
        self.docs_ref = docs_ref

    def to_response(self) -> ErrorResponse:
        """Build the JSON error envelope for this error."""
        return ErrorResponse(
            error=ErrorBody(
                code=self.code,  # type: ignore[arg-type]
                message=self.message,
                remediation=self.remediation,
                docsRef=self.docs_ref,
            )
        )


def piper_missing(detail: str) -> TtsError:
    """A Piper voice/engine was explicitly requested but is unavailable."""
    return TtsError(
        code="PIPER_MISSING",
        message=f"Piper TTS is not available: {detail}",
        status_code=503,
        remediation=(
            "Install the Piper binary and a voice model, then set "
            "PIPER_BINARY_PATH and PIPER_VOICE_MODEL_PATH. See "
            "https://github.com/rhasspy/piper for binaries and "
            "https://huggingface.co/rhasspy/piper-voices for .onnx voices. "
            "Or omit the 'piper:' voice prefix to allow graceful fallback."
        ),
        docs_ref=TTS_DOCS_REF,
    )


def tts_voice_missing(voice_id: str) -> TtsError:
    """A specific voice id was requested but could not be resolved."""
    return TtsError(
        code="TTS_VOICE_MISSING",
        message=f"Requested TTS voice '{voice_id}' is not available.",
        status_code=404,
        remediation=(
            "Call GET /voices to list available voices, or omit voiceId to use "
            "the best available engine (with silent fallback as a last resort)."
        ),
        docs_ref=TTS_DOCS_REF,
    )


def output_not_writable(path: str, detail: str) -> TtsError:
    """The requested outputDir could not be created/written."""
    return TtsError(
        code="OUTPUT_NOT_WRITABLE",
        message=f"Output directory '{path}' is not writable: {detail}",
        status_code=400,
        remediation="Choose a writable outputDir, or check filesystem permissions.",
        docs_ref=TTS_DOCS_REF,
    )


def invalid_language(code: str) -> TtsError:
    """The provided language code could not be normalized."""
    return TtsError(
        code="INVALID_LANGUAGE",
        message=f"Invalid or empty language code: '{code}'.",
        status_code=400,
        remediation="Provide a language code such as 'vi-VN' or 'en'.",
        docs_ref=TTS_DOCS_REF,
    )
