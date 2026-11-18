"""VieNeu through SDK 3.8 (engine38.py), tested without the SDK, torch or a GPU.

What must hold, and why:

* voice ids are the catalog's (``vieneu38-<slug>``): the orchestrator stores only
  the id, and a Python slug that drifted from the JS generator would make a
  voice the library offers unknown to the engine;
* a voice the engine lacks is an ERROR, never the default voice;
* a cloned voice is identified by its fingerprint (clip keys, seeds), so a
  rename keeps every clip and a re-recording redoes them;
* the cloned-voice file is plain arrays: loading one must never unpickle;
* the GPU batches lines, and a failed batch falls back line by line.
"""

from __future__ import annotations

import json
import re
import sys
import types
from pathlib import Path

import pytest

from vd_tts_engine import app as app_mod
from vd_tts_engine import engine38, pinned
from vd_tts_engine.app import SegmentIn, SynthesizeRequest, VoiceRefIn, synthesize_segments
from vd_tts_engine.engine38 import UnknownVoice, VieNeu38Engine, VoiceRef, parse_voices, slug
from vd_tts_engine.wavio import write_silent_wav

REPO = Path(__file__).resolve().parents[3]
CATALOG = REPO / "packages" / "node-orchestrator" / "src" / "voices" / "catalog" / "vieneu.json"

# The shape of the SDK's assets/voices_v3_turbo.json (3.8.4), trimmed.
SDK_TABLE = {
    "default_voice": "Hải Đăng",
    "presets": {
        "Thục Đoan": {"gender": "nữ", "region": "Nam", "style": "doc_truyen"},
        "Hải Đăng": {"gender": "nam", "region": "Bắc", "style": "tu_nhien", "featured": 5},
        "Adam bựa": {"gender": "nam", "region": "Bắc", "style": "tu_nhien", "featured": 1},
        "Quang Sơn": {"gender": "nam", "region": "Trung", "featured": True},
    },
}


@pytest.fixture
def presets(monkeypatch: pytest.MonkeyPatch):
    voices = tuple(parse_voices(SDK_TABLE))
    monkeypatch.setattr(engine38, "sdk_voices", lambda: voices)
    return voices


# ---- ids -------------------------------------------------------------------


def test_slug_matches_the_catalog_for_every_voice():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    assert len(catalog["voices"]) == 25
    for v in catalog["voices"]:
        assert engine38.ID_PREFIX + slug(v["name"]) == v["id"], v["name"]


def test_parse_voices_reads_gender_accent_and_the_default(presets):
    by_name = {v.sdk_name: v for v in presets}
    assert by_name["Hải Đăng"].id == "vieneu38-hai-dang"
    assert by_name["Hải Đăng"].recommended is True
    assert (by_name["Thục Đoan"].gender, by_name["Thục Đoan"].accent) == ("female", "south")
    assert by_name["Quang Sơn"].accent == "central"
    # Editors' picks first, in their order; a boolean is not a rank.
    assert [v.sdk_name for v in presets][:2] == ["Adam bựa", "Hải Đăng"]
    assert by_name["Quang Sơn"].featured is None


def test_an_unknown_voice_is_an_error_never_the_default(presets):
    eng = VieNeu38Engine()
    assert eng._preset(None).sdk_name == "Hải Đăng"
    assert eng._preset("vieneu38-thuc-doan").sdk_name == "Thục Đoan"
    with pytest.raises(UnknownVoice):
        eng._preset("vieneu-v3-ngoc-lan")  # a 3.0.5 voice 3.8 does not have
    with pytest.raises(UnknownVoice):
        eng.validate_voice("vieneu38-nobody")


# ---- cloned voices -----------------------------------------------------------


def test_enrollment_round_trip_and_fingerprint(tmp_path):
    np = pytest.importorskip("numpy")
    emb = np.linspace(-1, 1, engine38.SPEAKER_DIM, dtype=np.float32)
    codes = np.arange(48, dtype=np.int64).reshape(3, 16)
    out = tmp_path / "voice.npz"
    fp = engine38.write_enrollment(str(out), emb, codes)
    voice = engine38.read_enrollment(str(out))
    assert np.array_equal(voice["speaker_emb"], emb)
    assert np.array_equal(voice["codes"], codes)
    # The fingerprint names the data, not the file.
    assert engine38.enrollment_fingerprint(emb, codes) == fp
    assert engine38.enrollment_fingerprint(emb, codes[:2]) != fp
    assert not list(tmp_path.glob("*.partial*"))


def test_a_voice_file_is_never_unpickled(tmp_path):
    np = pytest.importorskip("numpy")
    bad = tmp_path / "evil.npz"
    np.savez(bad, speaker_emb=np.array([object()], dtype=object))
    with pytest.raises(ValueError):  # numpy refuses: allow_pickle=False
        engine38.read_enrollment(str(bad))


def test_a_malformed_voice_file_is_refused(tmp_path):
    np = pytest.importorskip("numpy")
    bad = tmp_path / "short.npz"
    np.savez(bad, speaker_emb=np.ones(7, dtype=np.float32))
    with pytest.raises(UnknownVoice):
        engine38.read_enrollment(str(bad))


def test_clip_keys_follow_the_fingerprint_not_the_name(presets, monkeypatch):
    monkeypatch.setattr(engine38, "_sdk_version", lambda: "3.8.4")
    eng = VieNeu38Engine()
    a = eng.clip_key("xin chào", "vp_anything", VoiceRef(file="x", fingerprint="f" * 64))
    b = eng.clip_key("xin chào", "vp_renamed", VoiceRef(file="y", fingerprint="f" * 64))
    c = eng.clip_key("xin chào", "vp_anything", VoiceRef(file="x", fingerprint="e" * 64))
    preset = eng.clip_key("xin chào", "vieneu38-hai-dang")
    assert a == b
    assert a != c
    assert preset not in (a, c)


# ---- synthesis ---------------------------------------------------------------


class FakeBackend:
    def __init__(self, fail_batch: bool = False) -> None:
        self.calls: list[tuple] = []
        self.fail_batch = fail_batch

    def infer(self, text, voice=None):
        self.calls.append(("infer", text, voice))
        return text

    def infer_batch(self, texts, voice=None, batch_size=None):
        self.calls.append(("batch", tuple(texts), voice, batch_size))
        if self.fail_batch:
            raise RuntimeError("CUDA out of memory")
        return list(texts)

    def save(self, audio, out_path):
        write_silent_wav(out_path, 100 + 10 * len(audio), sample_rate=48000)

    def encode_reference(self, path, denoise=True):
        import numpy as np  # noqa: PLC0415

        self.calls.append(("enroll", path, denoise))
        return np.ones(engine38.SPEAKER_DIM, dtype=np.float32), np.zeros((4, 16), dtype=np.int64)


def _engine(backend: FakeBackend, device: str = "cpu") -> VieNeu38Engine:
    eng = VieNeu38Engine()
    eng._backend = backend
    eng._device = device
    return eng


def test_cpu_synthesizes_line_by_line_with_the_preset_name(presets, tmp_path):
    backend = FakeBackend()
    eng = _engine(backend)
    outs = [str(tmp_path / f"{i}.wav") for i in range(3)]
    errors = eng.synth_many(["một", "", "ba"], outs, "vieneu38-thuc-doan", 1.0)
    assert [e is None for e in errors] == [True, False, True]
    assert [c[2] for c in backend.calls] == ["Thục Đoan", "Thục Đoan"]


def test_gpu_batches_and_falls_back_line_by_line(presets, tmp_path):
    outs = [str(tmp_path / f"{i}.wav") for i in range(3)]
    batched = FakeBackend()
    assert _engine(batched, "cuda").synth_many(["a", "b", "c"], outs, None, 1.0) == [None, None, None]
    assert batched.calls == [("batch", ("a", "b", "c"), "Hải Đăng", engine38.GPU_BATCH_LINES)]

    failing = FakeBackend(fail_batch=True)
    assert _engine(failing, "cuda").synth_many(["a", "b", "c"], outs, None, 1.0) == [None, None, None]
    assert [c[0] for c in failing.calls] == ["batch", "infer", "infer", "infer"]


def test_a_cloned_voice_speaks_from_its_file(presets, tmp_path):
    np = pytest.importorskip("numpy")
    voice_file = tmp_path / "v.npz"
    fp = engine38.write_enrollment(str(voice_file), np.ones(192, dtype=np.float32), None)
    backend = FakeBackend()
    eng = _engine(backend)
    errors = eng.synth_many(["xin chào"], [str(tmp_path / "o.wav")], "vp_1", 1.0, VoiceRef(str(voice_file), fp))
    assert errors == [None]
    voice = backend.calls[0][2]
    assert isinstance(voice, dict) and voice["codes"] is None and voice["speaker_emb"].shape == (192,)


def test_enroll_writes_the_voice_and_reports_its_fingerprint(presets, tmp_path, monkeypatch):
    pytest.importorskip("numpy")
    monkeypatch.setattr(engine38, "_sdk_version", lambda: "3.8.4")
    ref = tmp_path / "ref.wav"
    write_silent_wav(str(ref), 3000, sample_rate=16000)
    backend = FakeBackend()
    out = _engine(backend).enroll(str(ref), str(tmp_path / "p" / "vieneu.npz"), denoise=False)
    assert re.fullmatch(r"[0-9a-f]{64}", out["fingerprint"])
    assert out == {"fingerprint": out["fingerprint"], "engineVersion": "3.8.4", "codeFrames": 4}
    assert ("enroll", str(ref), False) in backend.calls
    assert (tmp_path / "p" / "vieneu.npz").is_file()


# ---- the HTTP contract ---------------------------------------------------------


def _request(tmp_path, **kw) -> SynthesizeRequest:
    return SynthesizeRequest(
        language="vi-VN",
        segments=[SegmentIn(id="seg_0001", text="xin chào", startMs=0, endMs=1000)],
        outputDir=str(tmp_path),
        **kw,
    )


def test_an_unknown_voice_stops_the_request_with_its_reason(presets, tmp_path, monkeypatch):
    monkeypatch.setattr(app_mod, "_engine", _engine(FakeBackend()))
    res = synthesize_segments(_request(tmp_path, voiceId="vieneu38-nobody"))
    assert res.status_code == 422
    body = json.loads(res.body)
    assert body["error"]["code"] == "TTS_VOICE_MISSING"
    assert not list(tmp_path.glob("segment_*.wav"))  # no silent placeholder


def test_the_old_engine_refuses_a_cloned_voice(tmp_path, monkeypatch):
    from vd_tts_engine.engine import VieNeuEngine  # noqa: PLC0415

    monkeypatch.setattr(app_mod, "_engine", VieNeuEngine("v3"))
    res = synthesize_segments(_request(tmp_path, voiceId="vp_1", voiceRef=VoiceRefIn(file="x.npz", fingerprint="f" * 64)))
    assert res.status_code == 422
    assert json.loads(res.body)["error"]["code"] == "VOICE_ENGINE_CANNOT_CLONE"


def test_the_v38_variant_selects_the_new_adapter(monkeypatch):
    monkeypatch.setenv("VIENEU_VARIANT", "v38")
    assert isinstance(app_mod._make_engine(), VieNeu38Engine)
    monkeypatch.setenv("VIENEU_VARIANT", "v3")
    assert not isinstance(app_mod._make_engine(), VieNeu38Engine)


# ---- pinning -----------------------------------------------------------------


def test_v38_snapshots_are_pinned_commits_in_separate_folders():
    repos = [*pinned.V38_ONNX.values(), pinned.V38_TORCH, pinned.CODEC_ONNX]
    for repo in repos:
        assert re.fullmatch(r"[0-9a-f]{40}", repo.revision), repo.repo_id
    assert len({r.dirname for r in repos}) == len(repos)
    assert "speaker_encoder.onnx" in pinned.V38_ONNX["fp32"].required
    assert "onnx_int8/vieneu_backbone_shared.data" in pinned.V38_ONNX["int8"].required


def test_precision_defaults_to_fp32():
    assert engine38.vieneu_precision({}) == "fp32"
    assert engine38.vieneu_precision({"VIENEU_PRECISION": "INT8"}) == "int8"
    assert engine38.vieneu_precision({"VIENEU_PRECISION": "fp16"}) == "fp32"


def test_the_codec_folder_is_injected_only_when_the_sdk_takes_it(monkeypatch):
    seen = {}

    class Engine:
        def __init__(self, checkpoint_path=None, codec_dir=None, threads=0):
            seen["codec_dir"] = codec_dir

    mod = types.ModuleType("vieneu._v3_turbo_engine.onnx_runtime_lite")
    mod.OnnxV3LiteEngine = Engine
    pkg = types.ModuleType("vieneu._v3_turbo_engine")
    pkg.onnx_runtime_lite = mod
    monkeypatch.setitem(sys.modules, "vieneu", types.ModuleType("vieneu"))
    monkeypatch.setitem(sys.modules, "vieneu._v3_turbo_engine", pkg)
    monkeypatch.setitem(sys.modules, "vieneu._v3_turbo_engine.onnx_runtime_lite", mod)
    assert engine38._with_codec_dir("/pinned/codec") is True
    Engine(checkpoint_path="x")
    assert seen["codec_dir"] == "/pinned/codec"
    Engine(checkpoint_path="x", codec_dir="/explicit")
    assert seen["codec_dir"] == "/explicit"

    class Old:
        def __init__(self, checkpoint_path=None):
            pass

    mod.OnnxV3LiteEngine = Old
    assert engine38._with_codec_dir("/pinned/codec") is False
