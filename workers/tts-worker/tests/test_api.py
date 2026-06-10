"""HTTP API tests via FastAPI TestClient. No Piper required."""

from __future__ import annotations

from pathlib import Path


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    engines = body["engines"]
    assert set(engines.keys()) == {"piper", "system", "fallback"}
    assert engines["fallback"] is True
    assert isinstance(engines["piper"], bool)
    assert isinstance(engines["system"], bool)


def test_voices_shape(client):
    resp = client.get("/voices", params={"language": "vi-VN"})
    assert resp.status_code == 200
    voices = resp.json()["voices"]
    assert isinstance(voices, list)
    assert len(voices) >= 1
    # Fallback voice is always present.
    ids = {v["id"] for v in voices}
    assert "fallback" in ids
    for v in voices:
        assert set(v.keys()) == {"id", "language", "displayName", "engine"}
        assert v["engine"] in {"piper", "system", "fallback"}


def test_synthesize_segments_fallback(client, tmp_path):
    out_dir = tmp_path / "tts_segments"
    payload = {
        "language": "vi-VN",
        "voiceId": "fallback",
        "outputDir": str(out_dir),
        "speed": 1.0,
        "segments": [
            {"id": "seg_0001", "text": "Xin chao", "startMs": 0, "endMs": 1000},
            {"id": "seg_0002", "text": "tam biet", "startMs": 1000, "endMs": 2200},
        ],
    }
    resp = client.post("/synthesize-segments", json=payload)
    assert resp.status_code == 200, resp.text

    segs = resp.json()["segments"]
    assert [s["segmentId"] for s in segs] == ["seg_0001", "seg_0002"]

    # WAVs were written with the segment_NNNN.wav naming.
    assert (out_dir / "segment_0001.wav").is_file()
    assert (out_dir / "segment_0002.wav").is_file()

    # Durations measured from the WAV header, sized to the window.
    assert abs(segs[0]["durationMs"] - 1000) <= 2
    assert abs(segs[1]["durationMs"] - 1200) <= 2
    assert segs[0]["speedRatio"] == 1.0
    assert Path(segs[0]["audioPath"]).is_file()


def test_synthesize_forced_piper_returns_structured_error(client, tmp_path):
    payload = {
        "language": "vi-VN",
        "voiceId": "piper:nope",
        "outputDir": str(tmp_path / "p"),
        "segments": [{"id": "seg_0001", "text": "hi", "startMs": 0, "endMs": 500}],
    }
    resp = client.post("/synthesize-segments", json=payload)
    assert resp.status_code == 503
    err = resp.json()["error"]
    assert err["code"] == "PIPER_MISSING"
    assert "message" in err and err["remediation"]


def test_synthesize_validation_error_on_bad_body(client):
    # Missing required outputDir.
    resp = client.post("/synthesize-segments", json={"language": "en", "segments": []})
    assert resp.status_code == 422
