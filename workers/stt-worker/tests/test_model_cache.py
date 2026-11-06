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
    constructed_kwargs: list[dict] = []
    downloaded: list[tuple[str, dict]] = []

    class FakeWhisperModel:
        def __init__(self, model_name, **kwargs):
            constructed.append(model_name)
            constructed_kwargs.append(kwargs)

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
    return types.SimpleNamespace(
        constructed=constructed, constructed_kwargs=constructed_kwargs, downloaded=downloaded
    )


def test_model_cache_holds_at_most_one_model(fake_faster_whisper):
    settings = get_settings()

    whisper_service._load_model("small", settings)
    assert len(whisper_service._MODEL_CACHE) == 1

    whisper_service._load_model("medium", settings)
    assert len(whisper_service._MODEL_CACHE) == 1
    assert [key[0] for key in whisper_service._MODEL_CACHE] == ["medium"]
    # The second load really did construct a model (it was not served stale).
    # Catalog aliases are resolved to the repo THIS module downloads (see
    # test_load_resolves_aliases_through_this_modules_table).
    assert fake_faster_whisper.constructed == [
        "Systran/faster-whisper-small",
        "Systran/faster-whisper-medium",
    ]


def test_reloading_the_same_model_reuses_the_cached_instance(fake_faster_whisper):
    settings = get_settings()
    first = whisper_service._load_model("small", settings)
    second = whisper_service._load_model("small", settings)

    assert first is second
    assert fake_faster_whisper.constructed == ["Systran/faster-whisper-small"]


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


# ---------------------------------------------------------------------------
# Alias resolution: what the wizard downloads is what transcription loads.
# ---------------------------------------------------------------------------


def test_load_resolves_aliases_through_this_modules_table(fake_faster_whisper):
    """The orchestrator sends catalog aliases; WhisperModel must get OUR repo.

    Before the fix the alias went to WhisperModel verbatim and was resolved by
    faster-whisper's own table: `phowhisper-*` raised "Invalid model size"
    (PhoWhisper never transcribed anything), and `large-v3-turbo` resolved to
    mobiuslabsgmbh/... while the wizard had downloaded deepdml/... — so an
    "offline-ready" machine went to the network on its first turbo dub.
    """
    settings = get_settings()

    whisper_service._load_model("large-v3-turbo", settings)
    whisper_service._load_model("phowhisper-large", settings)

    assert fake_faster_whisper.constructed == [
        "deepdml/faster-whisper-large-v3-turbo-ct2",
        "kiendt/PhoWhisper-large-ct2",
    ]
    # Neither repo is revision-pinned, so no revision is forced on them.
    assert all("revision" not in kw for kw in fake_faster_whisper.constructed_kwargs)


def test_community_conversions_load_at_their_pinned_revision(fake_faster_whisper):
    whisper_service._load_model("phowhisper-medium", get_settings())

    assert fake_faster_whisper.constructed == ["nunu-willump/PhoWhisper-medium-ct2"]
    assert fake_faster_whisper.constructed_kwargs[0]["revision"] == (
        "84fd238d9263ad77752ebb2fafb3402049199ef0"
    )


def test_ensure_model_downloads_the_same_pinned_revision(fake_faster_whisper, monkeypatch):
    monkeypatch.setattr(whisper_service, "is_model_cached", lambda _name: False)

    whisper_service.ensure_model("phowhisper-medium")

    repo_id, kwargs = fake_faster_whisper.downloaded[0]
    assert repo_id == "nunu-willump/PhoWhisper-medium-ct2"
    assert kwargs["revision"] == "84fd238d9263ad77752ebb2fafb3402049199ef0"


def test_names_outside_the_table_pass_through_untouched(fake_faster_whisper, tmp_path):
    """faster-whisper's own sizes, repo ids and local dirs keep working as before."""
    settings = get_settings()
    local_dir = str(tmp_path)

    whisper_service._load_model("distil-large-v3", settings)
    whisper_service._load_model("someone/custom-whisper-ct2", settings)
    whisper_service._load_model(local_dir, settings)

    assert fake_faster_whisper.constructed == [
        "distil-large-v3",
        "someone/custom-whisper-ct2",
        local_dir,
    ]


def test_no_alias_points_at_the_repos_that_do_not_exist():
    """kiendt/PhoWhisper-{small,medium}-ct2 answer 401: never resolve to them."""
    targets = set(whisper_service._SYSTRAN_REPOS.values())
    assert "kiendt/PhoWhisper-medium-ct2" not in targets
    assert "kiendt/PhoWhisper-small-ct2" not in targets
    assert "phowhisper-small" not in whisper_service._SYSTRAN_REPOS
