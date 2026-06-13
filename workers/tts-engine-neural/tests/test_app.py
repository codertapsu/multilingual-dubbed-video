"""Tests for the non-ML surface of vd_tts_engine.

Exercise the HTTP contract, the v2/v3 voice catalogs, and the silent-fallback
path WITHOUT the vieneu SDK (not installed in CI). The app's default engine
variant is v3 (no VIENEU_VARIANT env), so /voices + silent fallback use v3.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from vd_tts_engine import voices
from vd_tts_engine.engine import VieNeuEngine
from vd_tts_engine.app import (
    SegmentIn,
    SynthesizeRequest,
    health,
    list_voices,
    segment_filename,
    synthesize_segments,
)


def test_variant_catalogs():
    assert len(voices.V2_VOICES) == 7
    assert len(voices.V3_VOICES) == 10
    # Exactly one recommended default per variant.
    assert sum(1 for v in voices.V2_VOICES if v.recommended) == 1
    assert sum(1 for v in voices.V3_VOICES if v.recommended) == 1
    # v2 default is Trúc Ly (sdk key "Ly"); v3 default is Ngọc Lan.
    assert next(v for v in voices.V2_VOICES if v.recommended).sdk_name == "Ly"
    assert next(v for v in voices.V3_VOICES if v.recommended).sdk_name == "Ngọc Lan"


def test_resolve_is_variant_scoped():
    assert voices.resolve("v2", None).id == "vieneu-v2-ly"
    assert voices.resolve("v3", None).id == "vieneu-v3-ngoc-lan"
    assert voices.resolve("v2", "vieneu-v2-son").sdk_name == "Sơn"
    assert voices.resolve("v2", "vieneu:vieneu-v2-vinh").sdk_name == "Vinh"
    # A v3 id under v2 (mismatch) -> v2 default.
    assert voices.resolve("v2", "vieneu-v3-gia-bao").id == "vieneu-v2-ly"
    # Unknown -> default.
    assert voices.resolve("v3", "nope").id == "vieneu-v3-ngoc-lan"


def test_voices_for_language_filters_on_base_subtag():
    assert len(voices.voices_for_language("v2", "vi-VN")) == 7
    assert len(voices.voices_for_language("v3", "vi")) == 10
    assert voices.voices_for_language("v2", "en-US") == []


def test_engine_sample_rate_by_variant():
    assert VieNeuEngine("v2").sample_rate == 24000
    assert VieNeuEngine("v3").sample_rate == 48000
    # Default variant is v3.
    assert VieNeuEngine().variant == "v3"


def test_health_reports_fallback_always_true():
    h = health()
    assert h.status == "ok"
    assert h.engines["fallback"] is True
    assert "vieneu" in h.engines
    # The model isn't warmed in-process here (no uvicorn lifespan), so /health
    # reports it not-yet-resident — this is the signal the orchestrator waits on
    # before a long run so the load isn't charged to the synth timeout.
    assert h.loaded is False
    assert h.loadError is None


def test_warmup_records_error_when_sdk_missing():
    # vieneu isn't installed in CI, so warm-up fails: loaded stays False and the
    # error is recorded for /health.loadError (lets the orchestrator fail fast).
    eng = VieNeuEngine("v3")
    assert eng.loaded() is False
    assert eng.load_error is None
    with pytest.raises(Exception):
        eng.warmup()
    assert eng.loaded() is False
    assert eng.load_error is not None


def test_list_voices_endpoint_uses_default_variant_v3():
    resp = list_voices("vi-VN")
    ids = [v.id for v in resp.voices]
    assert len(ids) == 10  # default variant = v3
    assert "vieneu-v3-ngoc-lan" in ids
    assert all(v.engine == "vieneu" and v.language == "vi-VN" for v in resp.voices)
    assert list_voices("en-US").voices == []


def test_synthesize_falls_back_to_sized_silence(tmp_path: Path):
    # No vieneu SDK in CI -> every segment becomes a measured silent WAV.
    # Default variant v3 => 48 kHz.
    req = SynthesizeRequest(
        language="vi-VN",
        voiceId="vieneu-v3-ngoc-lan",
        outputDir=str(tmp_path),
        segments=[
            SegmentIn(id="seg_0001", text="Xin chào", startMs=0, endMs=1000),
            SegmentIn(id="seg_0002", text="Tạm biệt", startMs=1000, endMs=2500),
        ],
    )
    resp = synthesize_segments(req)
    assert resp.fallbackSegments == 2
    assert resp.engine == "fallback"
    # Files MUST be named segment_NNNN.wav (not seg_NNNN.wav) so the orchestrator
    # can probe them at alignment and read them at audio-mix.
    assert [Path(s.audioPath).name for s in resp.segments] == ["segment_0001.wav", "segment_0002.wav"]
    for seg, expected_ms in zip(resp.segments, (1000, 1500)):
        out = Path(seg.audioPath)
        assert out.is_file()
        assert abs(seg.durationMs - expected_ms) <= 5
        with wave.open(str(out), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getframerate() == 48000


def test_segment_filename_matches_orchestrator_convention():
    # Mirrors the bundled Piper worker + the orchestrator's segmentIdToIndex():
    # the TRAILING digit group decides the number; missing -> 1-based ordinal.
    assert segment_filename("seg_0001", 99) == "segment_0001.wav"
    assert segment_filename("seg_0042", 1) == "segment_0042.wav"
    assert segment_filename("intro", 7) == "segment_0007.wav"  # no digits -> ordinal
    assert segment_filename("seg_001_v2", 5) == "segment_0002.wav"  # trailing group wins


def test_segment_filename_is_traversal_safe(tmp_path: Path):
    # A hostile id resolves to a canonical, digit-only filename inside out_dir.
    req = SynthesizeRequest(
        language="vi-VN",
        outputDir=str(tmp_path),
        segments=[SegmentIn(id="weird/../id 7", text="x", startMs=0, endMs=500)],
    )
    resp = synthesize_segments(req)
    out = Path(resp.segments[0].audioPath)
    assert out.parent == tmp_path
    assert out.name == "segment_0007.wav"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
