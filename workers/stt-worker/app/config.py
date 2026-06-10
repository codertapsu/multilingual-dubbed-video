"""Environment-driven configuration for the STT worker.

All knobs are read from environment variables (with sensible local-first
defaults) so the service can run with zero config out of the box, and be tuned
in dev/CI/desktop bundles via env vars.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

# Default Whisper model size. "small" is a good CPU-friendly default that
# balances speed and quality; override with FASTER_WHISPER_MODEL.
DEFAULT_MODEL = "small"

# faster-whisper / ctranslate2 device + compute type. On CPU, int8 gives the
# best speed/memory tradeoff. GPU users can override via env.
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE_CPU = "int8"
DEFAULT_COMPUTE_TYPE_GPU = "float16"


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def _resolve_device() -> str:
    """Resolve the compute device.

    ``STT_DEVICE`` may be ``auto`` | ``cpu`` | ``cuda``. ``auto`` resolves to
    ``cpu`` here (the worker is local-first and does not assume a GPU). If a
    user explicitly sets ``cuda`` we honour it and let ctranslate2 validate.
    """
    requested = _env("STT_DEVICE", "auto").lower()
    if requested in ("cpu", "cuda"):
        return requested
    # "auto" / anything unknown -> cpu (safe, always-available default).
    return DEFAULT_DEVICE


def _resolve_compute_type(device: str) -> str:
    explicit = os.environ.get("STT_COMPUTE_TYPE")
    if explicit and explicit.strip():
        return explicit.strip()
    return DEFAULT_COMPUTE_TYPE_GPU if device == "cuda" else DEFAULT_COMPUTE_TYPE_CPU


def _resolve_cache_dir() -> Optional[str]:
    """Directory faster-whisper uses to download/cache model weights.

    Priority: STT_MODEL_CACHE_DIR -> HF_HOME/hub -> None (library default
    ``~/.cache/huggingface``). Returned as a string path or ``None``.
    """
    explicit = os.environ.get("STT_MODEL_CACHE_DIR")
    if explicit and explicit.strip():
        return str(Path(explicit).expanduser())
    return None


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of worker configuration."""

    host: str
    port: int
    model: str
    device: str
    compute_type: str
    cpu_threads: int
    num_workers: int
    download_root: Optional[str]
    local_files_only: bool
    log_level: str

    def model_signature(self) -> tuple[str, str, str]:
        """Cache key used by the whisper service to reuse a loaded model."""
        return (self.model, self.device, self.compute_type)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load settings once per process (cached)."""
    device = _resolve_device()
    compute_type = _resolve_compute_type(device)

    def _int_env(name: str, default: int) -> int:
        try:
            return int(_env(name, str(default)))
        except ValueError:
            return default

    return Settings(
        host=_env("STT_HOST", "127.0.0.1"),
        port=_int_env("STT_PORT", 5101),
        model=_env("FASTER_WHISPER_MODEL", DEFAULT_MODEL),
        device=device,
        compute_type=compute_type,
        # 0 => let ctranslate2 pick based on available cores.
        cpu_threads=_int_env("STT_CPU_THREADS", 0),
        num_workers=_int_env("STT_NUM_WORKERS", 1),
        download_root=_resolve_cache_dir(),
        # If true, never hit the network; fail fast with STT_MODEL_MISSING.
        local_files_only=_env("STT_LOCAL_FILES_ONLY", "false").lower()
        in ("1", "true", "yes"),
        log_level=_env("STT_LOG_LEVEL", "INFO").upper(),
    )
