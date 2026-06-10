"""Tests for the model-management endpoints: GET /models and POST /models/ensure.

These run fully offline. The whisper service's download path is monkeypatched so
no model or network is required; the HF-cache scanning is exercised against a
temporary directory laid out like a real HuggingFace hub cache.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

import app.whisper_service as whisper_service
from app.main import app

client = TestClient(app)


# ---------------------------------------------------------------------------
# POST /models/ensure (mocked download)
# ---------------------------------------------------------------------------
def test_models_ensure_returns_already_cached_true(monkeypatch) -> None:
    captured: dict[str, str] = {}

    def fake_ensure(model_name=None):
        captured["model"] = model_name
        return ("small", True)

    monkeypatch.setattr(whisper_service, "ensure_model", fake_ensure)

    resp = client.post("/models/ensure", json={"model": "small"})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"ok": True, "model": "small", "alreadyCached": True}
    assert captured["model"] == "small"


def test_models_ensure_returns_already_cached_false_on_fresh_download(monkeypatch) -> None:
    def fake_ensure(model_name=None):
        # Simulate a cache miss that downloaded successfully.
        return (model_name or "medium", False)

    monkeypatch.setattr(whisper_service, "ensure_model", fake_ensure)

    resp = client.post("/models/ensure", json={"model": "medium"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "medium"
    assert body["alreadyCached"] is False


def test_models_ensure_propagates_structured_error(monkeypatch) -> None:
    from app.errors import ERROR_STT_MODEL_MISSING, AppError

    def fake_ensure(model_name=None):
        raise AppError(
            ERROR_STT_MODEL_MISSING,
            "download failed",
            remediation="check your network",
        )

    monkeypatch.setattr(whisper_service, "ensure_model", fake_ensure)

    resp = client.post("/models/ensure", json={"model": "tiny"})
    assert resp.status_code == 503
    err = resp.json()["error"]
    assert err["code"] == ERROR_STT_MODEL_MISSING
    assert err["message"] == "download failed"
    assert err["remediation"] == "check your network"
    assert err["docsRef"]  # default docs ref attached


def test_models_ensure_requires_model_field() -> None:
    # Missing required "model" -> structured error envelope (not raw 422).
    resp = client.post("/models/ensure", json={})
    assert resp.status_code == 400
    body = resp.json()
    assert "error" in body
    assert body["error"]["code"]


# ---------------------------------------------------------------------------
# GET /models (mocked scan)
# ---------------------------------------------------------------------------
def test_models_list_uses_service(monkeypatch) -> None:
    monkeypatch.setattr(
        whisper_service, "list_installed_models", lambda: ["small", "medium"]
    )
    resp = client.get("/models")
    assert resp.status_code == 200
    assert resp.json() == {"installed": ["small", "medium"]}


def test_models_list_empty_by_default(monkeypatch) -> None:
    monkeypatch.setattr(whisper_service, "list_installed_models", lambda: [])
    resp = client.get("/models")
    assert resp.status_code == 200
    assert resp.json() == {"installed": []}


# ---------------------------------------------------------------------------
# Cache-scanning logic (real implementation, temp dir)
# ---------------------------------------------------------------------------
def _make_cached_model(cache: Path, repo_dir_name: str) -> None:
    """Lay out a minimal HF hub snapshot containing a model.bin."""
    snap = cache / repo_dir_name / "snapshots" / "deadbeef"
    snap.mkdir(parents=True, exist_ok=True)
    (snap / "model.bin").write_bytes(b"\x00")
    (snap / "config.json").write_text("{}")


def test_is_model_cached_and_list_scan(monkeypatch, tmp_path: Path) -> None:
    cache = tmp_path / "hub"
    cache.mkdir()
    _make_cached_model(cache, "models--Systran--faster-whisper-small")
    # A repo dir with no materialized model.bin must NOT count as cached.
    (cache / "models--Systran--faster-whisper-tiny" / "snapshots").mkdir(parents=True)

    monkeypatch.setattr(whisper_service, "_hf_cache_dir", lambda: str(cache))

    assert whisper_service.is_model_cached("small") is True
    assert whisper_service.is_model_cached("tiny") is False
    assert whisper_service.is_model_cached("medium") is False
    assert whisper_service.list_installed_models() == ["small"]


def test_list_installed_models_missing_cache_dir(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        whisper_service, "_hf_cache_dir", lambda: str(tmp_path / "nope")
    )
    assert whisper_service.list_installed_models() == []


def test_ensure_model_reports_already_cached(monkeypatch, tmp_path: Path) -> None:
    cache = tmp_path / "hub"
    cache.mkdir()
    _make_cached_model(cache, "models--Systran--faster-whisper-base")

    monkeypatch.setattr(whisper_service, "_hf_cache_dir", lambda: str(cache))
    # Avoid touching faster-whisper: stub the heavy load step.
    monkeypatch.setattr(whisper_service, "_load_model", lambda name, settings: object())

    name, already = whisper_service.ensure_model("base")
    assert name == "base"
    assert already is True

    name2, already2 = whisper_service.ensure_model("large-v3")
    assert name2 == "large-v3"
    assert already2 is False
