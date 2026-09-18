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
    parse_sapi_voices,
    parse_say_voices,
    sapi_rate,
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


# --- Windows SAPI branch ----------------------------------------------------
# Windows had no SystemEngine at all, so a Windows user without a Piper voice
# got a SILENT dub where macOS/Linux users got intelligible speech. These tests
# run on any OS by forcing the platform flags and faking the subprocess.

SAPI_LISTING = (
    "Microsoft David Desktop\ten-US\n"
    "Microsoft Zira Desktop\ten-US\n"
    "Microsoft Huihui Desktop\tzh-CN\n"
)


@pytest.fixture
def windows_system(piper_setup, monkeypatch):
    """A SystemEngine pretending to run on Windows, with a canned voice list."""
    from app import engines as engines_mod

    calls: list[list[str]] = []

    class _Completed:
        def __init__(self, stdout: bytes) -> None:
            self.stdout = stdout
            self.stderr = b""
            self.returncode = 0

    def _fake_run(argv, *, input_bytes=None, timeout=None):
        calls.append(list(argv))
        if any("GetInstalledVoices" in str(a) for a in argv):
            return _Completed(SAPI_LISTING.encode("utf-8"))
        return _Completed(b"")

    monkeypatch.setattr(engines_mod, "_run_subprocess", _fake_run)
    monkeypatch.setattr(engines_mod.shutil, "which", lambda name: f"C:\\{name}.exe")

    system = EngineRegistry(piper_setup).system
    system._is_macos = False
    system._is_linux = False
    system._is_windows = True
    return system, calls


def test_sapi_voice_listing_is_tab_separated():
    # Voice names contain spaces, so only a TAB can separate name from culture.
    assert parse_sapi_voices(SAPI_LISTING)[0] == ("Microsoft David Desktop", "en-US")
    assert parse_sapi_voices("no separator here") == []


def test_sapi_rate_maps_speed_and_clamps():
    assert sapi_rate(1.0) == 0
    assert sapi_rate(1.5) == 5
    assert sapi_rate(0.5) == -5
    assert sapi_rate(99.0) == 10  # SAPI's scale stops at 10
    assert sapi_rate(0.0) == -10


def test_windows_system_engine_is_available_and_language_aware(windows_system):
    system, _calls = windows_system
    assert system.available() is True
    assert system.voice_for_language("en") == "Microsoft David Desktop"
    assert system.voice_for_language("zh") == "Microsoft Huihui Desktop"
    # Windows ships no Vietnamese voice: selection must move on rather than read
    # Vietnamese with an English voice.
    assert system.voice_for_language("vi") is None
    assert system.supports("en") is True
    assert system.supports("vi") is False
    assert "sapi" in system.voice_key("en", None)


def test_windows_system_engine_reports_unavailable_without_voices(windows_system, monkeypatch):
    system, _calls = windows_system
    system._sapi_voices = []  # speech assembly present, zero installed voices
    assert system.available() is False


def test_windows_synth_writes_a_utf8_script_that_selects_the_voice(
    windows_system, tmp_path, monkeypatch
):
    from app import engines as engines_mod

    system, _calls = windows_system
    system._sapi_voices = parse_sapi_voices(SAPI_LISTING)  # skip the listing call
    out = tmp_path / "segment_0001.wav"
    captured: dict[str, str] = {}

    class _Completed:
        stdout = b""
        stderr = b""
        returncode = 0

    def _spy(argv, *, input_bytes=None, timeout=None):
        # Read the generated files before the finally-block deletes them.
        captured["script"] = out.with_suffix(".ps1").read_text(encoding="utf-8-sig")
        captured["text"] = out.with_suffix(".txt").read_text(encoding="utf-8")
        captured["argv"] = argv
        return _Completed()

    monkeypatch.setattr(engines_mod, "_run_subprocess", _spy)
    system.synth("Xin chào", str(out), "en", None, 1.2)

    # Vietnamese diacritics must survive, so the text goes through a UTF-8 file
    # rather than the command line or the console code page.
    assert captured["text"] == "Xin chào"
    assert "SelectVoice('Microsoft David Desktop')" in captured["script"]
    assert "$synth.Rate = 2" in captured["script"]
    assert str(out) in captured["script"]
    assert "-NoProfile" in captured["argv"] and "-File" in captured["argv"]
    # Temp files are cleaned up.
    assert not out.with_suffix(".ps1").exists()
    assert not out.with_suffix(".txt").exists()


def test_windows_synth_refuses_a_language_with_no_voice(windows_system, tmp_path):
    system, _calls = windows_system
    with pytest.raises(RuntimeError, match="no SAPI voice"):
        system.synth("xin chào", str(tmp_path / "a.wav"), "vi", None, 1.0)


def test_sapi_listing_is_computed_once_and_published_atomically(
    windows_system, monkeypatch
):
    """The enumeration must never be observable as a half-filled empty list.

    /health and /voices both reach `_windows_voices` from FastAPI's threadpool,
    so they race for real. The first shape of this code assigned
    `self._sapi_voices = []` and only then ran PowerShell, so a concurrent probe
    could read the empty placeholder and report `system: false` for a machine
    that does have voices — enough to push a segment onto the silent fallback.
    """
    import threading

    from app import engines as engines_mod

    system, _calls = windows_system
    system._sapi_voices = None
    runs: list[list[str]] = []
    observed: list[list[tuple[str, str]]] = []
    gate = threading.Event()

    class _Completed:
        stdout = SAPI_LISTING.encode("utf-8")
        stderr = b""
        returncode = 0

    def _slow_listing(argv, *, input_bytes=None, timeout=None):
        runs.append(list(argv))
        gate.wait(5.0)  # hold the "subprocess" open while another thread looks
        return _Completed()

    monkeypatch.setattr(engines_mod, "_run_subprocess", _slow_listing)

    threads = [
        threading.Thread(target=lambda: observed.append(system._windows_voices()))
        for _ in range(2)
    ]
    for t in threads:
        t.start()
    gate.set()
    for t in threads:
        t.join(timeout=10)

    assert runs and len(runs) == 1, "the listing must run once, not once per caller"
    assert len(observed) == 2
    # Neither caller ever saw the transient empty placeholder.
    assert all(len(v) == 3 for v in observed), observed
