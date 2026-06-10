"""Engine-level tests: language-aware Piper voice resolution and macOS `say`
voice matching. No real Piper/say is invoked — paths are faked on disk and the
voice listing is parsed from a canned string.
"""

from __future__ import annotations

import pytest

from app.config import load_settings
from app.engines import (
    EngineRegistry,
    PiperEngine,
    engine_voice_key,
    model_language,
    parse_say_voices,
)


def test_model_language_from_piper_filenames():
    assert model_language("vi_VN-vais1000-medium.onnx") == "vi"
    assert model_language("en_US-lessac-medium.onnx") == "en"
    assert model_language("de_DE-thorsten-medium.onnx") == "de"
    # No recognizable 2-3 letter language prefix.
    assert model_language("weird.onnx") == ""
    assert model_language("12345.onnx") == ""


@pytest.fixture
def piper_setup(tmp_path, monkeypatch):
    """A fake piper binary + a voices dir with vi and en voices."""
    binary = tmp_path / "piper"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)

    voices = tmp_path / "voices"
    voices.mkdir()
    (voices / "vi_VN-vais1000-medium.onnx").write_bytes(b"fake")
    (voices / "en_US-lessac-medium.onnx").write_bytes(b"fake")

    monkeypatch.setenv("PIPER_BINARY_PATH", str(binary))
    monkeypatch.setenv("PIPER_VOICES_DIR", str(voices))
    monkeypatch.delenv("PIPER_VOICE_MODEL_PATH", raising=False)
    return load_settings()


def test_piper_resolves_voice_per_language(piper_setup):
    engine = PiperEngine(piper_setup)

    assert engine.available()
    assert engine.supports("vi")
    assert engine.supports("en")
    assert not engine.supports("ja")  # no Japanese voice installed

    vi_model = engine.model_for("vi")
    assert vi_model is not None and vi_model.name == "vi_VN-vais1000-medium.onnx"
    en_model = engine.model_for("en")
    assert en_model is not None and en_model.name == "en_US-lessac-medium.onnx"
    assert engine.model_for("ja") is None


def test_piper_voice_key_embeds_the_resolved_model(piper_setup):
    engine = PiperEngine(piper_setup)
    assert engine_voice_key(engine, "vi", None) == "piper:vi_VN-vais1000-medium.onnx"
    assert engine_voice_key(engine, "en", None) == "piper:en_US-lessac-medium.onnx"
    # Different languages -> different cache identity (poisoning guard).
    assert engine_voice_key(engine, "vi", None) != engine_voice_key(engine, "en", None)


def test_piper_explicit_model_path_wins(piper_setup, tmp_path):
    other = tmp_path / "voices" / "vi_VN-other-low.onnx"
    other.write_bytes(b"fake")
    engine = PiperEngine(piper_setup)
    assert engine.model_for("vi", str(other)) == other


def test_registry_best_for_prefers_piper_when_it_speaks_the_language(piper_setup):
    registry = EngineRegistry(piper_setup)
    assert registry.best_for("vi").name == "piper"
    # No Japanese voice anywhere -> silent fallback, never a wrong-language engine.
    if not registry.system.supports("ja"):
        assert registry.best_for("ja").name == "fallback"


SAY_LISTING = """\
Alex                en_US    # Most people recognize me by my voice.
Bad News            en_US    # The light you see at the end of the tunnel...
Linh                vi_VN    # Xin chào, tên tôi là Linh.
Kyoko               ja_JP    # こんにちは、私の名前はKyokoです。
"""


def test_parse_say_voices_handles_spaces_and_locales():
    voices = parse_say_voices(SAY_LISTING)
    assert ("Alex", "en_US") in voices
    assert ("Bad News", "en_US") in voices
    assert ("Linh", "vi_VN") in voices
    assert ("Kyoko", "ja_JP") in voices


def test_system_engine_matches_voice_by_language(piper_setup, monkeypatch):
    registry = EngineRegistry(piper_setup)
    system = registry.system
    # Inject the canned voice listing regardless of platform.
    system._is_macos = True
    system._say_voices = parse_say_voices(SAY_LISTING)

    assert system.voice_for_language("vi") == "Linh"
    assert system.voice_for_language("ja") == "Kyoko"
    assert system.voice_for_language("ko") is None
