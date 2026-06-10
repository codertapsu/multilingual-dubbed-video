"""faster-whisper wrapper: lazy model loading, caching, and transcription.

Design goals
------------
* **Lazy + cached:** a ``WhisperModel`` is only constructed on first use and is
  cached by ``(model, device, compute_type)`` so repeated requests reuse it.
* **Resilient:** missing model / failed download raises :class:`AppError`
  ``STT_MODEL_MISSING`` with actionable remediation rather than crashing.
* **Offline-friendly:** ``faster-whisper`` itself is imported lazily so this
  module (and the test suite, which monkeypatches the public functions) can be
  imported without the heavy native dependency installed.
* **Deterministic mapping:** segment ids ``seg_0001`` (1-based, width 4); all
  timestamps are integer milliseconds (``round(seconds * 1000)``); confidences
  are clamped to ``[0, 1]``.
"""

from __future__ import annotations

import logging
import math
import os
import threading
from typing import Any, List, Optional

from .config import Settings, get_settings
from .errors import (
    ERROR_NO_AUDIO_STREAM,
    ERROR_STT_MODEL_MISSING,
    ERROR_UNSUPPORTED_MEDIA,
    AppError,
)
from .lang import to_whisper_language
from .schemas import Segment, TranscribeRequest, TranscribeResponse, Word

logger = logging.getLogger("videodubber.stt.whisper")

# Cache of loaded WhisperModel instances keyed by (model, device, compute_type).
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_CACHE_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _seconds_to_ms(seconds: Optional[float]) -> int:
    """Convert seconds (possibly ``None``) to a non-negative integer ms value."""
    if seconds is None:
        return 0
    return max(0, round(float(seconds) * 1000))


def _logprob_to_confidence(avg_logprob: Optional[float]) -> Optional[float]:
    """Map a whisper average log-probability to a 0..1 confidence.

    faster-whisper reports ``avg_logprob`` (natural log of the per-token mean
    probability), typically in roughly ``[-1.5, 0]``. ``exp()`` brings it back
    to a probability-like value; we clamp to ``[0, 1]`` defensively.
    """
    if avg_logprob is None:
        return None
    try:
        return max(0.0, min(1.0, math.exp(float(avg_logprob))))
    except (OverflowError, ValueError):
        return None


def _clamp01(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return None


def _segment_id(one_based_index: int) -> str:
    """Build a zero-padded segment id: 1 -> 'seg_0001'."""
    return f"seg_{one_based_index:04d}"


def is_model_loaded() -> bool:
    """True if any model is currently cached in this process (for /health)."""
    return bool(_MODEL_CACHE)


# ---------------------------------------------------------------------------
# Model loading (lazy + cached)
# ---------------------------------------------------------------------------
def _load_model(model_name: str, settings: Settings) -> Any:
    """Construct (or fetch from cache) a faster-whisper ``WhisperModel``.

    Raises :class:`AppError` ``STT_MODEL_MISSING`` if faster-whisper is not
    installed, or if the model weights are unavailable (e.g. offline + not
    cached, or a download failure).
    """
    key = (model_name, settings.device, settings.compute_type)

    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    with _CACHE_LOCK:
        # Double-checked locking: another thread may have loaded it.
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached

        try:
            # Imported lazily so the module is importable without the native
            # dependency (and so tests can monkeypatch without installing it).
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as exc:  # ImportError or transitive native failure
            raise AppError(
                ERROR_STT_MODEL_MISSING,
                "faster-whisper is not installed or failed to import.",
                remediation=(
                    "Install dependencies in the STT worker venv: "
                    "`pip install -r requirements.txt`. Python 3.11/3.12 is "
                    "recommended (ctranslate2 wheels may lag on newer Pythons)."
                ),
                cause=exc,
            ) from exc

        logger.info(
            "Loading Whisper model name=%s device=%s compute_type=%s cache=%s",
            model_name,
            settings.device,
            settings.compute_type,
            settings.download_root or "<default>",
        )
        try:
            model = WhisperModel(
                model_name,
                device=settings.device,
                compute_type=settings.compute_type,
                cpu_threads=settings.cpu_threads,
                num_workers=settings.num_workers,
                download_root=settings.download_root,
                local_files_only=settings.local_files_only,
            )
        except Exception as exc:
            raise AppError(
                ERROR_STT_MODEL_MISSING,
                f"Whisper model '{model_name}' could not be loaded.",
                remediation=(
                    "Pre-download the model with "
                    "`python -m app.download_model --model "
                    f"{model_name}` (needs network once), or set "
                    "FASTER_WHISPER_MODEL to a model already cached locally. "
                    "If offline, ensure STT_MODEL_CACHE_DIR contains the model."
                ),
                cause=exc,
            ) from exc

        _MODEL_CACHE[key] = model
        logger.info("Whisper model '%s' loaded and cached.", model_name)
        return model


def warm_up(model_name: Optional[str] = None) -> None:
    """Eagerly load a model (best-effort). Used by the optional startup hook."""
    settings = get_settings()
    _load_model(model_name or settings.model, settings)


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------
def _validate_audio_path(audio_path: str) -> None:
    """Ensure the audio file exists and is a non-empty regular file."""
    if not audio_path or not audio_path.strip():
        raise AppError(
            ERROR_UNSUPPORTED_MEDIA,
            "audioPath is required.",
            remediation="Provide an absolute path to an existing audio file.",
            status_code=400,
        )
    if not os.path.exists(audio_path):
        raise AppError(
            ERROR_UNSUPPORTED_MEDIA,
            f"Audio file not found: {audio_path}",
            remediation="Verify the path; the orchestrator extracts audio to the project's audio/ dir.",
        )
    if not os.path.isfile(audio_path):
        raise AppError(
            ERROR_UNSUPPORTED_MEDIA,
            f"Audio path is not a regular file: {audio_path}",
            remediation="Point audioPath at an audio file, not a directory.",
        )
    try:
        if os.path.getsize(audio_path) == 0:
            raise AppError(
                ERROR_NO_AUDIO_STREAM,
                f"Audio file is empty: {audio_path}",
                remediation="Re-run audio extraction; the source may have no audio stream.",
            )
    except OSError:
        # If we cannot stat the file, let the model attempt and surface its error.
        pass


def _build_words(raw_words: Optional[Any]) -> Optional[List[Word]]:
    """Convert faster-whisper word objects into schema ``Word`` instances."""
    if not raw_words:
        return None
    words: List[Word] = []
    for w in raw_words:
        text = (getattr(w, "word", None) or "").strip()
        if not text:
            continue
        words.append(
            Word(
                word=text,
                startMs=_seconds_to_ms(getattr(w, "start", None)),
                endMs=_seconds_to_ms(getattr(w, "end", None)),
                confidence=_clamp01(getattr(w, "probability", None)),
            )
        )
    return words or None


def transcribe(request: TranscribeRequest) -> TranscribeResponse:
    """Transcribe an audio file into timed transcript segments.

    Raises :class:`AppError` for bad input or a missing/failed model; the
    FastAPI handler converts these into structured JSON error responses.
    """
    settings = get_settings()
    _validate_audio_path(request.audioPath)

    model_name = (request.model or settings.model).strip() or settings.model
    whisper_language = to_whisper_language(request.language)

    logger.info(
        "Transcribe start path=%s model=%s language=%s word_timestamps=%s",
        request.audioPath,
        model_name,
        whisper_language or "<auto>",
        request.wordTimestamps,
    )

    model = _load_model(model_name, settings)

    try:
        segments_iter, info = model.transcribe(
            request.audioPath,
            language=whisper_language,  # None => auto-detect
            word_timestamps=request.wordTimestamps,
            vad_filter=True,
        )
    except Exception as exc:
        raise AppError(
            ERROR_UNSUPPORTED_MEDIA,
            f"Failed to decode/transcribe audio: {request.audioPath}",
            remediation="Ensure the file is a valid audio stream (16kHz mono WAV is ideal).",
            cause=exc,
        ) from exc

    segments: List[Segment] = []
    # faster-whisper yields segments lazily; iterate to materialize them.
    for one_based, seg in enumerate(segments_iter, start=1):
        text = (getattr(seg, "text", None) or "").strip()
        words = (
            _build_words(getattr(seg, "words", None))
            if request.wordTimestamps
            else None
        )
        segments.append(
            Segment(
                id=_segment_id(one_based),
                index=one_based - 1,  # 0-based index, ids are 1-based.
                startMs=_seconds_to_ms(getattr(seg, "start", None)),
                endMs=_seconds_to_ms(getattr(seg, "end", None)),
                sourceText=text,
                confidence=_logprob_to_confidence(getattr(seg, "avg_logprob", None)),
                words=words,
            )
        )

    detected = getattr(info, "language", None) or whisper_language or "und"
    # Prefer the audio duration reported by whisper; fall back to last segment.
    duration_ms = _seconds_to_ms(getattr(info, "duration", None))
    if duration_ms == 0 and segments:
        duration_ms = max(s.endMs for s in segments)

    logger.info(
        "Transcribe done segments=%d detected=%s duration_ms=%d",
        len(segments),
        detected,
        duration_ms,
    )

    return TranscribeResponse(
        segments=segments,
        detectedLanguage=detected,
        durationMs=duration_ms,
    )
