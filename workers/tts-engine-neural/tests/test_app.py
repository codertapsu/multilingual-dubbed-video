"""Tests for the non-ML surface of vd_tts_engine.

These exercise the HTTP contract, the voice catalog, and the silent-fallback path
WITHOUT the heavy neural deps (which aren't loadable in CI) — when the engine
can't load, every segment falls back to a measured silent WAV.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from vd_tts_engine import prereqs, voices
from vd_tts_engine.app import (
    SegmentIn,
    SynthesizeRequest,
    health,
    list_voices,
    synthesize_segments,
)


def test_voice_catalog_resolution():
    # Default = the recommended preset.
    assert voices.resolve(None).recommended is True
    # Bare id and engine-prefixed id resolve to the same voice.
    assert voices.resolve("vieneu-xuan-vinh").id == "vieneu-xuan-vinh"
    assert voices.resolve("vieneu:vieneu-xuan-vinh").id == "vieneu-xuan-vinh"
    assert voices.resolve("neutts:vieneu-ngoc-lan").id == "vieneu-ngoc-lan"
    # Unknown id falls back to the default.
    assert voices.resolve("nope").recommended is True


def test_voices_for_language_filters_on_base_subtag():
    assert len(voices.voices_for_language("vi-VN")) == len(voices.VOICES)
    assert len(voices.voices_for_language("vi")) == len(voices.VOICES)
    assert voices.voices_for_language("en-US") == []


def test_health_reports_fallback_always_true():
    h = health()
    assert h.status == "ok"
    assert h.engines["fallback"] is True
    assert "vieneu" in h.engines


def test_health_reports_espeak_prerequisite():
    h = health()
    assert "espeak_ng" in h.prerequisites
    assert isinstance(h.prerequisites["espeak_ng"], bool)
    # The standalone helper agrees with what /health reports.
    assert h.prerequisites["espeak_ng"] == prereqs.espeak_ng_available()


def test_engine_refuses_neutts_path_without_espeak(monkeypatch):
    # With no neural backend AND no espeak-ng, synth raises (-> caller fallback).
    import vd_tts_engine.engine as engine_mod

    monkeypatch.setattr(engine_mod, "espeak_ng_available", lambda: False)
    eng = engine_mod.VieNeuEngine()
    with pytest.raises(engine_mod.EngineUnavailable):
        eng.synth("Xin chào", "/tmp/should-not-write.wav", "vieneu-ngoc-huyen", 1.0)


def test_list_voices_endpoint():
    resp = list_voices("vi-VN")
    ids = [v.id for v in resp.voices]
    assert "vieneu-ngoc-huyen" in ids
    assert all(v.engine == "vieneu" and v.language == "vi-VN" for v in resp.voices)
    assert list_voices("en-US").voices == []


def test_synthesize_falls_back_to_sized_silence(tmp_path: Path):
    # No neural deps in CI -> every segment becomes a measured silent WAV.
    req = SynthesizeRequest(
        language="vi-VN",
        voiceId="vieneu-ngoc-huyen",
        outputDir=str(tmp_path),
        segments=[
            SegmentIn(id="seg_0001", text="Xin chào", startMs=0, endMs=1000),
            SegmentIn(id="seg_0002", text="Tạm biệt", startMs=1000, endMs=2500),
        ],
    )
    resp = synthesize_segments(req)

    assert resp.fallbackSegments == 2
    assert resp.engine == "fallback"
    assert len(resp.segments) == 2

    for seg, expected_ms in zip(resp.segments, (1000, 1500)):
        out = Path(seg.audioPath)
        assert out.is_file()
        # Duration matches the segment window (silence sized to endMs-startMs).
        assert abs(seg.durationMs - expected_ms) <= 5
        assert seg.speedRatio == 1.0
        with wave.open(str(out), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            assert w.getframerate() == 24000


def test_segment_id_is_sanitized_into_filename(tmp_path: Path):
    req = SynthesizeRequest(
        language="vi-VN",
        outputDir=str(tmp_path),
        segments=[SegmentIn(id="weird/../id 7", text="x", startMs=0, endMs=500)],
    )
    resp = synthesize_segments(req)
    out = Path(resp.segments[0].audioPath)
    assert out.parent == tmp_path
    assert "/" not in out.name and ".." not in out.name


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
