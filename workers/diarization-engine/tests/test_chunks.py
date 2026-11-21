"""Chunked detection without sherpa-onnx: window reading, voice prints, pitch, POST /diarize-chunk."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from vd_diarize import app as app_mod
from vd_diarize.core import Diarizer, Embedder, Turn, read_wav_window, wav_duration_ms
from vd_diarize.prints import pitch_stats, print_pieces, speaker_profiles, subtract, voice_print, yin_f0

SR = 16_000


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def tone(hz: float, seconds: float) -> np.ndarray:
    """A voiced-like tone: a fundamental with two harmonics (YIN needs a period, not a pure sine)."""
    t = np.arange(int(seconds * SR)) / SR
    return (0.4 * np.sin(2 * np.pi * hz * t) + 0.2 * np.sin(4 * np.pi * hz * t) + 0.1 * np.sin(6 * np.pi * hz * t)).astype(np.float32)


# ---- window reading ---------------------------------------------------------


def test_reads_only_the_window_it_is_asked_for(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    f = tmp_path / "long.wav"
    ramp = (np.arange(SR * 5) % 1000) / 2000.0  # 5 s, a known value at every sample
    write_wav(f, ramp)
    asked: list[int] = []
    real = wave.Wave_read.readframes

    def spy(self: wave.Wave_read, n: int) -> bytes:
        asked.append(n)
        return real(self, n)

    monkeypatch.setattr(wave.Wave_read, "readframes", spy)
    out = read_wav_window(str(f), 1000, 1500)
    # Only the half second of the window came off the disk, not the file.
    assert asked == [SR // 2]
    expected = (np.arange(SR, SR + SR // 2) % 1000) / 2000.0
    assert np.allclose(out, expected, atol=1e-4)
    # A window over the end is cut there; one past it is empty.
    assert read_wav_window(str(f), 4500, 9000).size == SR // 2
    assert read_wav_window(str(f), 6000, 7000).size == 0
    assert wav_duration_ms(str(f)) == 5000


def test_window_reading_refuses_other_formats(tmp_path: Path) -> None:
    f = tmp_path / "stereo.wav"
    with wave.open(str(f), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"\x00\x00" * 200)
    with pytest.raises(ValueError, match="16 kHz mono"):
        read_wav_window(str(f), 0, 10)


# ---- pieces and prints ------------------------------------------------------


def test_clean_pieces_leave_out_every_other_speaker() -> None:
    assert subtract((0, 10_000), [(2_000, 3_000), (9_000, 12_000), (20_000, 21_000)]) == [(0, 2_000), (3_000, 9_000)]
    assert subtract((0, 1_000), [(0, 1_000)]) == []


def test_print_pieces_are_the_longest_clean_middles_within_the_caps() -> None:
    mine = [(0, 20_000), (30_000, 33_000), (40_000, 40_600), (50_000, 52_000)]
    others = [(31_000, 32_000)]  # cuts (30_000, 33_000) into two 1 s pieces
    pieces = print_pieces(mine, others, max_pieces=3, max_piece_ms=8_000, max_total_ms=45_000)
    # The 20 s turn gives its middle 8 s; then the 2 s turn; then a 1 s clean piece.
    assert pieces == [(6_000, 14_000), (50_000, 52_000), (30_000, 31_000)]
    # The total cap trims the last piece.
    assert print_pieces(mine, others, max_pieces=8, max_piece_ms=8_000, max_total_ms=9_000) == [(6_000, 14_000), (50_500, 51_500)]
    # Nothing clean and long enough: the speaker's own turns, then the longest one.
    assert print_pieces([(0, 500)], [(0, 500)], 8, 8_000, 45_000) == [(0, 500)]
    assert print_pieces([(0, 300), (1_000, 1_200)], [], 8, 8_000, 45_000) == [(0, 300)]


def test_a_voice_print_is_the_duration_weighted_mean_of_normalised_embeddings() -> None:
    audio = np.zeros(SR * 4, dtype=np.float32)
    audio[:SR] = 0.1  # piece 1 (1 s) embeds as x, piece 2 (3 s) as y
    seen: list[int] = []

    def embed(clip: np.ndarray) -> np.ndarray:
        seen.append(clip.size)
        return np.array([1.0, 0.0]) if clip[0] > 0 else np.array([0.0, 2.0])

    vec, sec = voice_print(audio, [(0, 1_000), (1_000, 4_000)], embed)
    assert seen == [SR, 3 * SR]
    assert sec == pytest.approx(4.0)
    assert vec == pytest.approx(np.array([1.0, 3.0]) / np.sqrt(10.0))
    assert voice_print(audio, [(0, 1_000)], lambda clip: None) == (None, 0.0)


def test_pitch_finds_the_fundamental_and_how_much_of_it_is_low() -> None:
    assert np.median(yin_f0(tone(120, 1.0))) == pytest.approx(120, rel=0.03)
    assert np.median(yin_f0(tone(220, 1.0))) == pytest.approx(220, rel=0.03)
    assert yin_f0(np.zeros(SR)).size == 0  # silence is not voiced
    audio = np.concatenate([tone(120, 2.0), tone(220, 2.0)])
    f0, low = pitch_stats(audio, [(0, 2_000)])
    assert f0 == pytest.approx(120, rel=0.03) and low == 1.0
    f0, low = pitch_stats(audio, [(2_000, 4_000)])
    assert f0 == pytest.approx(220, rel=0.03) and low == 0.0
    assert pitch_stats(np.zeros(SR, dtype=np.float32), [(0, 1_000)]) == (None, None)


# ---- the embedding extractor ------------------------------------------------


class FakeStream:
    def __init__(self) -> None:
        self.samples = np.zeros(0, dtype=np.float32)
        self.finished = False

    def accept_waveform(self, rate: int, samples: np.ndarray) -> None:
        assert rate == SR
        self.samples = np.concatenate([self.samples, samples])

    def input_finished(self) -> None:
        self.finished = True


class FakeExtractor:
    """sherpa_onnx.SpeakerEmbeddingExtractor's surface: an embedding from the clip's loudness."""

    def __init__(self) -> None:
        self.computed = 0

    def create_stream(self) -> FakeStream:
        return FakeStream()

    def is_ready(self, stream: FakeStream) -> bool:
        return stream.finished and stream.samples.size >= SR // 10

    def compute(self, stream: FakeStream) -> list[float]:
        self.computed += 1
        return [3.0, 4.0 * float(np.abs(stream.samples).mean() > 0.2)]


def test_the_embedder_loads_once_and_normalises() -> None:
    built: list[FakeExtractor] = []

    def factory() -> FakeExtractor:
        built.append(FakeExtractor())
        return built[-1]

    emb = Embedder(2, factory=factory)
    assert emb.embed(np.zeros(SR, dtype=np.float32)) == pytest.approx([1.0, 0.0])
    assert emb.embed(np.full(SR, 0.5, dtype=np.float32)) == pytest.approx([0.6, 0.8])
    assert emb.embed(np.zeros(100, dtype=np.float32)) is None  # too short to embed
    assert len(built) == 1 and built[0].computed == 2


def test_profiles_per_local_speaker() -> None:
    audio = np.concatenate([tone(120, 3.0), tone(220, 3.0)])
    turns = [Turn(0, 3_000, 0), Turn(3_000, 6_000, 1), Turn(5_500, 5_900, 2)]
    emb = Embedder(1, factory=FakeExtractor)
    profiles = speaker_profiles(audio, turns, emb.embed)
    assert [p.local for p in profiles] == [0, 1, 2]
    low, high, tiny = profiles
    assert low.sec == 3.0 and low.print_sec == pytest.approx(3.0) and low.f0_hz == pytest.approx(120, rel=0.03)
    # Speaker 1's clean pieces leave out speaker 2's turn inside it.
    assert high.print_sec == pytest.approx(2.5) and high.f0_hz == pytest.approx(220, rel=0.03)
    assert tiny.sec == pytest.approx(0.4) and tiny.print is not None


# ---- POST /diarize-chunk ----------------------------------------------------


class FakeResult:
    def __init__(self, start: float, end: float, speaker: int) -> None:
        self.start, self.end, self.speaker = start, end, speaker


class WindowDiarization:
    """Splits whatever it is given in two speakers, and records how much audio that was."""

    seen: list[int] = []

    def __init__(self, threshold: float, num_speakers: int) -> None:
        self.threshold, self.num_speakers = threshold, num_speakers

    def process(self, samples: np.ndarray):  # noqa: ANN201 - mimics sherpa's result object
        WindowDiarization.seen.append(len(samples))
        n = len(samples) / SR

        class R(list):
            def sort_by_start_time(self):  # noqa: ANN202
                return self

        return R([FakeResult(0.0, n / 2, 7), FakeResult(n / 2, n, 3)])


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    WindowDiarization.seen = []
    monkeypatch.setattr(app_mod, "_diarizer", Diarizer(2, factory=lambda threshold, num_speakers: WindowDiarization(threshold, num_speakers)))
    monkeypatch.setattr(app_mod, "_embedder", Embedder(2, factory=FakeExtractor))
    return TestClient(app_mod.app)


def test_chunk_contract(tmp_path: Path, client: TestClient) -> None:
    f = tmp_path / "audio.wav"
    write_wav(f, np.concatenate([tone(120, 4.0), tone(220, 4.0)]))

    res = client.post("/diarize-chunk", json={"audioPath": str(f), "startMs": 2_000, "endMs": 6_000})
    assert res.status_code == 200
    body = res.json()
    # The diarizer saw exactly the window; the turns come back on the file's clock.
    assert WindowDiarization.seen == [4 * SR]
    assert body["turns"] == [
        {"startMs": 2_000, "endMs": 4_000, "speaker": 0},
        {"startMs": 4_000, "endMs": 6_000, "speaker": 1},
    ]
    first, second = body["speakers"]
    assert first["local"] == 0 and first["sec"] == 2.0 and first["printSec"] == 2.0
    assert first["f0Hz"] == pytest.approx(120, rel=0.03) and first["lowShare"] == 1.0
    assert second["f0Hz"] == pytest.approx(220, rel=0.03) and second["lowShare"] == 0.0
    assert len(first["print"]) == 2 and np.linalg.norm(first["print"]) == pytest.approx(1.0, abs=1e-5)

    # The print caps go through: one piece of at most a second.
    capped = client.post(
        "/diarize-chunk",
        json={"audioPath": str(f), "startMs": 2_000, "endMs": 6_000, "maxPrintPieces": 1, "maxPieceSec": 1, "maxPrintSec": 45},
    ).json()
    assert [s["printSec"] for s in capped["speakers"]] == [1.0, 1.0]

    # Past the end of the file: nothing to detect, and no error.
    assert client.post("/diarize-chunk", json={"audioPath": str(f), "startMs": 60_000, "endMs": 70_000}).json() == {
        "turns": [],
        "speakers": [],
        "processMs": 0,
    }
    assert client.post("/diarize-chunk", json={"audioPath": str(f), "startMs": 3_000, "endMs": 3_000}).status_code == 400
    assert client.post("/diarize-chunk", json={"audioPath": str(tmp_path / "x.wav"), "startMs": 0, "endMs": 10}).status_code == 400
    assert client.post("/diarize-chunk", json={"audioPath": str(f), "startMs": -5, "endMs": 10}).status_code == 422


def test_one_pass_can_also_describe_each_speaker(tmp_path: Path, client: TestClient) -> None:
    f = tmp_path / "short.wav"
    write_wav(f, np.concatenate([tone(120, 3.0), tone(220, 3.0)]))
    body = client.post("/diarize", json={"audioPath": str(f), "withSpeakers": True}).json()
    assert body["speakers"] == 2
    info = body["speakerInfo"]
    assert [s["speaker"] for s in info] == [0, 1]
    assert info[0]["f0Hz"] == pytest.approx(120, rel=0.03)
    # Too little of anyone for a seed: pitch alone, with a low confidence.
    assert [(s["gender"], s["genderConfidence"]) for s in info] == [("male", 0.3), ("female", 0.3)]
    # Without the flag the answer is what it always was.
    assert "speakerInfo" not in client.post("/diarize", json={"audioPath": str(f)}).json()


def test_one_pass_refuses_audio_it_could_not_finish(tmp_path: Path, client: TestClient) -> None:
    # A header announcing 61 minutes: the size is all /diarize looks at first.
    f = tmp_path / "long.wav"
    frames = 61 * 60 * SR
    with open(f, "wb") as out:
        out.write(b"RIFF" + (36 + 2 * frames).to_bytes(4, "little") + b"WAVE")
        out.write(b"fmt " + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little"))
        out.write(SR.to_bytes(4, "little") + (2 * SR).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little"))
        out.write(b"data" + (2 * frames).to_bytes(4, "little") + b"\x00\x00" * 10)
    res = client.post("/diarize", json={"audioPath": str(f)})
    assert res.status_code == 413
    assert "chunks" in res.json()["detail"]
    assert WindowDiarization.seen == []
