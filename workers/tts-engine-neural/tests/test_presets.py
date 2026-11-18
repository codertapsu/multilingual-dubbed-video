"""ZeroTTS, Kokoro and Supertonic adapters (presets.py), without the engines.

* their voice tables are the catalog's (ids are what projects store);
* a voice they lack is an error, and they refuse cloned voices;
* a clip's key includes the language for multilingual engines and the rate
  for engines that honour one, so a cached clip is never reused across them;
* each engine is called the way Phase 0 ran it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from vd_tts_engine import app as app_mod
from vd_tts_engine import presets
from vd_tts_engine.app import SegmentIn, SynthesizeRequest, synthesize_segments
from vd_tts_engine.engine38 import UnknownVoice, VoiceRef
from vd_tts_engine.presets import (
    KokoroEngine,
    SupertonicEngine,
    ZeroTTSEngine,
    engine_threads,
    kokoro_voice_pack,
    make_adapter,
)

REPO = Path(__file__).resolve().parents[3]
CATALOG = REPO / "packages" / "node-orchestrator" / "src" / "voices" / "catalog"


@pytest.mark.parametrize(
    "engine, table",
    [("zerotts", presets.ZEROTTS_VOICES), ("kokoro", presets.KOKORO_VOICES), ("supertonic", presets.SUPERTONIC_VOICES)],
)
def test_voice_tables_match_the_catalog(engine, table):
    catalog = json.loads((CATALOG / f"{engine}.json").read_text(encoding="utf-8"))
    cat = {v["id"]: v for v in catalog["voices"]}
    assert set(cat) == {v.id for v in table}, engine
    for v in table:
        assert cat[v.id]["gender"] == v.gender, v.id
        if "*" not in v.languages and engine != "supertonic":
            assert cat[v.id]["languages"] == list(v.languages), v.id
    if engine == "supertonic":
        assert catalog["languages"] == presets.SUPERTONIC_LANGS


def test_threads_default_to_four_and_can_be_overridden():
    assert engine_threads({}, cpu_count=16) == 4
    assert engine_threads({}, cpu_count=2) == 2
    assert engine_threads({"VD_TTS_THREADS": "8"}, cpu_count=16) == 8
    assert engine_threads({"VD_TTS_THREADS": "zero"}, cpu_count=16) == 4


def test_adapters_are_picked_by_name():
    assert isinstance(make_adapter("kokoro"), KokoroEngine)
    assert isinstance(make_adapter(" Supertonic "), SupertonicEngine)
    assert make_adapter("nope") is None


def test_voices_are_strict_and_presets_only():
    eng = ZeroTTSEngine()
    assert eng._preset(None).sdk_name == "maichi"
    with pytest.raises(UnknownVoice):
        eng.validate_voice("zerotts-nobody")
    with pytest.raises(UnknownVoice):
        eng.validate_voice("zerotts-maichi", VoiceRef(file="x.npz", fingerprint="f" * 64))


def test_kokoro_voices_speak_only_their_language():
    eng = KokoroEngine()
    assert [v.id for v in eng.voices("ja-JP")] == ["kokoro-jf_alpha", "kokoro-jf_gongitsune", "kokoro-jf_nezumi", "kokoro-jf_tebukuro", "kokoro-jm_kumo"]
    assert eng.voices("vi") == []
    assert len(SupertonicEngine().voices("vi-VN")) == 10


def test_clip_keys_follow_language_and_rate(monkeypatch):
    monkeypatch.setattr(SupertonicEngine, "sdk_version", lambda self: "x")
    eng = SupertonicEngine()
    base = eng.clip_key("xin chào", "supertonic-f1", language="vi-VN", speed=1.0)
    assert base == eng.clip_key("xin chào", "supertonic-f1", language="vi", speed=1.0)
    assert base != eng.clip_key("xin chào", "supertonic-f1", language="ko", speed=1.0)
    assert base != eng.clip_key("xin chào", "supertonic-f1", language="vi", speed=1.2)
    assert base != eng.clip_key("xin chào", "supertonic-f2", language="vi", speed=1.0)


def _loaded(eng, backend):
    eng._backend = backend
    eng._device = "cpu"
    return eng


def test_zerotts_synthesizes_with_the_preset_name(tmp_path):
    pytest.importorskip("numpy")
    calls = []

    class Fake:
        def synthesize(self, text, voice=None):
            calls.append((text, voice))
            return [0.1] * 4800

    eng = _loaded(ZeroTTSEngine(), Fake())
    out = tmp_path / "a.wav"
    assert eng.synth_many(["xin chào"], [str(out)], "zerotts-hamy", 1.3, language="vi-VN") == [None]
    assert calls == [("xin chào", "hamy")]
    assert out.stat().st_size > 44


def test_kokoro_reads_each_voice_in_its_own_language_at_the_rate(tmp_path):
    pytest.importorskip("numpy")
    calls = []

    class Fake:
        def create(self, text, voice, speed, lang=None, is_phonemes=False):
            calls.append((text, voice, speed, lang, is_phonemes))
            return [0.0] * 2400, 24000

    eng = _loaded(KokoroEngine(), Fake())
    # Chinese (and Japanese) reach the model as misaki's phonemes, never
    # through espeak-ng, which read every kanji as its name.
    eng._g2p["z"] = lambda text: (f"<{text}>", None)
    outs = [str(tmp_path / f"{i}.wav") for i in range(2)]
    assert eng.synth_many(["你好", "你好"], outs, "kokoro-zf_xiaobei", 1.25, language="zh-CN") == [None, None]
    assert calls[0] == ("<你好>", "zf_xiaobei", 1.25, None, True)
    eng.synth_many(["hello"], outs[:1], "kokoro-bf_emma", 1.0, language="en")
    assert calls[-1] == ("hello", "bf_emma", 1.0, "en-gb", False)


def test_kokoro_without_misaki_says_to_update_the_pack(tmp_path, monkeypatch):
    pytest.importorskip("numpy")
    monkeypatch.setitem(__import__("sys").modules, "misaki.cutlet", None)

    class Fake:
        def create(self, *args, **kwargs):  # pragma: no cover - never reached
            raise AssertionError("espeak-ng must not speak Japanese")

    eng = _loaded(KokoroEngine(), Fake())
    errors = eng.synth_many(["こんにちは"], [str(tmp_path / "j.wav")], "kokoro-jf_alpha", 1.0, language="ja-JP")
    assert "update it in Settings" in str(errors[0])


def test_kokoro_keys_misaki_takes_apart_from_espeak_ones(monkeypatch):
    monkeypatch.setattr(KokoroEngine, "sdk_version", lambda self: "0.6.1")
    monkeypatch.setattr(presets, "_misaki_version", lambda: "0.9.4")
    eng = KokoroEngine()
    ja = eng.clip_key("こんにちは", "kokoro-jf_alpha", language="ja-JP")
    en = eng.clip_key("hello", "kokoro-af_heart", language="en-US")
    monkeypatch.setattr(presets, "_misaki_version", lambda: "0.9.5")
    assert eng.clip_key("こんにちは", "kokoro-jf_alpha", language="ja-JP") != ja
    assert eng.clip_key("hello", "kokoro-af_heart", language="en-US") == en


def test_misaki_reads_japanese_and_chinese_as_words_not_letter_names():
    """With the pack's real G2P installed (skipped in a venv without it)."""
    pytest.importorskip("fugashi")
    pytest.importorskip("unidic_lite")
    cutlet = pytest.importorskip("misaki.cutlet")
    zh = pytest.importorskip("misaki.zh")
    # "konnichiwa. kore wa watashi no koe desu.", as the pinned UniDic-lite reads it.
    assert cutlet.Cutlet()("こんにちは。これは私の声です。")[0] == "koɲɲiʨiβa. koɾe βa βatakɯɕi no koe desɨ."
    # Tones as arrows (ni3 hao3 -> ni↓xau↓), as Kokoro's Chinese voices were trained.
    assert zh.ZHG2P()("你好！这是我的声音。")[0] == "ni↓xau↓! ꭧɤ↘ ʂɨ↘ wo↓ tɤ ʂə→ŋi→n."


def test_supertonic_scales_its_pace_and_refuses_a_language_it_lacks(tmp_path):
    np = pytest.importorskip("numpy")
    calls = []

    class Fake:
        def __call__(self, text, lang, style, steps, speed):
            calls.append((lang, steps, round(speed, 4)))
            return np.ones((1, 44100), dtype=np.float32) * 0.1, np.array([0.5])

    eng = _loaded(SupertonicEngine(), Fake())
    eng._style = lambda name: name  # no style files in a unit test
    out = tmp_path / "s.wav"
    assert eng.synth_many(["xin chào"], [str(out)], "supertonic-m2", 1.2, language="vi-VN") == [None]
    assert calls == [("vi", presets.SUPERTONIC_STEPS, 1.26)]
    # The duration the model reports trims the vocoder's padding: 0.5 s here.
    import wave

    with wave.open(str(out)) as w:
        assert w.getnframes() == 22050
    errors = eng.synth_many(["你好"], [str(tmp_path / "z.wav")], "supertonic-m2", 1.0, language="zh-CN")
    assert isinstance(errors[0], ValueError)


def test_kokoro_voice_pack_is_built_once_from_the_pinned_files(tmp_path):
    np = pytest.importorskip("numpy")
    voices = tmp_path / "voices"
    voices.mkdir()
    for name in ("af_heart", "zm_yunxi"):
        np.arange(510 * 256, dtype=np.float32).tofile(voices / f"{name}.bin")
    out = kokoro_voice_pack(voices, tmp_path / "derived" / "voices.npz")
    with np.load(out, allow_pickle=False) as z:
        assert sorted(z.files) == ["af_heart", "zm_yunxi"]
        assert z["af_heart"].shape == (510, 1, 256)
    stamp = out.stat().st_mtime_ns
    assert kokoro_voice_pack(voices, out) == out
    assert out.stat().st_mtime_ns == stamp


def test_the_server_passes_the_language_and_refuses_unknown_voices(tmp_path, monkeypatch):
    seen = {}

    class Eng(KokoroEngine):
        def synth_many(self, texts, out_paths, voice_id, speed, voice_ref=None, language=None):
            seen["language"] = language
            for p in out_paths:
                from vd_tts_engine.wavio import write_silent_wav  # noqa: PLC0415

                write_silent_wav(p, 500, sample_rate=24000)
            return [None] * len(texts)

    eng = Eng()
    eng._backend = object()
    monkeypatch.setattr(Eng, "sdk_version", lambda self: "0.6.1")
    monkeypatch.setattr(app_mod, "_engine", eng)
    req = SynthesizeRequest(
        language="ja-JP",
        voiceId="kokoro-jf_alpha",
        segments=[SegmentIn(id="seg_0001", text="こんにちは", startMs=0, endMs=1000)],
        outputDir=str(tmp_path),
        speed=1.1,
    )
    res = synthesize_segments(req)
    assert res.fallbackSegments == 0
    assert seen["language"] == "ja-JP"

    bad = synthesize_segments(req.model_copy(update={"voiceId": "kokoro-xx_nobody"}))
    assert bad.status_code == 422


def test_the_adapter_env_selects_the_engine(monkeypatch):
    monkeypatch.setenv("VD_TTS_ADAPTER", "zerotts")
    assert isinstance(app_mod._make_engine(), ZeroTTSEngine)
    monkeypatch.setenv("VD_TTS_ADAPTER", "")
    monkeypatch.setenv("VIENEU_VARIANT", "v3")
    assert not isinstance(app_mod._make_engine(), presets.PresetEngine)
