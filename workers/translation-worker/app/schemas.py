"""Pydantic v2 request/response models for the translation worker.

These mirror the shared TS types (``TranslationInput``,
``TranslationSegmentInput``, ``TranslationResult``,
``TranslationResultSegment``) and the worker HTTP contract documented in the
project spec. Field names use camelCase on the wire to match the TS clients.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Segment(BaseModel):
    """A single source segment to translate (mirrors TranslationSegmentInput)."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(..., description="Stable segment id, e.g. 'seg_0001'.")
    sourceText: str = Field(..., description="Source-language text to translate.")
    startMs: int = Field(..., ge=0, description="Segment start, integer milliseconds.")
    endMs: int = Field(..., ge=0, description="Segment end, integer milliseconds.")


class TranslateRequest(BaseModel):
    """Body for ``POST /translate-segments`` (mirrors TranslationInput)."""

    model_config = ConfigDict(extra="ignore")

    sourceLanguage: str = Field(..., description="Source language code, e.g. 'en' or 'en-US'.")
    targetLanguage: str = Field(..., description="Target language code, e.g. 'vi' or 'vi-VN'.")
    segments: list[Segment] = Field(default_factory=list)
    glossary: dict[str, str] | None = Field(
        default=None,
        description=(
            "Optional source-term -> target-term map. Applied as a "
            "case-insensitive, whole-word protect/replace pass. See app/glossary.py."
        ),
    )


class ResultSegment(BaseModel):
    """A single translated segment (mirrors TranslationResultSegment)."""

    id: str
    translatedText: str


class TranslateResponse(BaseModel):
    """Body for ``POST /translate-segments`` response (mirrors TranslationResult)."""

    segments: list[ResultSegment]


class LanguagePair(BaseModel):
    """A directed translation pair, by base subtag (e.g. en -> vi)."""

    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(..., alias="from")
    to: str

    # Ensure the alias ("from") is used when serializing to JSON.
    def model_dump_wire(self) -> dict[str, str]:
        return self.model_dump(by_alias=True)


class LanguagesResponse(BaseModel):
    """Body for ``GET /languages``."""

    model_config = ConfigDict(populate_by_name=True)

    installed: list[LanguagePair] = Field(default_factory=list)
    available: list[LanguagePair] = Field(default_factory=list)


class EnsurePackageRequest(BaseModel):
    """Body for ``POST /packages/ensure`` (mirrors the shared ``ArgosPair``)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    from_: str = Field(..., alias="from", description="Source language code, e.g. 'en'.")
    to: str = Field(..., description="Target language code, e.g. 'vi'.")


class EnsurePackageResponse(BaseModel):
    """Body for a successful ``POST /packages/ensure``."""

    ok: bool = True
    installed: bool = Field(
        ...,
        description="True if a package was installed by this call (False if already present).",
    )


class PackagesResponse(BaseModel):
    """Body for ``GET /packages``."""

    model_config = ConfigDict(populate_by_name=True)

    installed: list[LanguagePair] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """Body for ``GET /health``."""

    status: str = "ok"
    installed_pairs: int = 0
    backend: str = "argos"


class ErrorEnvelope(BaseModel):
    """The ``{ "error": {...} }`` wrapper used for failures (documentation only)."""

    error: dict
