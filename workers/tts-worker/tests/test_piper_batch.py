"""Persistent Piper (app/piper_batch.py) + the voice-id fix in PiperEngine.

A fake batch binary (a tiny Python script speaking the same JSON-lines protocol
as scripts/package/entry_piper.py) stands in for vd-piper, so these run without
Piper, a voice model, or a GPU.
"""

from __future__ import annotations

import json
import os
import shlex
import stat
import sys
import textwrap
from pathlib import Path

import pytest

from app import piper_batch
from app.piper_batch import BatchUnavailable, PiperBatchPool, resolve_batch_command

FAKE = textwrap.dedent(
    r'''
    import json, os, sys
    if "--vd-batch-probe" in sys.argv:
        print("vd-batch/2"); sys.exit(0)
    log = os.environ.get("FAKE_LOG")
    print(json.dumps({"ready": True, "protocol": 2}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        if log:
            with open(log, "a") as f: f.write(json.dumps({"pid": os.getpid(), **req}) + "\n")
        if req["text"] == "boom":
            print(json.dumps({"ok": False, "error": "cannot speak boom"}), flush=True); continue
        if req["text"] == "die":
            sys.exit(3)
        with open(req["output_file"], "wb") as f: f.write(b"RIFF")
        print(json.dumps({"ok": True}), flush=True)
    '''
)


@pytest.fixture()
def fake_binary(tmp_path: Path) -> list[str]:
    script = tmp_path / "fake_piper.py"
    script.write_text(FAKE)
    return [sys.executable, str(script)]


def test_probe_recognises_a_batch_capable_binary(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("shell-script executables are POSIX-only")
    # A shell wrapper, not "#!<python>": a shebang ends at the first space, and
    # the interpreter's path can have one (a checkout under macOS's
    # "Application Support" failed here while the code under test was fine).
    script = tmp_path / "fake_piper.py"
    script.write_text(FAKE)
    exe = tmp_path / "vd-piper"
    exe.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n')
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    assert resolve_batch_command(str(exe)) == [str(exe), "--vd-batch"]


def test_batch_can_be_disabled(monkeypatch) -> None:
    monkeypatch.setenv("PIPER_BATCH", "0")
    assert resolve_batch_command("/anything") is None


def test_an_upstream_piper_without_batch_mode_falls_back(tmp_path: Path, monkeypatch) -> None:
    # No sibling python, not a batch binary -> None (per-line mode).
    monkeypatch.setattr(piper_batch, "_repo_entry_script", lambda: None)
    assert resolve_batch_command(str(tmp_path / "missing-piper")) is None


def test_one_process_serves_many_lines(fake_binary: list[str], tmp_path: Path, monkeypatch) -> None:
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_LOG", str(log))
    pool = PiperBatchPool([*fake_binary, "--vd-batch"])
    model = tmp_path / "vi_VN-x-medium.onnx"
    try:
        for i in range(5):
            pool.synth(model, f"line {i}", str(tmp_path / f"seg_{i}.wav"), 0.9 if i == 2 else None)
    finally:
        pool.close()
    entries = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(entries) == 5
    assert len({e["pid"] for e in entries}) == 1  # the model loaded ONCE
    assert entries[2]["length_scale"] == 0.9
    assert all((tmp_path / f"seg_{i}.wav").exists() for i in range(5))


def test_a_bad_line_fails_alone_and_the_process_keeps_serving(fake_binary: list[str], tmp_path: Path) -> None:
    pool = PiperBatchPool([*fake_binary, "--vd-batch"])
    model = tmp_path / "m.onnx"
    try:
        with pytest.raises(RuntimeError, match="cannot speak boom"):
            pool.synth(model, "boom", str(tmp_path / "a.wav"), None)
        pool.synth(model, "fine", str(tmp_path / "b.wav"), None)
        assert (tmp_path / "b.wav").exists()
    finally:
        pool.close()


def test_a_dead_process_is_restarted_once(fake_binary: list[str], tmp_path: Path) -> None:
    pool = PiperBatchPool([*fake_binary, "--vd-batch"])
    model = tmp_path / "m.onnx"
    try:
        pool.synth(model, "first", str(tmp_path / "1.wav"), None)
        # Killing it mid-request: the pool restarts and the NEXT line works.
        with pytest.raises(BatchUnavailable):
            pool.synth(model, "die", str(tmp_path / "2.wav"), None)
        pool.synth(model, "after", str(tmp_path / "3.wav"), None)
        assert (tmp_path / "3.wav").exists()
    finally:
        pool.close()


def test_engine_resolves_a_voice_id_to_its_model(tmp_path: Path) -> None:
    """Two vi voices installed: the requested ID must win (it used to be ignored)."""
    from app.config import Settings
    from app.engines import PiperEngine

    voices = tmp_path / "voices"
    voices.mkdir()
    for name in ("vi_VN-25hours_single-low", "vi_VN-vais1000-medium", "en_US-lessac-medium"):
        (voices / f"{name}.onnx").write_bytes(b"x")
    settings = Settings.__new__(Settings)
    object.__setattr__(settings, "piper_binary_path", "piper")
    object.__setattr__(settings, "piper_voice_model_path", None)
    object.__setattr__(settings, "piper_voices_dir", voices)
    engine = PiperEngine(settings)
    assert engine.model_for("vi", "vi_VN-vais1000-medium").name == "vi_VN-vais1000-medium.onnx"
    assert engine.model_for("vi", "vi_VN-25hours_single-low").name == "vi_VN-25hours_single-low.onnx"
    # A voice of the wrong language is never used for this language.
    assert engine.model_for("vi", "en_US-lessac-medium").name.startswith("vi_VN")
    # No ID: the first installed voice for the language, as before.
    assert engine.model_for("vi").name.startswith("vi_VN")


def test_probe_reads_the_protocol_version() -> None:
    assert piper_batch.probe_protocol("vd-batch/2\n") == 2
    assert piper_batch.probe_protocol("vd-batch/1") == 1
    assert piper_batch.probe_protocol("piper 1.3.0") == 0
    # The repo's own entry script speaks the current protocol.
    entry = Path(__file__).resolve().parents[3] / "scripts" / "package" / "entry_piper.py"
    assert f"BATCH_PROTOCOL = {piper_batch.PROTOCOL}" in entry.read_text(encoding="utf-8")


def test_a_speaker_rides_along_in_the_batch_request(fake_binary: list[str], tmp_path: Path, monkeypatch) -> None:
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_LOG", str(log))
    pool = PiperBatchPool([*fake_binary, "--vd-batch"])
    try:
        pool.synth(tmp_path / "en_GB-vctk-medium.onnx", "hello", str(tmp_path / "a.wav"), None, 12)
        pool.synth(tmp_path / "en_GB-vctk-medium.onnx", "again", str(tmp_path / "b.wav"), None)
    finally:
        pool.close()
    entries = [json.loads(line) for line in log.read_text().splitlines()]
    assert entries[0]["speaker_id"] == 12
    assert "speaker_id" not in entries[1]
    assert entries[0]["pid"] == entries[1]["pid"]  # one loaded model serves every speaker


def _engine(tmp_path: Path):
    from app.config import Settings
    from app.engines import PiperEngine

    voices = tmp_path / "voices"
    voices.mkdir(exist_ok=True)
    (voices / "vi_VN-vivos-x_low.onnx").write_bytes(b"x")
    settings = Settings.__new__(Settings)
    object.__setattr__(settings, "piper_binary_path", sys.executable)
    object.__setattr__(settings, "piper_voice_model_path", None)
    object.__setattr__(settings, "piper_voices_dir", voices)
    return PiperEngine(settings)


def test_a_speaker_id_resolves_to_its_model_and_its_own_cache_identity(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    assert engine.split_voice("vi_VN-vivos-x_low#7") == ("vi_VN-vivos-x_low", 7)
    assert engine.split_voice("vi_VN-vivos-x_low") == ("vi_VN-vivos-x_low", None)
    assert engine.split_voice("weird#name") == ("weird#name", None)
    assert engine.model_for("vi", "vi_VN-vivos-x_low#7").name == "vi_VN-vivos-x_low.onnx"
    # Two speakers of one model are two voices: never one cached clip.
    assert engine.voice_key("vi", "vi_VN-vivos-x_low#7") != engine.voice_key("vi", "vi_VN-vivos-x_low#8")
    assert engine.voice_key("vi", "vi_VN-vivos-x_low") == "piper:vi_VN-vivos-x_low.onnx"


def test_an_old_batch_piper_never_gets_a_speaker_request(tmp_path: Path, monkeypatch) -> None:
    """Protocol 1 would ignore speaker_id and read the line as speaker 0."""
    from app import engines as engines_mod

    engine = _engine(tmp_path)
    calls: list[str] = []

    class Pool:
        def synth(self, *args):
            calls.append("pool")

    engine._batch_pool, engine._batch_protocol, engine._batch_resolved = Pool(), 1, True
    argvs: list[list[str]] = []
    monkeypatch.setattr(engines_mod, "_run_subprocess", lambda argv, input_bytes=None: argvs.append(argv))
    engine.synth("xin chào", str(tmp_path / "a.wav"), "vi", "vi_VN-vivos-x_low#3", 1.0)
    assert calls == []
    assert argvs[0][-2:] == ["--speaker", "3"]
    engine.synth("xin chào", str(tmp_path / "b.wav"), "vi", "vi_VN-vivos-x_low", 1.0)
    assert calls == ["pool"]  # no speaker: the fast path as before

    engine._batch_protocol = 2
    engine.synth("xin chào", str(tmp_path / "c.wav"), "vi", "vi_VN-vivos-x_low#3", 1.0)
    assert calls == ["pool", "pool"]


def test_cpu_helper_is_identical_to_the_stt_workers() -> None:
    """The two workers are frozen separately and cannot share a module; keep the twins equal."""
    here = Path(__file__).resolve().parents[1] / "app" / "cpu.py"
    twin = Path(__file__).resolve().parents[2] / "stt-worker" / "app" / "cpu.py"
    assert here.read_text() == twin.read_text()
