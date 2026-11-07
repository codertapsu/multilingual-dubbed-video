"""Shared pytest fixtures.

Critically, these tests run with NO Piper and force the fallback engine, so the
suite passes on any machine with zero TTS software installed.
"""

from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Before ANY test module imports `app`: app.config builds its module-level
# `settings` at import, and load_settings() creates the cache dir eagerly. The
# autouse fixture below only redirects it per test, after collection has already
# imported the module with the real environment, so every run (`pnpm check`, each
# release build) created ~/VideoDubber/cache/tts in the developer's REAL profile,
# reappearing right after a clean uninstall had removed the app's data.
_SESSION_DIR = Path(tempfile.mkdtemp(prefix="vd-tts-tests-"))
atexit.register(shutil.rmtree, _SESSION_DIR, ignore_errors=True)
os.environ["VIDEODUBBER_CACHE_DIR"] = str(_SESSION_DIR / "cache_root")
os.environ["VIDEODUBBER_CONFIG_DIR"] = str(_SESSION_DIR / "config")

# Ensure the package root (the dir containing `app/`) is importable when pytest
# is run from anywhere.
_PKG_ROOT = Path(__file__).resolve().parents[1]
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Point the cache dir at a temp dir for every test, and clear Piper env."""
    monkeypatch.setenv("VIDEODUBBER_CACHE_DIR", str(tmp_path / "cache_root"))
    # Make sure no ambient Piper config leaks into tests — including any real
    # voices the developer has installed under ~/VideoDubber/models/piper.
    monkeypatch.delenv("PIPER_BINARY_PATH", raising=False)
    monkeypatch.delenv("PIPER_VOICE_MODEL_PATH", raising=False)
    monkeypatch.setenv("PIPER_VOICES_DIR", str(tmp_path / "no_voices"))
    yield


@pytest.fixture
def client():
    """A FastAPI TestClient with a fresh Settings/service bound to a temp cache.

    Imported lazily so the autouse env fixture runs first.
    """
    from fastapi.testclient import TestClient

    # Build fresh settings so the temp cache dir from _isolated_cache is used.
    import app.config as config_mod
    import app.main as main_mod
    from app.config import load_settings
    from app.engines import EngineRegistry
    from app.tts_service import TtsService

    fresh = load_settings()
    config_mod.settings = fresh
    main_mod.settings = fresh
    main_mod.registry = EngineRegistry(fresh)
    main_mod.service = TtsService(fresh, main_mod.registry)

    return TestClient(main_mod.app)
