"""Service-layer tests using the always-available fallback engine.

These run with NO Piper / no system TTS dependency by forcing voiceId="fallback".
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import load_settings
from app.errors import TtsError
from app.schemas import SegmentIn
from app.tts_service import TtsService, segment_filename


@pytest.fixture
def service():
    return TtsService(load_settings())


def test_segment_filename_from_id():
    assert segment_filename("seg_0001", 99) == "segment_0001.wav"
    assert segment_filename("seg_0042", 1) == "segment_0042.wav"
    # No digits in id -> fall back to ordinal.
    assert segment_filename("intro", 7) == "segment_0007.wav"


def test_synthesize_fallback_writes_wavs_with_correct_durations(service, tmp_path):
    out_dir = tmp_path / "tts_segments"
    segments = [
        SegmentIn(id="seg_0001", text="Xin chao", startMs=0, endMs=1000),
        SegmentIn(id="seg_0002", text="The quick brown fox", startMs=1000, endMs=3500),
    ]

    batch = service.synthesize_segments(
        language="vi-VN",
        voice_id="fallback",
        segments=segments,
        output_dir=str(out_dir),
        speed=1.0,
    )
    results = batch.segments

    assert batch.engine == "fallback"
    assert batch.fallback_segments == 0  # forced fallback, no runtime degrade
    assert [r.segmentId for r in results] == ["seg_0001", "seg_0002"]

    # Files exist with the expected names.
    assert (out_dir / "segment_0001.wav").is_file()
    assert (out_dir / "segment_0002.wav").is_file()

    # Fallback sizes each clip to its window; durations are measured from WAV.
    assert abs(results[0].durationMs - 1000) <= 2
    assert abs(results[1].durationMs - 2500) <= 2

    # start/end and speedRatio passthrough.
    assert results[0].startMs == 0 and results[0].endMs == 1000
    assert results[1].speedRatio == 1.0
    # audioPath points at the written file.
    assert Path(results[0].audioPath) == (out_dir / "segment_0001.wav")


def test_speed_is_passed_through_to_speedratio(service, tmp_path):
    batch = service.synthesize_segments(
        language="en",
        voice_id="fallback",
        segments=[SegmentIn(id="seg_0001", text="hi", startMs=0, endMs=800)],
        output_dir=str(tmp_path / "o"),
        speed=1.25,
    )
    assert batch.segments[0].speedRatio == 1.25


def test_cache_hit_reuse(service, tmp_path):
    seg = SegmentIn(id="seg_0001", text="cached please", startMs=0, endMs=900)

    first = service.synthesize_segments(
        language="en",
        voice_id="fallback",
        segments=[seg],
        output_dir=str(tmp_path / "run1"),
        speed=1.0,
    )
    # Cache should now contain exactly one entry for this synthesis.
    assert len(list(service.cache.cache_dir.glob("*.wav"))) == 1

    # Second run into a different output dir reuses the cached audio (same bytes).
    second = service.synthesize_segments(
        language="en",
        voice_id="fallback",
        segments=[seg],
        output_dir=str(tmp_path / "run2"),
        speed=1.0,
    )
    # Still one cache entry — the second run was a hit, not a re-synthesis.
    assert len(list(service.cache.cache_dir.glob("*.wav"))) == 1

    b1 = Path(first.segments[0].audioPath).read_bytes()
    b2 = Path(second.segments[0].audioPath).read_bytes()
    assert b1 == b2
    assert first.segments[0].durationMs == second.segments[0].durationMs


def test_cache_key_separates_engines_and_voices():
    """Audio from one engine/voice must never satisfy another's request.

    This is the regression guard for the 'English say clips served to a Piper
    Vietnamese request' cache-poisoning bug: the cache token embeds the engine
    AND the concrete voice/model identity.
    """
    from app.cache import cache_key

    say_key = cache_key("seg_0001", "Xin chào", "system:say:default:vi|", 1.0)
    piper_key = cache_key(
        "seg_0001", "Xin chào", "piper:vi_VN-vais1000-medium.onnx|", 1.0
    )
    assert say_key != piper_key


def test_resynth_single(service, tmp_path):
    seg = SegmentIn(id="seg_0005", text="redo me", startMs=0, endMs=600)
    out = service.resynth_single(
        language="en",
        voice_id="fallback",
        segment=seg,
        output_dir=str(tmp_path / "single"),
        speed=1.0,
    )
    assert out.segmentId == "seg_0005"
    assert (tmp_path / "single" / "segment_0005.wav").is_file()
    assert abs(out.durationMs - 600) <= 2


def test_forced_piper_without_config_raises_piper_missing(service, tmp_path):
    with pytest.raises(TtsError) as ei:
        service.synthesize_segments(
            language="vi-VN",
            voice_id="piper:whatever",
            segments=[SegmentIn(id="seg_0001", text="hi", startMs=0, endMs=500)],
            output_dir=str(tmp_path / "p"),
            speed=1.0,
        )
    assert ei.value.code == "PIPER_MISSING"
    assert ei.value.remediation  # has remediation text


def test_auto_select_never_speaks_the_wrong_language(service, tmp_path, monkeypatch):
    """With no voice for the target language, auto-selection must yield SILENCE,
    not an available engine speaking another language (the English-dub bug)."""
    # Simulate a machine where the system engine exists but only speaks English.
    monkeypatch.setattr(service.registry.system, "available", lambda: True)
    monkeypatch.setattr(
        service.registry.system, "supports", lambda lang: lang in ("", "en")
    )

    batch = service.synthesize_segments(
        language="vi-VN",
        voice_id=None,  # auto-select
        segments=[SegmentIn(id="seg_0001", text="Xin chào", startMs=0, endMs=700)],
        output_dir=str(tmp_path / "auto"),
        speed=1.0,
    )
    assert batch.engine == "fallback"  # silent placeholder, flagged upstream

    # ...but for English the same machine legitimately uses the system engine.
    chosen, _ = service._resolve_engine(None, "en")
    assert chosen.name == "system"


def test_output_not_writable_raises(service):
    with pytest.raises(TtsError) as ei:
        service.synthesize_segments(
            language="en",
            voice_id="fallback",
            segments=[SegmentIn(id="seg_0001", text="hi", startMs=0, endMs=500)],
            # A path under an existing file is not creatable as a directory.
            output_dir="/dev/null/cannot/create/here",
            speed=1.0,
        )
    assert ei.value.code == "OUTPUT_NOT_WRITABLE"
