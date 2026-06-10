"""Tests for /transcribe schema, language normalization, and error shape.

The whisper service is monkeypatched so these tests need no model or network.
We assert the response shape (seg ids, integer ms), language normalization
rules (vi-VI -> vi-VN, en-US -> en), and the structured error envelope.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

import app.whisper_service as whisper_service
from app.lang import normalize_language, to_whisper_language
from app.main import app
from app.schemas import Segment, TranscribeRequest, TranscribeResponse, Word

client = TestClient(app)


# ---------------------------------------------------------------------------
# Language normalization (mirrors the TS contract)
# ---------------------------------------------------------------------------
def test_normalize_language_rules() -> None:
    assert normalize_language("EN") == "en"
    assert normalize_language("vi-vn") == "vi-VN"
    assert normalize_language("  en-us ") == "en-US"
    assert normalize_language("zh-hant") == "zh-Hant"
    assert normalize_language("en_US") == "en-US"
    assert normalize_language(None) == ""
    assert normalize_language("") == ""


def test_normalize_language_vi_vi_special_rule() -> None:
    # vi-VI in ANY casing must become vi-VN.
    assert normalize_language("vi-VI") == "vi-VN"
    assert normalize_language("vi-vi") == "vi-VN"
    assert normalize_language("VI-VI") == "vi-VN"


def test_to_whisper_language_strips_region() -> None:
    assert to_whisper_language("vi-VN") == "vi"
    assert to_whisper_language("en-US") == "en"
    assert to_whisper_language("vi-VI") == "vi"  # via the special rule
    assert to_whisper_language("EN") == "en"
    assert to_whisper_language(None) is None
    assert to_whisper_language("") is None


# ---------------------------------------------------------------------------
# /transcribe happy path (mocked whisper service)
# ---------------------------------------------------------------------------
def test_transcribe_returns_expected_shape(monkeypatch) -> None:
    captured: dict[str, TranscribeRequest] = {}

    def fake_transcribe(req: TranscribeRequest) -> TranscribeResponse:
        # Capture the request so we can assert language normalization happened
        # upstream of the model call (the worker reduces to base subtag).
        captured["req"] = req
        return TranscribeResponse(
            segments=[
                Segment(
                    id="seg_0001",
                    index=0,
                    startMs=0,
                    endMs=1500,
                    sourceText="Xin chao",
                    confidence=0.92,
                    words=[
                        Word(word="Xin", startMs=0, endMs=500, confidence=0.9),
                        Word(word="chao", startMs=500, endMs=1500, confidence=0.95),
                    ],
                ),
                Segment(
                    id="seg_0002",
                    index=1,
                    startMs=1500,
                    endMs=3000,
                    sourceText="the gioi",
                    confidence=0.88,
                    words=None,
                ),
            ],
            detectedLanguage="vi",
            durationMs=3000,
        )

    monkeypatch.setattr(whisper_service, "transcribe", fake_transcribe)

    resp = client.post(
        "/transcribe",
        json={
            "audioPath": "/tmp/does-not-need-to-exist.wav",
            "language": "vi-VI",  # exercises the special-case normalization path
            "model": "small",
            "wordTimestamps": True,
        },
    )

    assert resp.status_code == 200
    body = resp.json()

    # Top-level shape.
    assert body["detectedLanguage"] == "vi"
    assert isinstance(body["durationMs"], int)
    assert len(body["segments"]) == 2

    # Segment ids are zero-padded seg_0001 style.
    assert body["segments"][0]["id"] == "seg_0001"
    assert body["segments"][1]["id"] == "seg_0002"

    # All timestamps are integers (milliseconds).
    for seg in body["segments"]:
        assert isinstance(seg["startMs"], int)
        assert isinstance(seg["endMs"], int)
        assert isinstance(seg["index"], int)
        for word in seg.get("words") or []:
            assert isinstance(word["startMs"], int)
            assert isinstance(word["endMs"], int)

    # The request reached the (mocked) service intact.
    assert captured["req"].language == "vi-VI"
    assert captured["req"].model == "small"


def test_transcribe_defaults_word_timestamps_and_model(monkeypatch) -> None:
    captured: dict[str, TranscribeRequest] = {}

    def fake_transcribe(req: TranscribeRequest) -> TranscribeResponse:
        captured["req"] = req
        return TranscribeResponse(segments=[], detectedLanguage="en", durationMs=0)

    monkeypatch.setattr(whisper_service, "transcribe", fake_transcribe)

    resp = client.post("/transcribe", json={"audioPath": "/tmp/x.wav"})
    assert resp.status_code == 200
    # Defaults applied by the schema.
    assert captured["req"].model == "small"
    assert captured["req"].wordTimestamps is True
    assert captured["req"].language is None


# ---------------------------------------------------------------------------
# Validation + structured error envelope
# ---------------------------------------------------------------------------
def test_transcribe_missing_audio_path_is_rejected() -> None:
    # Missing required field -> structured error envelope (not raw 422).
    resp = client.post("/transcribe", json={"language": "en"})
    assert resp.status_code == 400
    body = resp.json()
    assert "error" in body
    assert body["error"]["code"]
    assert body["error"]["message"]


def test_transcribe_propagates_app_error(monkeypatch) -> None:
    from app.errors import AppError, ERROR_STT_MODEL_MISSING

    def fake_transcribe(req: TranscribeRequest) -> TranscribeResponse:
        raise AppError(
            ERROR_STT_MODEL_MISSING,
            "model gone",
            remediation="download it",
        )

    monkeypatch.setattr(whisper_service, "transcribe", fake_transcribe)

    resp = client.post("/transcribe", json={"audioPath": "/tmp/x.wav"})
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"]["code"] == ERROR_STT_MODEL_MISSING
    assert body["error"]["message"] == "model gone"
    assert body["error"]["remediation"] == "download it"
    assert body["error"]["docsRef"]  # default docs ref is attached
