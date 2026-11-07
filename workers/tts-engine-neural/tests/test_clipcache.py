"""Clip reuse, atomic clip writes and the ONNX thread limit (no vieneu SDK needed).

The incident behind all three: a 21-minute dub failed step 6 twice with
"Neural TTS engine did not respond within 1800000ms". The engine was slow, not
stuck: ONNX Runtime's default thread pool ran VieNeu at 5.3x slower than real
time, and each retry re-synthesized every clip from scratch.
"""

from __future__ import annotations

import os
import sys
import types
import wave
from pathlib import Path

import pytest

from vd_tts_engine import app as app_module
from vd_tts_engine import clipcache, engine as engine_module
from vd_tts_engine.app import SegmentIn, SynthesizeRequest, synthesize_segments
from vd_tts_engine.engine import VieNeuEngine, _limit_onnx_threads, onnx_threads


def _write_wav(path: str, n_frames: int = 4800) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x01\x00" * n_frames)


class _CountingBackend:
    """Stands in for the vieneu SDK: counts inferences, writes a real WAV."""

    def __init__(self, fail_on: str | None = None) -> None:
        self.calls: list[str] = []
        self.fail_on = fail_on

    def infer(self, text, voice=None):  # noqa: ARG002 - mirrors the SDK
        self.calls.append(text)
        return text

    def save(self, audio, out_path):
        if audio == self.fail_on:
            # A crash mid-write: a truncated file at the path we were given.
            Path(out_path).write_bytes(b"RIFF\x00\x00")
            raise RuntimeError("engine died mid-write")
        _write_wav(str(out_path), n_frames=4800 + 10 * len(audio))


@pytest.fixture()
def backend(monkeypatch) -> _CountingBackend:
    eng = VieNeuEngine(variant="v3")
    b = _CountingBackend()
    eng._backend = b  # bypass _ensure_loaded (no vieneu SDK in CI)
    monkeypatch.setattr(app_module, "_engine", eng)
    return b


def _request(tmp_path: Path, texts: dict[str, str], voice: str = "vieneu-v3-gia-bao") -> SynthesizeRequest:
    return SynthesizeRequest(
        language="vi-VN",
        voiceId=voice,
        outputDir=str(tmp_path),
        segments=[
            SegmentIn(id=sid, text=t, startMs=i * 1000, endMs=i * 1000 + 900) for i, (sid, t) in enumerate(texts.items())
        ],
    )


def test_key_changes_with_every_input_that_changes_the_audio() -> None:
    base = clipcache.clip_key("v3", "Gia Bảo", "Xin chào", "3.0.5")
    assert base == clipcache.clip_key("v3", "Gia Bảo", "Xin chào", "3.0.5")
    assert base != clipcache.clip_key("v2", "Gia Bảo", "Xin chào", "3.0.5")
    assert base != clipcache.clip_key("v3", "Ngọc Lan", "Xin chào", "3.0.5")
    assert base != clipcache.clip_key("v3", "Gia Bảo", "Xin chào!", "3.0.5")
    assert base != clipcache.clip_key("v3", "Gia Bảo", "Xin chào", "3.8.0")


def test_a_retry_reuses_every_finished_clip(tmp_path: Path, backend: _CountingBackend) -> None:
    texts = {"seg_0001": "Đại đế ở đâu?", "seg_0004": "Hai mươi tám tinh tú ở đâu?"}
    first = synthesize_segments(_request(tmp_path, texts))
    assert backend.calls == list(texts.values())
    assert first.reusedSegments == 0 and first.fallbackSegments == 0
    before = {s.segmentId: Path(s.audioPath).read_bytes() for s in first.segments}

    second = synthesize_segments(_request(tmp_path, texts))
    assert backend.calls == list(texts.values()), "a finished clip was synthesized again"
    assert second.reusedSegments == 2
    assert {s.segmentId: Path(s.audioPath).read_bytes() for s in second.segments} == before
    assert [s.durationMs for s in second.segments] == [s.durationMs for s in first.segments]


def test_only_changed_lines_are_resynthesized(tmp_path: Path, backend: _CountingBackend) -> None:
    synthesize_segments(_request(tmp_path, {"seg_0001": "Một", "seg_0002": "Hai"}))
    backend.calls.clear()
    resp = synthesize_segments(_request(tmp_path, {"seg_0001": "Một", "seg_0002": "Hai, đã sửa"}))
    assert backend.calls == ["Hai, đã sửa"]
    assert resp.reusedSegments == 1


def test_a_different_voice_is_a_different_clip(tmp_path: Path, backend: _CountingBackend) -> None:
    synthesize_segments(_request(tmp_path, {"seg_0001": "Một"}, voice="vieneu-v3-gia-bao"))
    resp = synthesize_segments(_request(tmp_path, {"seg_0001": "Một"}, voice="vieneu-v3-ngoc-lan"))
    assert len(backend.calls) == 2
    assert resp.reusedSegments == 0


def test_group_and_single_takes_both_survive_a_retry(tmp_path: Path, backend: _CountingBackend) -> None:
    # The drift pass re-speaks a merged group cue by cue into the SAME file
    # (segment_0001.wav first holds the group, then cue 1 alone). Keyed by
    # content, not filename, so a retry replays both without inference.
    synthesize_segments(_request(tmp_path, {"seg_0001": "Một. Hai."}))
    synthesize_segments(_request(tmp_path, {"seg_0001": "Một.", "seg_0002": "Hai."}))
    backend.calls.clear()
    synthesize_segments(_request(tmp_path, {"seg_0001": "Một. Hai."}))
    synthesize_segments(_request(tmp_path, {"seg_0001": "Một.", "seg_0002": "Hai."}))
    assert backend.calls == []


def test_a_crash_mid_write_leaves_no_clip_to_trust(tmp_path: Path, backend: _CountingBackend) -> None:
    backend.fail_on = "Hỏng"
    resp = synthesize_segments(_request(tmp_path, {"seg_0001": "Hỏng"}))
    assert resp.fallbackSegments == 1  # the line got placeholder silence
    leftovers = [p.name for p in tmp_path.rglob("*") if "partial" in p.name]
    assert leftovers == [], f"partial files left behind: {leftovers}"
    assert not list(clipcache.cache_dir(tmp_path).glob("*.wav")), "a failed take was cached"

    # The engine works again: the line is synthesized for real, never served
    # the silence from before.
    backend.fail_on = None
    backend.calls.clear()
    resp = synthesize_segments(_request(tmp_path, {"seg_0001": "Hỏng"}))
    assert backend.calls == ["Hỏng"]
    assert resp.fallbackSegments == 0 and resp.reusedSegments == 0


def test_clips_are_copies_not_links_into_the_cache(tmp_path: Path, backend: _CountingBackend) -> None:
    # Piper writes its per-line clips IN PLACE; a shared inode would let a Piper
    # re-dub of this project overwrite the cached VieNeu take.
    resp = synthesize_segments(_request(tmp_path, {"seg_0001": "Một"}))
    out = Path(resp.segments[0].audioPath)
    cached = next(clipcache.cache_dir(tmp_path).glob("*.wav"))
    assert not os.path.samefile(out, cached)
    out.write_bytes(b"overwritten by another engine")
    assert clipcache.lookup(tmp_path, cached.stem) == cached
    assert cached.read_bytes() != out.read_bytes()


def test_replace_waits_out_windows_target_in_use_errors(tmp_path: Path) -> None:
    attempts: list[int] = []

    def flaky(src: str, dst: str) -> None:
        attempts.append(1)
        if len(attempts) < 3:
            raise PermissionError(13, "The process cannot access the file")
        os.replace(src, dst)

    src, dst = tmp_path / "a.partial.wav", tmp_path / "a.wav"
    src.write_bytes(b"x" * 64)
    slept: list[float] = []
    clipcache.replace_with_retry(src, dst, replace=flaky, sleep=slept.append, platform="win32")
    assert dst.read_bytes() == b"x" * 64 and len(attempts) == 3 and slept == [0.01, 0.02]


def test_replace_is_bounded_and_never_retries_elsewhere(tmp_path: Path) -> None:
    def always(_src: str, _dst: str) -> None:
        raise PermissionError(13, "in use")

    with pytest.raises(PermissionError):
        clipcache.replace_with_retry(tmp_path / "a", tmp_path / "b", replace=always, sleep=lambda _s: None, platform="win32")
    calls = 0

    def counting(_src: str, _dst: str) -> None:
        nonlocal calls
        calls += 1
        raise PermissionError(13, "in use")

    with pytest.raises(PermissionError):
        clipcache.replace_with_retry(tmp_path / "a", tmp_path / "b", replace=counting, sleep=lambda _s: None, platform="linux")
    assert calls == 1


# --- ONNX Runtime thread limit -------------------------------------------------


def test_onnx_threads_defaults_to_two_and_honours_the_override() -> None:
    assert onnx_threads({}, cpu_count=16) == 2
    assert onnx_threads({}, cpu_count=1) == 1  # never more threads than cores
    assert onnx_threads({"VIENEU_ONNX_THREADS": "6"}, cpu_count=16) == 6
    assert onnx_threads({"VIENEU_ONNX_THREADS": "zero"}, cpu_count=16) == 2
    assert onnx_threads({"VIENEU_ONNX_THREADS": "0"}, cpu_count=16) == 2


@pytest.fixture()
def fake_sdk(monkeypatch):
    """A stand-in for vieneu._v3_turbo_engine.onnx_runtime_lite."""
    seen: list[int] = []

    class OnnxV3LiteEngine:
        def __init__(self, checkpoint_path: str = "repo", threads: int = 0, **_kw) -> None:
            seen.append(threads)

    mod = types.ModuleType("vieneu._v3_turbo_engine.onnx_runtime_lite")
    mod.OnnxV3LiteEngine = OnnxV3LiteEngine
    pkg = types.ModuleType("vieneu._v3_turbo_engine")
    pkg.onnx_runtime_lite = mod
    root = types.ModuleType("vieneu")
    root._v3_turbo_engine = pkg
    monkeypatch.setitem(sys.modules, "vieneu", root)
    monkeypatch.setitem(sys.modules, "vieneu._v3_turbo_engine", pkg)
    monkeypatch.setitem(sys.modules, "vieneu._v3_turbo_engine.onnx_runtime_lite", mod)
    return OnnxV3LiteEngine, seen


def test_the_thread_limit_reaches_the_sdk_engine(fake_sdk) -> None:
    cls, seen = fake_sdk
    assert _limit_onnx_threads(2) is True
    cls(checkpoint_path="x")  # how V3TurboVieNeuTTS constructs it: no threads
    cls(checkpoint_path="x", threads=8)  # an explicit value is left alone
    assert _limit_onnx_threads(3) is True  # re-applying updates, never double-wraps
    cls(checkpoint_path="x")
    assert seen == [2, 8, 3]


def test_an_sdk_without_the_hook_still_loads(monkeypatch) -> None:
    mod = types.ModuleType("vieneu._v3_turbo_engine.onnx_runtime_lite")

    class OnnxV3LiteEngine:  # a future SDK that dropped the parameter
        def __init__(self, checkpoint_path: str = "repo") -> None:
            pass

    mod.OnnxV3LiteEngine = OnnxV3LiteEngine
    monkeypatch.setitem(sys.modules, "vieneu._v3_turbo_engine.onnx_runtime_lite", mod)
    monkeypatch.setitem(sys.modules, "vieneu._v3_turbo_engine", types.ModuleType("vieneu._v3_turbo_engine"))
    sys.modules["vieneu._v3_turbo_engine"].onnx_runtime_lite = mod
    monkeypatch.setitem(sys.modules, "vieneu", types.ModuleType("vieneu"))
    assert _limit_onnx_threads(2) is False
    OnnxV3LiteEngine()  # unpatched, still constructible


def test_sdk_version_is_part_of_the_key(monkeypatch) -> None:
    eng = VieNeuEngine(variant="v3")
    a = eng.clip_key("Xin chào", "vieneu-v3-gia-bao")
    engine_module._sdk_version.cache_clear()
    monkeypatch.setattr(engine_module, "_sdk_version", lambda: "99.0")
    assert eng.clip_key("Xin chào", "vieneu-v3-gia-bao") != a
    assert eng.clip_key("  Xin chào ", "vieneu-v3-gia-bao") == eng.clip_key("Xin chào", "vieneu-v3-gia-bao")
    with pytest.raises(ValueError):
        eng.clip_key("   ", None)
