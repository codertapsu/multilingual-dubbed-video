"""Tests for the /health endpoint.

These run fully offline: no model, no network. The whisper service is never
invoked by /health (it only reports config + whether a model is cached).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok() -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # Capability fields are present and sane defaults for local CPU usage.
    assert body["model"]  # non-empty (e.g. "small")
    assert body["device"] in ("cpu", "cuda")
    assert body["compute_type"]  # e.g. "int8"
    assert body["loaded"] is False  # nothing loaded in a fresh test process.


def test_health_does_not_load_model() -> None:
    # Calling /health repeatedly must not attempt to load a model.
    for _ in range(3):
        assert client.get("/health").json()["loaded"] is False
