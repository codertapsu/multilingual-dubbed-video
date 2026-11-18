"""The diarization engine without sherpa-onnx: audio reading, turn shaping, the HTTP contract."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from vd_diarize import app as app_mod
from vd_diarize.core import Diarizer, read_wav_16k_mono, shape_turns


def write_wav(path: Path, samples: np.ndarray, rate: int = 16_000, channels: int = 1) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((samples * 32767).astype("<i2").tobytes())


def test_reads_the_pipelines_16k_mono_audio(tmp_path: Path) -> None:
    f = tmp_path / "a.wav"
    write_wav(f, np.array([0.0, 0.5, -0.5], dtype=np.float32))
    out = read_wav_16k_mono(str(f))
    assert out.dtype == np.float32
    assert np.allclose(out, [0.0, 0.5, -0.5], atol=1e-3)
    other = tmp_path / "b.wav"
    write_wav(other, np.zeros(10, dtype=np.float32), rate=48_000)
    with pytest.raises(ValueError, match="16 kHz mono"):
        read_wav_16k_mono(str(other))


def test_turns_are_sorted_in_ms_with_speakers_numbered_by_first_appearance() -> None:
    raw = [(5.0, 6.0, 7), (0.5, 2.0, 3), (2.1, 4.0, 7), (6.0, 6.1, 3)]
    turns = shape_turns(raw, min_ms=200)
    # 6.0-6.1 s is shorter than 200 ms: dropped.
    assert [(t.start_ms, t.end_ms, t.speaker) for t in turns] == [(500, 2000, 0), (2100, 4000, 1), (5000, 6000, 1)]


class FakeResult:
    def __init__(self, start: float, end: float, speaker: int) -> None:
        self.start, self.end, self.speaker = start, end, speaker


class FakeDiarization:
    def __init__(self, threshold: float, num_speakers: int) -> None:
        self.threshold, self.num_speakers = threshold, num_speakers

    def process(self, samples: np.ndarray):  # noqa: ANN201 - mimics sherpa's result object
        n = len(samples) / 16_000
        results = [FakeResult(0.0, n / 2, 4), FakeResult(n / 2, n, 9)]

        class R(list):
            def sort_by_start_time(self):  # noqa: ANN202
                return self

        return R(results)


def test_http_contract(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[tuple[float, int]] = []

    def factory(threshold: float, num_speakers: int) -> FakeDiarization:
        built.append((threshold, num_speakers))
        return FakeDiarization(threshold, num_speakers)

    monkeypatch.setattr(app_mod, "_diarizer", Diarizer(2, factory=factory))
    client = TestClient(app_mod.app)
    f = tmp_path / "audio.wav"
    write_wav(f, np.zeros(16_000 * 4, dtype=np.float32))

    res = client.post("/diarize", json={"audioPath": str(f), "threshold": 0.7})
    assert res.status_code == 200
    body = res.json()
    assert body["turns"] == [
        {"startMs": 0, "endMs": 2000, "speaker": 0},
        {"startMs": 2000, "endMs": 4000, "speaker": 1},
    ]
    assert body["speakers"] == 2
    # The same settings reuse the loaded diarizer; new ones replace it.
    client.post("/diarize", json={"audioPath": str(f), "threshold": 0.7})
    client.post("/diarize", json={"audioPath": str(f), "numSpeakers": 3})
    assert built == [(0.7, -1), (app_mod.DEFAULT_THRESHOLD, 3)]

    assert client.post("/diarize", json={"audioPath": str(tmp_path / "missing.wav")}).status_code == 400
    assert client.post("/diarize", json={"audioPath": str(f), "threshold": -1}).status_code == 422
    health = client.get("/health").json()
    assert health["ok"] is True and set(health["models"]) == {"segmentation", "embedding"}
