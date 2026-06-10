"""Runtime configuration for the TTS worker.

All configuration is read from environment variables with sensible local-first
defaults. Nothing here requires Piper or any cloud credentials — the worker
always has a working fallback engine.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    """Read an env var, treating empty/whitespace-only values as unset."""
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _default_cache_dir() -> Path:
    """Default cache directory for synthesized audio.

    Prefers ~/VideoDubber/cache/tts to align with the project's
    VIDEODUBBER_PROJECTS_DIR convention (~/VideoDubber/projects).
    """
    base = _env("VIDEODUBBER_CACHE_DIR")
    if base:
        return Path(base).expanduser() / "tts"
    return Path.home() / "VideoDubber" / "cache" / "tts"


@dataclass(frozen=True)
class Settings:
    """Immutable view of the worker's configuration."""

    # Network
    host: str
    port: int

    # Piper engine
    piper_binary_path: str | None
    piper_voice_model_path: str | None

    # System TTS overrides (optional; otherwise discovered on PATH)
    ffmpeg_path: str | None

    # Caching
    cache_dir: Path

    # Audio defaults
    default_sample_rate: int

    @property
    def piper_configured(self) -> bool:
        """True if both the Piper binary path and a voice model are set."""
        return bool(self.piper_binary_path and self.piper_voice_model_path)


def load_settings() -> Settings:
    """Build a Settings instance from the current environment."""
    cache_dir = _default_cache_dir()
    # Ensure the cache directory exists eagerly so engines can rely on it.
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # Non-fatal: caching just becomes a no-op if the dir can't be created.
        pass

    return Settings(
        host=_env("TTS_WORKER_HOST", "127.0.0.1") or "127.0.0.1",
        port=int(_env("TTS_WORKER_PORT", "5103") or "5103"),
        piper_binary_path=_env("PIPER_BINARY_PATH"),
        piper_voice_model_path=_env("PIPER_VOICE_MODEL_PATH"),
        ffmpeg_path=_env("FFMPEG_PATH"),
        cache_dir=cache_dir,
        default_sample_rate=int(_env("TTS_DEFAULT_SAMPLE_RATE", "22050") or "22050"),
    )


# Module-level singleton — cheap to construct, read once at import time.
settings = load_settings()
