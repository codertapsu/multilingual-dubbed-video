"""Pydantic v2 request/response models for the TTS worker HTTP API.

These mirror the TypeScript contracts in @videodubber/shared:

    TtsSegmentInput  -> SegmentIn
    TtsInput         -> SynthesizeRequest
    TtsSegment       -> SegmentOut
    TtsResult        -> SynthesizeResponse
    Voice / VoicesResponse for GET /voices
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Engine identifiers exposed to clients. "piper" and "system" are real engines;
# "fallback" is the always-available silent/sine dev engine.
EngineName = Literal["piper", "system", "fallback"]


class SegmentIn(BaseModel):
    """A single segment to synthesize. Mirrors shared TtsSegmentInput."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(..., description='Segment id, e.g. "seg_0001".')
    text: str = Field(..., description="Text to speak (already translated).")
    startMs: int = Field(..., ge=0, description="Segment start time in ms.")
    endMs: int = Field(..., ge=0, description="Segment end time in ms.")


class SynthesizeRequest(BaseModel):
    """POST /synthesize-segments body. Mirrors shared TtsInput."""

    model_config = ConfigDict(extra="ignore")

    language: str = Field(..., description="Target language code, e.g. 'vi-VN'.")
    voiceId: str | None = Field(
        default=None,
        description=(
            "Optional voice id. May be prefixed to force an engine, e.g. "
            "'fallback', 'piper:...', 'system:...'."
        ),
    )
    segments: list[SegmentIn] = Field(default_factory=list)
    outputDir: str = Field(..., description="Directory to write segment WAVs into.")
    speed: float = Field(
        default=1.0,
        gt=0.0,
        description="Requested speech rate multiplier (1.0 = normal).",
    )


class SegmentOut(BaseModel):
    """A synthesized segment. Mirrors shared TtsSegment (sans text/audio dup)."""

    model_config = ConfigDict(extra="ignore")

    segmentId: str
    audioPath: str = Field(..., description="Absolute path to the written WAV.")
    durationMs: int = Field(..., description="Real measured WAV duration in ms.")
    startMs: int
    endMs: int
    speedRatio: float = Field(
        ...,
        description=(
            "Effective speed ratio. The synthesizer passes through the requested "
            "speed; actual time-stretch to fit the window is applied downstream "
            "by the alignment/ffmpeg stage."
        ),
    )


class SynthesizeResponse(BaseModel):
    """POST /synthesize-segments response. Mirrors shared TtsResult."""

    segments: list[SegmentOut]
    engine: EngineName = Field(
        default="fallback",
        description="The engine that synthesized this batch.",
    )
    fallbackSegments: int = Field(
        default=0,
        ge=0,
        description=(
            "Number of segments silently replaced by the fallback engine after "
            "the selected engine errored at runtime. Non-zero (or engine == "
            "'fallback') means the output contains placeholder silence."
        ),
    )


class Voice(BaseModel):
    """A selectable voice for GET /voices."""

    id: str
    language: str
    displayName: str
    engine: EngineName


class VoicesResponse(BaseModel):
    """GET /voices response."""

    voices: list[Voice]


class HealthResponse(BaseModel):
    """GET /health response with engine capability flags."""

    status: Literal["ok"] = "ok"
    engines: dict[str, bool]


# ----------------------------------------------------------------------------
# Error envelope — matches the shared worker error contract.
# { "error": { code, message, remediation?, docsRef? } }
# ----------------------------------------------------------------------------

ErrorCode = Literal[
    "PIPER_MISSING",
    "TTS_VOICE_MISSING",
    "OUTPUT_NOT_WRITABLE",
    "INVALID_LANGUAGE",
    "UNKNOWN",
]


class ErrorBody(BaseModel):
    """The inner error object."""

    code: ErrorCode
    message: str
    remediation: str | None = None
    docsRef: str | None = None


class ErrorResponse(BaseModel):
    """The full error envelope returned to clients."""

    error: ErrorBody
