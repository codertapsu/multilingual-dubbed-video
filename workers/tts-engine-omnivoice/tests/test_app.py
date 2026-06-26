"""Tests for the non-ML surface of vd_omnivoice.

Exercise the HTTP contract, the designed-voice catalog, the per-language
duration-fit math, and the silent-fallback path WITHOUT mlx-audio (not installed
in CI / on non-Apple-Silicon). OmniVoice is multilingual, so /voices returns the
same designed set for every language.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from vd_omnivoice import voices
from vd_omnivoice.engine import OmniVoiceEngine, _chars_per_sec
from vd_omnivoice.app import (
    SegmentIn,
    SynthesizeRequest,
    health,
    list_voices,
    segment_filename,
    synthesize_segments,
)


def test_designed_voice_catalog():
    assert len(voices.VOICES) == 4
    # Exactly one recommended default.
    assert sum(1 for v in voices.VOICES if v.recommended) == 1
    assert next(v for v in voices.VOICES if v.recommended).id == "omnivoice-female-calm"
    # Each designed voice has a non-empty instruct prompt + a fixed seed.
    assert all(v.instruct and isinstance(v.seed, int) for v in voices.VOICES)


def test_instruct_prompts_are_short_attribute_lists():
    """Regression guard for OmniVoice voice quality (two real bugs).

    The instruct must be OmniVoice's Voice-Design format: a SHORT list of
    comma-separated attributes (gender, age, pitch, style) — NOT a descriptive
    sentence. Two constraints, each guarding a fixed bug:

    1. SHORT — a long descriptive sentence ("A calm, clear adult female narrator
       voice, natural and friendly.") gets vocalized into the speech when an
       explicit duration_s is passed (dub-fitting always passes one). Few words
       => no leak.

    2. EXPLICIT PITCH — a vague pitch lets the zero-shot speaker drift across
       segments (one dub produced male-voiced segments in a "female" voice).
       Anchoring "high pitch"/"low pitch" pins gender across segments.
    """
    for v in voices.VOICES:
        attrs = [a.strip() for a in v.instruct.split(",") if a.strip()]
        assert len(attrs) >= 2, f"{v.id}: instruct should be comma-separated attributes"
        assert len(v.instruct.split()) <= 6, f"{v.id}: instruct too long (leaks into speech)"
        low = v.instruct.lower()
        # Must steer gender so the female/male labels are meaningful...
        assert ("female" in low) or ("male" in low), f"{v.id}: no gender attribute"
        # ...and anchor pitch so the speaker doesn't drift male<->female per segment.
        assert "pitch" in low, f"{v.id}: missing explicit pitch anchor (voice drifts)"


def test_resolve_voice():
    assert voices.resolve(None).id == "omnivoice-female-calm"  # default
    assert voices.resolve("omnivoice-male-warm").id == "omnivoice-male-warm"
    assert voices.resolve("omnivoice:omnivoice-female-bright").id == "omnivoice-female-bright"  # engine-prefixed
    assert voices.resolve("nope").id == "omnivoice-female-calm"  # unknown -> default


def test_language_name_mapping():
    assert voices.language_name("en-US") == "english"
    assert voices.language_name("vi-VN") == "vietnamese"
    assert voices.language_name("zh-CN") == "chinese"
    assert voices.language_name("xx-YY") == "english"  # unknown -> English (still runs)


def test_voices_for_language_is_multilingual():
    # The SAME designed set for every language (unlike Piper/VieNeu).
    for lang in ("en-US", "vi-VN", "zh-CN", "ja-JP"):
        assert len(voices.voices_for_language(lang)) == 4


def test_health_reports_fallback_always_true():
    h = health()
    assert h.status == "ok"
    assert h.engines["fallback"] is True
    assert "omnivoice" in h.engines
    # mlx-audio isn't warmed in-process here, so the model is reported not resident.
    assert h.loaded is False
    assert h.loadError is None


def test_warmup_records_error_when_sdk_missing():
    # mlx-audio isn't installed in this test env, so warm-up fails: loaded stays
    # False and the error is recorded for /health.loadError (orchestrator fails fast).
    eng = OmniVoiceEngine()
    assert eng.loaded() is False
    with pytest.raises(Exception):
        eng.warmup()
    assert eng.loaded() is False
    assert eng.load_error is not None


def test_list_voices_endpoint_returns_designed_set():
    resp = list_voices("en-US")
    ids = [v.id for v in resp.voices]
    assert len(ids) == 4
    assert ids[0] == "omnivoice-female-calm"
    assert all(v.engine == "omnivoice" for v in resp.voices)
    # Multilingual: a non-English language gets the same set.
    assert len(list_voices("zh-CN").voices) == 4


def test_synthesize_falls_back_to_sized_silence(tmp_path: Path):
    # No mlx-audio -> every segment becomes a measured silent WAV at 24 kHz.
    req = SynthesizeRequest(
        language="en-US",
        voiceId="omnivoice-female-calm",
        outputDir=str(tmp_path),
        segments=[
            SegmentIn(id="seg_0001", text="Hello", startMs=0, endMs=1000),
            SegmentIn(id="seg_0002", text="World", startMs=1000, endMs=2500),
        ],
    )
    resp = synthesize_segments(req)
    assert resp.fallbackSegments == 2
    assert resp.engine == "fallback"
    assert [Path(s.audioPath).name for s in resp.segments] == ["segment_0001.wav", "segment_0002.wav"]
    for seg, expected_ms in zip(resp.segments, (1000, 1500)):
        out = Path(seg.audioPath)
        assert out.is_file()
        assert abs(seg.durationMs - expected_ms) <= 5
        with wave.open(str(out), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getframerate() == 24000


def test_segment_filename_matches_orchestrator_convention():
    assert segment_filename("seg_0001", 99) == "segment_0001.wav"
    assert segment_filename("seg_0042", 1) == "segment_0042.wav"
    assert segment_filename("intro", 7) == "segment_0007.wav"  # no digits -> ordinal
    assert segment_filename("seg_001_v2", 5) == "segment_0002.wav"  # trailing group wins


def test_chars_per_sec_table():
    assert _chars_per_sec("en-US") == 14.0
    assert _chars_per_sec("vi-VN") == 14.0  # default
    assert _chars_per_sec("zh-CN") == 5.5
    assert _chars_per_sec("ja-JP") == 7.0
    assert _chars_per_sec("xx-YY") == 14.0  # unknown -> default


def test_fit_duration_is_bounded_and_language_aware():
    eng = OmniVoiceEngine()
    text = "A" * 56  # English natural ≈ 56/14 = 4.0s

    # No target -> natural rate (None).
    assert eng._fit_duration_s(text, 0, "en-US") is None

    # A window within the comfortable band fits it ~exactly.
    assert abs(eng._fit_duration_s(text, 4000, "en-US") - 4.0) < 0.25

    # An absurdly short window clamps UP (never garbles to ~0.5s).
    ds_short = eng._fit_duration_s(text, 500, "en-US")
    assert ds_short > 1.5

    # An absurdly long window clamps DOWN (won't drag to ~99s).
    ds_long = eng._fit_duration_s(text, 99_000, "en-US")
    assert ds_long < 6.0

    # CJK is slower per character, so the same count yields a longer floor.
    ds_zh = eng._fit_duration_s("字" * 56, 500, "zh-CN")
    assert ds_zh > ds_short


# --- synth() output guards (the silent-codec safety nets) --------------------
# These inject a fake model so we exercise synth() WITHOUT mlx-audio (mlx is
# imported optionally inside synth for exactly this reason).


class _FakeResult:
    def __init__(self, audio):
        self.audio = audio


class _FakeModel:
    """Minimal mlx-audio stand-in: generate() yields the given chunks."""

    def __init__(self, chunks):
        self._chunks = chunks

    def generate(self, **_kwargs):
        for c in self._chunks:
            yield _FakeResult(c)


class _SequenceModel:
    """generate() yields a DIFFERENT chunk-list on each call, to exercise the
    audibility re-roll: pass [weak_draw, audible_draw, ...]."""

    def __init__(self, draws):
        self._draws = list(draws)
        self._calls = 0

    def generate(self, **_kwargs):
        draw = self._draws[min(self._calls, len(self._draws) - 1)]
        self._calls += 1
        for c in draw:
            yield _FakeResult(c)


def _engine_with_model(chunks):
    eng = OmniVoiceEngine()
    eng._model = _FakeModel(chunks)  # bypass _ensure_loaded (no mlx-audio needed)
    return eng


def test_synth_rejects_silent_output(tmp_path: Path):
    import numpy as np

    eng = _engine_with_model([np.zeros(2400, dtype=np.float32)])
    with pytest.raises(RuntimeError, match="silent"):
        eng.synth("hello", str(tmp_path / "o.wav"), None, "en-US", 0)


def test_synth_rejects_non_finite_output(tmp_path: Path):
    import numpy as np

    eng = _engine_with_model([np.full(2400, np.nan, dtype=np.float32)])
    with pytest.raises(RuntimeError, match="non-finite"):
        eng.synth("hello", str(tmp_path / "o.wav"), None, "en-US", 0)


def test_synth_rejects_empty_output(tmp_path: Path):
    eng = _engine_with_model([])  # generate yields nothing
    with pytest.raises(RuntimeError, match="no audio"):
        eng.synth("hello", str(tmp_path / "o.wav"), None, "en-US", 0)


def test_synth_writes_real_audio(tmp_path: Path):
    import numpy as np

    audio = (0.5 * np.sin(np.linspace(0.0, 200.0, 4800))).astype(np.float32)
    eng = _engine_with_model([audio])
    out = tmp_path / "o.wav"
    eng.synth("hello world", str(out), None, "en-US", 0)
    with wave.open(str(out)) as w:
        assert w.getframerate() == 24000
        assert w.getnframes() == 4800


def test_synth_rerolls_weak_draw_and_keeps_audible(tmp_path: Path):
    # First draw is (near-)silent; the engine must re-roll and keep the audible
    # second draw instead of shipping the inaudible one.
    import numpy as np

    silent = [np.zeros(2400, dtype=np.float32)]
    audible = [(0.5 * np.sin(np.linspace(0.0, 200.0, 4800))).astype(np.float32)]
    eng = OmniVoiceEngine()
    eng._model = _SequenceModel([silent, audible])
    out = tmp_path / "o.wav"
    eng.synth("hello", str(out), None, "en-US", 0)
    with wave.open(str(out)) as w:
        assert w.getnframes() == 4800  # kept the 2nd (audible) draw, not the 1st


def test_synth_keeps_loudest_when_all_weak(tmp_path: Path):
    # If every re-roll is weak (but not digitally silent), keep the loudest draw
    # rather than failing — a quiet clip still beats placeholder silence.
    import numpy as np

    quiet = [np.full(2400, 0.02, dtype=np.float32)]
    quieter = [np.full(2400, 0.008, dtype=np.float32)]
    eng = OmniVoiceEngine()
    eng._model = _SequenceModel([quieter, quiet, quieter])
    out = tmp_path / "o.wav"
    eng.synth("hello", str(out), None, "en-US", 0)
    with wave.open(str(out)) as w:
        peak = max(abs(s) for s in np.frombuffer(w.readframes(w.getnframes()), "<i2"))
    assert peak > 0.015 * 32767  # wrote the louder (0.02) draw


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
