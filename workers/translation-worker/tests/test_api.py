"""HTTP-level tests against the FastAPI app with a fake backend.

These run without Argos installed thanks to the ``fake_backend`` / ``client``
fixtures in conftest.py.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import translation_service
from app.main import create_app

from .conftest import FakeBackend


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["backend"] == "fake"
    # FakeBackend ships one installed pair (en->vi).
    assert body["installed_pairs"] == 1


def test_languages_shape(client: TestClient) -> None:
    resp = client.get("/languages")
    assert resp.status_code == 200
    body = resp.json()
    assert "installed" in body and "available" in body
    assert {"from": "en", "to": "vi"} in body["installed"]
    # available comes from the fake backend's list, serialized with the "from" alias.
    assert {"from": "en", "to": "es"} in body["available"]
    for pair in body["installed"] + body["available"]:
        assert set(pair.keys()) == {"from", "to"}


def test_translate_segments_preserves_ids_and_order(client: TestClient) -> None:
    payload = {
        "sourceLanguage": "en-US",  # reduces to "en"
        "targetLanguage": "vi-VN",  # reduces to "vi"
        "segments": [
            {"id": "seg_0001", "sourceText": "hello", "startMs": 0, "endMs": 1000},
            {"id": "seg_0002", "sourceText": "world", "startMs": 1000, "endMs": 2000},
            {"id": "seg_0003", "sourceText": "", "startMs": 2000, "endMs": 2500},
        ],
    }
    resp = client.post("/translate-segments", json=payload)
    assert resp.status_code == 200
    segs = resp.json()["segments"]

    # ids + order preserved 1:1.
    assert [s["id"] for s in segs] == ["seg_0001", "seg_0002", "seg_0003"]
    # FakeBackend transform: "[vi] HELLO" etc.
    assert segs[0]["translatedText"] == "[vi] HELLO"
    assert segs[1]["translatedText"] == "[vi] WORLD"
    # Empty source preserved as empty (not translated).
    assert segs[2]["translatedText"] == ""


def test_translate_segments_applies_glossary(client: TestClient, fake_backend: FakeBackend) -> None:
    payload = {
        "sourceLanguage": "en",
        "targetLanguage": "vi",
        "segments": [
            {"id": "seg_0001", "sourceText": "Open VideoDubber now", "startMs": 0, "endMs": 1000},
        ],
        "glossary": {"VideoDubber": "VideoDubber"},
    }
    resp = client.post("/translate-segments", json=payload)
    assert resp.status_code == 200
    out = resp.json()["segments"][0]["translatedText"]

    # The glossary target term survives verbatim despite the upper-casing fake.
    assert "VideoDubber" in out
    # The fake backend should never have seen the raw brand term (it was a sentinel).
    assert all("VideoDubber" not in call[0] for call in fake_backend.calls)


def test_translate_segments_each_segment_translated_separately(
    client: TestClient, fake_backend: FakeBackend
) -> None:
    payload = {
        "sourceLanguage": "en",
        "targetLanguage": "vi",
        "segments": [
            {"id": "seg_0001", "sourceText": "one", "startMs": 0, "endMs": 1},
            {"id": "seg_0002", "sourceText": "two", "startMs": 1, "endMs": 2},
        ],
    }
    client.post("/translate-segments", json=payload)
    # Two non-empty segments -> exactly two backend.translate calls (never merged).
    non_empty_calls = [c for c in fake_backend.calls if c[0].strip()]
    assert len(non_empty_calls) == 2


def test_missing_package_returns_structured_error() -> None:
    # Backend that supports NO pairs -> every translate raises the structured error.
    translation_service.set_backend(FakeBackend(installed=set()))
    try:
        client = TestClient(create_app(), raise_server_exceptions=False)
        resp = client.post(
            "/translate-segments",
            json={
                "sourceLanguage": "en",
                "targetLanguage": "vi",
                "segments": [
                    {"id": "seg_0001", "sourceText": "hi", "startMs": 0, "endMs": 1000}
                ],
            },
        )
        assert resp.status_code == 422
        err = resp.json()["error"]
        assert err["code"] == "TRANSLATION_PACKAGE_MISSING"
        assert err["remediation"]  # non-empty remediation guidance
        assert err["docsRef"] == "docs/MODEL_SETUP.md"
    finally:
        translation_service.set_backend(None)


def test_invalid_language_returns_structured_error(client: TestClient) -> None:
    resp = client.post(
        "/translate-segments",
        json={
            "sourceLanguage": "   ",  # cannot resolve a base subtag
            "targetLanguage": "vi",
            "segments": [],
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_LANGUAGE"
