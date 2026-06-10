"""Tests for the package-management endpoints + the fixed /languages.

Covered:
* GET  /packages          -> installed pairs only.
* POST /packages/ensure   -> idempotent install, structured errors.
* GET  /languages         -> installed pairs reported correctly (the bug fix).

All run against the dependency-free ``FakeBackend`` from conftest.py, so no
Argos packages or network are required.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import translation_service
from app.main import create_app

from .conftest import FakeBackend


# ---------------------------------------------------------------------------
# GET /packages
# ---------------------------------------------------------------------------
def test_packages_lists_installed_only(client: TestClient) -> None:
    resp = client.get("/packages")
    assert resp.status_code == 200
    body = resp.json()
    assert "installed" in body
    # FakeBackend ships en->vi installed; available (en->es/fr) must NOT appear.
    assert {"from": "en", "to": "vi"} in body["installed"]
    assert {"from": "en", "to": "es"} not in body["installed"]
    for pair in body["installed"]:
        assert set(pair.keys()) == {"from", "to"}


# ---------------------------------------------------------------------------
# GET /languages — the bug fix (installed pairs were previously [])
# ---------------------------------------------------------------------------
def test_languages_reports_installed_pairs(client: TestClient) -> None:
    resp = client.get("/languages")
    assert resp.status_code == 200
    body = resp.json()
    # The previously-broken field: an installed pair must be present.
    assert {"from": "en", "to": "vi"} in body["installed"]
    assert {"from": "en", "to": "es"} in body["available"]


# ---------------------------------------------------------------------------
# POST /packages/ensure
# ---------------------------------------------------------------------------
def test_ensure_already_installed_is_noop(client: TestClient, fake_backend: FakeBackend) -> None:
    resp = client.post("/packages/ensure", json={"from": "en", "to": "vi"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "installed": False}
    # The pair was already installed -> reported as not newly installed.
    assert ("en", "vi") in fake_backend.ensure_calls


def test_ensure_installs_available_pair(client: TestClient, fake_backend: FakeBackend) -> None:
    # en->es is available but not installed initially.
    resp = client.post("/packages/ensure", json={"from": "en", "to": "es"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "installed": True}
    # It now shows up as installed.
    listed = client.get("/packages").json()["installed"]
    assert {"from": "en", "to": "es"} in listed


def test_ensure_normalizes_region_codes(client: TestClient, fake_backend: FakeBackend) -> None:
    # en-US / vi-VN reduce to en / vi (already installed -> no-op).
    resp = client.post("/packages/ensure", json={"from": "en-US", "to": "vi-VN"})
    assert resp.status_code == 200
    assert resp.json()["installed"] is False
    # The backend saw the reduced base subtags, not the regioned codes.
    assert ("en", "vi") in fake_backend.ensure_calls


def test_ensure_unknown_pair_returns_structured_error(client: TestClient) -> None:
    # de->ja is neither installed nor available in the fake -> structured error.
    resp = client.post("/packages/ensure", json={"from": "de", "to": "ja"})
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["code"] == "TRANSLATION_PACKAGE_MISSING"
    assert err["remediation"]


def test_ensure_invalid_language_returns_400() -> None:
    translation_service.set_backend(FakeBackend())
    try:
        client = TestClient(create_app(), raise_server_exceptions=False)
        resp = client.post("/packages/ensure", json={"from": "   ", "to": "vi"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_LANGUAGE"
    finally:
        translation_service.set_backend(None)


def test_ensure_missing_field_returns_error(client: TestClient) -> None:
    # Missing required "to" -> FastAPI validation -> structured 500 envelope
    # via the catch-all handler (this worker has no custom 422 handler).
    resp = client.post("/packages/ensure", json={"from": "en"})
    assert resp.status_code in (422, 500)
    assert "error" in resp.json() or "detail" in resp.json()
