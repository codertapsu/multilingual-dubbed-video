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
from pathlib import Path
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

# Curated size alias -> HuggingFace repo id, mirroring faster-whisper's internal
# ``_MODELS`` table for the sizes the setup catalog offers. Duplicated here (not
# imported from faster_whisper) so this module — and the test suite that
# monkeypatches it — stays importable without the native dependency installed.
_SYSTRAN_REPOS: dict[str, str] = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
}


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
# Model management (ensure / list) — used by the first-run setup wizard
# ---------------------------------------------------------------------------
def _hf_cache_dir() -> str:
    """Resolve the HuggingFace hub cache directory faster-whisper downloads into.

    Priority mirrors :func:`config._resolve_cache_dir`:
      1. ``STT_MODEL_CACHE_DIR`` (also passed to WhisperModel as ``download_root``)
      2. ``HF_HOME``/hub
      3. ``HF_HUB_CACHE``
      4. the library default ``~/.cache/huggingface/hub``.
    """
    explicit = os.environ.get("STT_MODEL_CACHE_DIR")
    if explicit and explicit.strip():
        return str(Path(explicit).expanduser())
    hub_cache = os.environ.get("HF_HUB_CACHE")
    if hub_cache and hub_cache.strip():
        return str(Path(hub_cache).expanduser())
    hf_home = os.environ.get("HF_HOME")
    if hf_home and hf_home.strip():
        return str(Path(hf_home).expanduser() / "hub")
    return str(Path("~/.cache/huggingface/hub").expanduser())


def _model_repo_dir_name(model_name: str) -> str:
    """The on-disk snapshot dir name HF uses for a faster-whisper model.

    ``snapshot_download("Systran/faster-whisper-small")`` stores the snapshot
    under ``<cache>/models--Systran--faster-whisper-small``. Curated size
    aliases (``tiny``..``large-v3``) map onto the Systran repos; a raw
    ``owner/repo`` id maps directly.
    """
    repo_id = _SYSTRAN_REPOS.get(model_name, None)
    if repo_id is None:
        repo_id = model_name if "/" in model_name else f"Systran/faster-whisper-{model_name}"
    return "models--" + repo_id.replace("/", "--")


def is_model_cached(model_name: str) -> bool:
    """True if the model's weights already exist in the HF cache (no network).

    Best-effort: returns False if the cache dir is unreadable. We look for the
    repo snapshot dir AND at least one materialized ``model.bin`` under
    ``snapshots/`` so a half-populated dir is not reported as cached.
    """
    cache = Path(_hf_cache_dir())
    repo_dir = cache / _model_repo_dir_name(model_name)
    if not repo_dir.is_dir():
        return False
    snapshots = repo_dir / "snapshots"
    if not snapshots.is_dir():
        # Some layouts (local_dir) drop files at the repo root.
        return any(repo_dir.glob("model.bin"))
    try:
        return any(snapshots.glob("*/model.bin"))
    except OSError:  # pragma: no cover - defensive
        return False


def ensure_model(model_name: Optional[str] = None) -> tuple[str, bool]:
    """Ensure a Whisper model is downloaded + cached locally.

    Constructs the faster-whisper ``WhisperModel`` (which triggers the
    HuggingFace download into the cache) so a subsequent ``/transcribe`` runs
    fully offline. Long-running on a cache miss; instant on a hit.

    Returns
    -------
    (model_name, already_cached):
        the resolved model name and whether it was already present before this
        call (so callers can report "alreadyCached").

    Raises
    ------
    AppError ``STT_MODEL_MISSING``
        if faster-whisper is unavailable or the download/load fails.
    """
    settings = get_settings()
    name = (model_name or settings.model).strip() or settings.model

    already = is_model_cached(name)
    logger.info(
        "Ensuring Whisper model name=%s (already_cached=%s, cache=%s)",
        name,
        already,
        _hf_cache_dir(),
    )

    # _load_model downloads-on-miss and caches the constructed model; it raises
    # the structured STT_MODEL_MISSING AppError on any failure.
    _load_model(name, settings)
    return name, already


def list_installed_models() -> list[str]:
    """Scan the HF cache for installed faster-whisper models.

    Returns the curated size aliases (``tiny``..``large-v3``) whose repo
    snapshots are present, sorted and de-duplicated. Best-effort: returns an
    empty list if the cache dir is missing/unreadable. Never raises.
    """
    cache = Path(_hf_cache_dir())
    try:
        if not cache.is_dir():
            return []
        present_dirs = {p.name for p in cache.iterdir() if p.is_dir()}
    except OSError:  # pragma: no cover - defensive
        return []

    installed: set[str] = set()
    for size, repo_id in _SYSTRAN_REPOS.items():
        dir_name = "models--" + repo_id.replace("/", "--")
        if dir_name in present_dirs and is_model_cached(size):
            installed.add(size)
    return sorted(installed)


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
