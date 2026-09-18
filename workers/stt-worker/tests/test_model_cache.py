"""Model residency: the cache is bounded, and /models/ensure only downloads.

Two shipped defects are pinned here:

* ``_MODEL_CACHE`` was unbounded, so every distinct model this process touched
  stayed resident for the process lifetime — the setup wizard installing three
  sizes meant three models in RAM, several GB, in a background sidecar.
* ``ensure_model`` constructed a ``WhisperModel`` purely to trigger the
  HuggingFace download, which is what put them there (and made
  ``/health.loaded`` report ``true`` before any transcription had run).

faster-whisper is imported lazily by the service, so these tests inject fake
``faster_whisper`` modules into ``sys.modules`` and need no native dependency,
no weights and no network.
"""

from __future__ import annotations

import sys
import types

import pytest

import app.whisper_service as whisper_service
from app.config import get_settings
from app.errors import AppError


@pytest.fixture(autouse=True)
def _clear_model_cache():
    whisper_service._MODEL_CACHE.clear()
    yield
    whisper_service._MODEL_CACHE.clear()


@pytest.fixture()
def fake_faster_whisper(monkeypatch):
    """Install a fake ``faster_whisper`` package; returns the call recorder."""
    constructed: list[str] = []
    downloaded: list[tuple[str, dict]] = []

    class FakeWhisperModel:
        def __init__(self, model_name, **kwargs):
            constructed.append(model_name)

    def fake_download_model(repo_id, **kwargs):
        downloaded.append((repo_id, kwargs))
        return f"/fake/cache/{repo_id}"

    root = types.ModuleType("faster_whisper")
    root.WhisperModel = FakeWhisperModel
    utils = types.ModuleType("faster_whisper.utils")
    utils.download_model = fake_download_model
    root.utils = utils

    monkeypatch.setitem(sys.modules, "faster_whisper", root)
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", utils)
    return types.SimpleNamespace(constructed=constructed, downloaded=downloaded)


def test_model_cache_holds_at_most_one_model(fake_faster_whisper):
    settings = get_settings()

    whisper_service._load_model("small", settings)
    assert len(whisper_service._MODEL_CACHE) == 1

    whisper_service._load_model("medium", settings)
    assert len(whisper_service._MODEL_CACHE) == 1
    assert [key[0] for key in whisper_service._MODEL_CACHE] == ["medium"]
    # The second load really did construct a model (it was not served stale).
    assert fake_faster_whisper.constructed == ["small", "medium"]


def test_reloading_the_same_model_reuses_the_cached_instance(fake_faster_whisper):
    settings = get_settings()
    first = whisper_service._load_model("small", settings)
    second = whisper_service._load_model("small", settings)

    assert first is second
    assert fake_faster_whisper.constructed == ["small"]


def test_ensure_model_downloads_without_loading(fake_faster_whisper, monkeypatch):
    monkeypatch.setattr(whisper_service, "is_model_cached", lambda _name: False)

    name, already = whisper_service.ensure_model("large-v3-turbo")

    assert (name, already) == ("large-v3-turbo", False)
    # The weights were fetched...
    assert len(fake_faster_whisper.downloaded) == 1
    repo_id, _kwargs = fake_faster_whisper.downloaded[0]
    # ...through OUR alias table: faster-whisper's own _MODELS has no entry for
    # large-v3-turbo, so resolving the repo id here is what makes it work.
    assert repo_id == "deepdml/faster-whisper-large-v3-turbo-ct2"
    # ...and nothing was instantiated, so nothing is resident.
    assert fake_faster_whisper.constructed == []
    assert whisper_service.is_model_loaded() is False


def test_ensure_model_is_a_no_op_when_already_cached(fake_faster_whisper, monkeypatch):
    monkeypatch.setattr(whisper_service, "is_model_cached", lambda _name: True)

    name, already = whisper_service.ensure_model("small")

    assert (name, already) == ("small", True)
    # No network call on a hit — this is what lets an offline machine re-run the
    # wizard without failing.
    assert fake_faster_whisper.downloaded == []
    assert fake_faster_whisper.constructed == []


def test_ensure_model_raises_the_structured_error_on_failure(monkeypatch):
    monkeypatch.setattr(whisper_service, "is_model_cached", lambda _name: False)

    utils = types.ModuleType("faster_whisper.utils")

    def _boom(repo_id, **kwargs):
        raise OSError("network unreachable")

    utils.download_model = _boom
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", utils)

    with pytest.raises(AppError) as excinfo:
        whisper_service.ensure_model("small")
    assert excinfo.value.code == "STT_MODEL_MISSING"
    assert whisper_service.is_model_loaded() is False
