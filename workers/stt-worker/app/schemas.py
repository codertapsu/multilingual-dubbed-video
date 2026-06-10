"""Pydantic v2 request/response models for the STT worker.

These mirror the shared TypeScript contracts (`SttInput`, `SttResult`,
`TranscriptSegment`, `TranscriptWord`, `AppError`). Field names use camelCase
to match the JSON exchanged with the Node orchestrator and desktop app.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class TranscribeRequest(BaseModel):
    """Body of ``POST /transcribe`` (mirrors shared ``SttInput``)."""

    model_config = ConfigDict(extra="ignore")

    audioPath: str = Field(..., description="Absolute path to the audio file to transcribe.")
    language: Optional[str] = Field(
        default=None,
        description="Source language code (e.g. 'vi-VN'). Omit/null to auto-detect.",
    )
    model: str = Field(
        default="small",
        description="Whisper model size, e.g. tiny|base|small|medium|large-v3.",
    )
    wordTimestamps: bool = Field(
        default=True,
        description="Whether to emit per-word timestamps.",
    )


class Word(BaseModel):
    """A single word with timing (mirrors shared ``TranscriptWord``)."""

    word: str
    startMs: int
    endMs: int
    confidence: Optional[float] = None


class Segment(BaseModel):
    """A transcript segment (mirrors shared ``TranscriptSegment``).

    ``sourceText`` holds the transcribed text; ``translatedText`` is left to the
    translation worker downstream and is not set here.
    """

    id: str = Field(..., description="Zero-padded id, e.g. 'seg_0001'.")
    index: int
    startMs: int
    endMs: int
    sourceText: str
    confidence: Optional[float] = None
    words: Optional[List[Word]] = None


class TranscribeResponse(BaseModel):
    """Body of a successful ``POST /transcribe`` (mirrors shared ``SttResult``)."""

    segments: List[Segment]
    detectedLanguage: str
    durationMs: int


class HealthResponse(BaseModel):
    """Body of ``GET /health``."""

    status: str = "ok"
    model: str
    device: str
    compute_type: str
    loaded: bool


# --- Model management (first-run setup wizard) ----------------------------
class EnsureModelRequest(BaseModel):
    """Body of ``POST /models/ensure``."""

    model_config = ConfigDict(extra="ignore")

    model: str = Field(
        ...,
        description="Whisper model size to download/cache, e.g. tiny|base|small|medium|large-v3.",
    )


class EnsureModelResponse(BaseModel):
    """Body of a successful ``POST /models/ensure``."""

    ok: bool = True
    model: str
    alreadyCached: bool = Field(
        ...,
        description="True if the model weights were already present before this call.",
    )


class InstalledModelsResponse(BaseModel):
    """Body of ``GET /models``."""

    installed: List[str] = Field(
        default_factory=list,
        description="Curated model sizes whose weights are present in the local cache.",
    )


# --- Error envelope (mirrors shared AppError) -----------------------------
class ErrorBody(BaseModel):
    code: str
    message: str
    remediation: Optional[str] = None
    docsRef: Optional[str] = None


class ErrorResponse(BaseModel):
    error: ErrorBody
