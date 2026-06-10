"""Runtime configuration for the translation worker.

All configuration is sourced from environment variables so the worker can run
identically in dev (``uvicorn``) and when launched by the orchestrator.

Notable env vars
----------------
TRANSLATION_WORKER_HOST / TRANSLATION_WORKER_PORT
    Bind address. Defaults to 127.0.0.1:5102 (matches the project ports table).

ARGOS_PACKAGES_DIR
    Directory where Argos Translate stores/loads installed ``.argosmodel``
    packages. When set, it is exported as ``ARGOS_PACKAGES_DIR`` for the
    ``argostranslate`` library to pick up. This lets the desktop app keep all
    models inside the user's app-data folder instead of the global home dir.

ARGOS_DEVICE
    Optional hint ("cpu"/"cuda") forwarded to ``argostranslate`` via
    ``ARGOS_DEVICE`` if present. Defaults to unset (library default = CPU).

CORS_ALLOW_ORIGINS
    Comma-separated list of allowed origins. Defaults to a localhost allow-list.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _split_csv(value: str) -> list[str]:
    """Split a comma-separated env value into a clean list (no empties)."""
    return [item.strip() for item in value.split(",") if item.strip()]


# Default CORS allow-list: any localhost origin used by the desktop dev server,
# the Tauri webview, and the orchestrator.
_DEFAULT_CORS_ORIGINS = [
    "http://localhost",
    "http://localhost:1420",  # tauri dev
    "http://localhost:4200",  # angular dev
    "http://127.0.0.1",
    "http://127.0.0.1:1420",
    "http://127.0.0.1:4200",
    "tauri://localhost",
    "http://tauri.localhost",
]


@dataclass(frozen=True)
class Settings:
    """Immutable, process-wide settings resolved from the environment."""

    host: str = "127.0.0.1"
    port: int = 5102
    argos_packages_dir: str | None = None
    argos_device: str | None = None
    cors_allow_origins: list[str] = field(default_factory=lambda: list(_DEFAULT_CORS_ORIGINS))
    log_level: str = "INFO"

    def apply_to_environment(self) -> None:
        """Propagate settings that the ``argostranslate`` library reads from env.

        ``argostranslate`` resolves its package directory and device from
        process environment variables at import/first-use time, so we set them
        here before the library is touched.
        """
        if self.argos_packages_dir:
            os.environ.setdefault("ARGOS_PACKAGES_DIR", self.argos_packages_dir)
        if self.argos_device:
            os.environ.setdefault("ARGOS_DEVICE", self.argos_device)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Resolve settings from the environment once and cache them.

    Cached so every module observes a single, consistent configuration. Tests
    can clear the cache via ``get_settings.cache_clear()`` if they need to
    re-read patched environment variables.
    """
    cors_env = os.environ.get("CORS_ALLOW_ORIGINS", "")
    cors = _split_csv(cors_env) if cors_env else list(_DEFAULT_CORS_ORIGINS)

    return Settings(
        host=os.environ.get("TRANSLATION_WORKER_HOST", "127.0.0.1"),
        port=int(os.environ.get("TRANSLATION_WORKER_PORT", "5102")),
        argos_packages_dir=os.environ.get("ARGOS_PACKAGES_DIR") or None,
        argos_device=os.environ.get("ARGOS_DEVICE") or None,
        cors_allow_origins=cors,
        log_level=os.environ.get("TRANSLATION_WORKER_LOG_LEVEL", "INFO").upper(),
    )
