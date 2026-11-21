"""POST /embed and what it reads: any PCM WAV (a cloned voice's preview), its speech, its print."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from vd_diarize import app as app_mod
from vd_diarize.core import AudioTooLong, Embedder, read_audio_window
from vd_diarize.prints import speech_runs, yin_f0

from test_chunks import FakeExtractor, tone


def write_pcm(path: Path, samples: np.ndarray, rate: int, channels: int = 1, width: int = 2) -> None:
    """`samples` in [-1, 1], shape (n,) or (n, channels)."""
    x = np.clip(samples, -1, 1)
    if width == 1:
        data = np.round(x * 127 + 128).astype(np.uint8).tobytes()
    elif width == 2:
        data = np.round(x * 32767).astype("<i2").tobytes()
    elif width == 3:
        v = np.round(x * 8_388_607).astype(np.int32).reshape(-1)
        data = np.stack([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF], axis=1).astype(np.uint8).tobytes()
    else:
        raise AssertionError(width)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(data)


def tone_at(hz: float, seconds: float, rate: int) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return 0.4 * np.sin(2 * np.pi * hz * t) + 0.2 * np.sin(4 * np.pi * hz * t) + 0.1 * np.sin(6 * np.pi * hz * t)


def test_reads_any_pcm_wav_as_16k_mono(tmp_path: Path) -> None:
    # A TTS preview: 24 kHz stereo.
    f = tmp_path / "preview.wav"
    left = tone_at(120, 2.0, 24_000)
    write_pcm(f, np.stack([left, left], axis=1), 24_000, channels=2)
    out = read_audio_window(str(f))
    assert out.dtype == np.float32 and out.size == 32_000
    assert np.median(yin_f0(out)) == pytest.approx(120, rel=0.03)
    # A window of it, on the file's own clock.
    assert read_audio_window(str(f), 500, 1500).size == 16_000
    assert read_audio_window(str(f), 1500).size == 8_000

    ramp = np.linspace(-0.9, 0.9, 1000)
    for width in (1, 3):
        g = tmp_path / f"w{width}.wav"
        write_pcm(g, ramp, 16_000, width=width)
        assert np.allclose(read_audio_window(str(g)), ramp, atol=0.02 if width == 1 else 1e-5)


def test_refuses_what_it_cannot_read(tmp_path: Path) -> None:
    f = tmp_path / "long.wav"
    write_pcm(f, np.zeros(16_000 * 3), 16_000)
    with pytest.raises(AudioTooLong):
        read_audio_window(str(f), max_ms=2_000)
    assert read_audio_window(str(f), 0, 1_000, max_ms=2_000).size == 16_000
    floats = tmp_path / "float.wav"
    with open(floats, "wb") as out:  # WAVE_FORMAT_IEEE_FLOAT, which `wave` does not read
        out.write(b"RIFF" + (36 + 8).to_bytes(4, "little") + b"WAVE")
        out.write(b"fmt " + (16).to_bytes(4, "little") + (3).to_bytes(2, "little") + (1).to_bytes(2, "little"))
        out.write((16_000).to_bytes(4, "little") + (64_000).to_bytes(4, "little") + (4).to_bytes(2, "little") + (32).to_bytes(2, "little"))
        out.write(b"data" + (8).to_bytes(4, "little") + b"\x00" * 8)
    with pytest.raises(wave.Error):
        read_audio_window(str(floats))


def test_speech_is_where_the_recording_is_loud() -> None:
    sr = 16_000
    audio = np.concatenate(
        [np.zeros(sr), tone(220, 2.0), np.zeros(sr // 5), tone(220, 1.0), np.zeros(sr), tone(220, 0.1), np.zeros(sr)]
    )
    runs = speech_runs(audio)
    # The 200 ms pause is inside a run; the 100 ms blip is too short to count.
    assert runs == [(1000, 4200)]
    assert speech_runs(np.zeros(sr)) == []
    assert speech_runs(np.zeros(10)) == []


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(app_mod, "_embedder", Embedder(2, factory=FakeExtractor))
    return TestClient(app_mod.app)


def test_embed_contract(tmp_path: Path, client: TestClient) -> None:
    f = tmp_path / "preview.wav"
    clip = np.concatenate([np.zeros(24_000), tone_at(220, 3.0, 24_000), np.zeros(12_000)])
    write_pcm(f, np.stack([clip, clip], axis=1), 24_000, channels=2)

    body = client.post("/embed", json={"audioPath": str(f)}).json()
    assert set(body) == {"print", "f0Hz", "lowShare", "speechSec"}
    assert np.linalg.norm(body["print"]) == pytest.approx(1.0, abs=1e-5)
    assert body["f0Hz"] == pytest.approx(220, rel=0.03) and body["lowShare"] == 0.0
    assert body["speechSec"] == pytest.approx(3.0, abs=0.05)
    # A window of the silence: no speech, no print.
    quiet = client.post("/embed", json={"audioPath": str(f), "startMs": 0, "endMs": 900}).json()
    assert quiet == {"print": [], "f0Hz": None, "lowShare": None, "speechSec": 0.0}

    assert client.post("/embed", json={"audioPath": str(tmp_path / "x.wav")}).status_code == 400
    assert client.post("/embed", json={"audioPath": str(f), "startMs": 900, "endMs": 900}).status_code == 400
    not_wav = tmp_path / "x.mp3"
    not_wav.write_bytes(b"ID3\x00\x00")
    assert client.post("/embed", json={"audioPath": str(not_wav)}).status_code == 400


def test_embed_refuses_a_whole_long_file(tmp_path: Path, client: TestClient) -> None:
    f = tmp_path / "long.wav"
    frames = 11 * 60 * 24_000  # a header announcing 11 minutes at 24 kHz
    with open(f, "wb") as out:
        out.write(b"RIFF" + (36 + 2 * frames).to_bytes(4, "little") + b"WAVE")
        out.write(b"fmt " + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little"))
        out.write((24_000).to_bytes(4, "little") + (48_000).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little"))
        out.write(b"data" + (2 * frames).to_bytes(4, "little") + b"\x00\x00" * 10)
    res = client.post("/embed", json={"audioPath": str(f)})
    assert res.status_code == 413 and "window" in res.json()["detail"]
