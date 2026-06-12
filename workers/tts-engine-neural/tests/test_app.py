"""Tests for the non-ML surface of vd_tts_engine.

These exercise the HTTP contract, the voice catalog, and the silent-fallback path
WITHOUT the vieneu SDK (not installed in CI) — when the engine can't load, every
segment falls back to a measured silent WAV.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from vd_tts_engine import voices
from vd_tts_engine.app import (
    SegmentIn,
    SynthesizeRequest,
    health,
    list_voices,
    synthesize_segments,
)


def test_voice_catalog_resolution():
    # Default = the recommended preset (Ngọc Lan).
    assert voices.resolve(None).id == "vieneu-ngoc-lan"
    assert voices.resolve(None).recommended is True
    # Bare id and engine-prefixed id resolve to the same voice.
    assert voices.resolve("vieneu-xuan-vinh").id == "vieneu-xuan-vinh"
    assert voices.resolve("vieneu:vieneu-xuan-vinh").id == "vieneu-xuan-vinh"
    # Unknown id falls back to the default.
    assert voices.resolve("nope").id == "vieneu-ngoc-lan"
    # Each preset carries the exact SDK name used for infer(voice=…).
    assert voices.resolve("vieneu-xuan-vinh").sdk_name == "Xuân Vĩnh"


def test_catalog_has_ten_presets():
    assert len(voices.VOICES) == 10
    assert sum(1 for v in voices.VOICES if v.recommended) == 1


def test_voices_for_language_filters_on_base_subtag():
    assert len(voices.voices_for_language("vi-VN")) == len(voices.VOICES)
    assert len(voices.voices_for_language("vi")) == len(voices.VOICES)
    assert voices.voices_for_language("en-US") == []


def test_health_reports_fallback_always_true():
    h = health()
    assert h.status == "ok"
    assert h.engines["fallback"] is True
    assert "vieneu" in h.engines


def test_list_voices_endpoint():
    resp = list_voices("vi-VN")
    ids = [v.id for v in resp.voices]
    assert "vieneu-ngoc-lan" in ids
    assert len(ids) == 10
    assert all(v.engine == "vieneu" and v.language == "vi-VN" for v in resp.voices)
    assert list_voices("en-US").voices == []


def test_synthesize_falls_back_to_sized_silence(tmp_path: Path):
    # No vieneu SDK in CI -> every segment becomes a measured silent WAV @ 48 kHz.
    req = SynthesizeRequest(
        language="vi-VN",
        voiceId="vieneu-ngoc-lan",
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
        assert abs(seg.durationMs - expected_ms) <= 5
        assert seg.speedRatio == 1.0
        with wave.open(str(out), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            assert w.getframerate() == 48000


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
