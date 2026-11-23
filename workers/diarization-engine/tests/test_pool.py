"""The model pool without sherpa-onnx: how many pairs, how they are lent, and requests side by side."""

from __future__ import annotations

import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from vd_diarize import app as app_mod
from vd_diarize.core import Diarizer, Embedder
from vd_diarize.pool import ModelPool, parse_vm_stat, plan_pool

from test_chunks import FakeExtractor, tone

SR = 16_000


# ---- how many pairs -----------------------------------------------------------


def test_one_pair_per_four_threads_split_between_them() -> None:
    # The 16-thread i5-13400F of the 27.8-hour series (6 performance cores):
    # four pairs of three threads, where one pair of six kept ~3.6 busy.
    assert plan_pool(16, 6, 12_000) == (4, 3)
    # Eight threads: two pairs. Twelve: three. Never more than four.
    assert plan_pool(8, 4, 12_000) == (2, 3)
    assert plan_pool(12, 6, 12_000) == (3, 3)
    assert plan_pool(64, 16, 64_000) == (4, 15)
    # A small machine keeps one pair, on the threads it always had.
    assert plan_pool(4, 4, 12_000) == (1, 4)
    assert plan_pool(6, 4, 12_000) == (1, 4)


def test_free_memory_caps_the_pairs() -> None:
    # 1.5 GB stays free for the rest of the machine; each pair needs ~200 MB.
    assert plan_pool(16, 6, 1_536 + 2 * 200) == (2, 6)
    assert plan_pool(16, 6, 1_700) == (1, 6)
    assert plan_pool(16, 6, 900) == (1, 6)
    # Unknown free memory: room for two at most.
    assert plan_pool(16, 6, None) == (2, 6)


def test_the_pair_count_can_be_forced() -> None:
    assert plan_pool(16, 6, 900, override=3) == (3, 4)
    assert plan_pool(4, 4, 12_000, override=1) == (1, 4)
    assert plan_pool(16, 6, 12_000, override=9) == (4, 3)
    assert plan_pool(16, 6, 12_000, override=0) == (4, 3)


def test_reads_free_memory_from_vm_stat() -> None:
    sample = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free:                               10000.\n"
        "Pages active:                            200000.\n"
        "Pages inactive:                           54000.\n"
        "Pages speculative:                         0.\n"
    )
    assert parse_vm_stat(sample) == (10000 + 54000) * 16384 // (1024 * 1024)
    assert parse_vm_stat("nothing useful") is None


# ---- lending pairs ------------------------------------------------------------


def test_pairs_are_made_on_first_use_and_the_warm_one_goes_first() -> None:
    made: list[int] = []

    def make(threads: int) -> tuple[str, str]:
        made.append(threads)
        return (f"d{len(made)}", f"e{len(made)}")

    pool: ModelPool[str, str] = ModelPool(3, 2, make)
    assert pool.loaded == 0
    for _ in range(5):
        with pool.borrow() as pair:
            assert pair == ("d1", "e1")
    # One request at a time loads one pair, as the engine always did.
    assert made == [2] and pool.loaded == 1 and pool.peak == 1


def test_lends_up_to_its_size_at_once_and_makes_the_rest_wait() -> None:
    pool: ModelPool[int, int] = ModelPool(2, 1, lambda _t: (0, 0))
    inside = threading.Barrier(2, timeout=10)
    release = threading.Event()
    entered: list[int] = []

    def work(n: int) -> None:
        with pool.borrow():
            entered.append(n)
            if n < 2:
                inside.wait()  # both of the first two are in at once
                release.wait(10)

    with ThreadPoolExecutor(max_workers=3) as ex:
        first = [ex.submit(work, n) for n in range(2)]
        while len(entered) < 2:
            threading.Event().wait(0.01)
        third = ex.submit(work, 2)
        threading.Event().wait(0.2)
        # The third waits for a free pair...
        assert entered == [0, 1] or entered == [1, 0]
        release.set()
        for f in [*first, third]:
            f.result(timeout=10)
    # ...and gets one once the others are done.
    assert sorted(entered) == [0, 1, 2]
    assert pool.peak == 2 and pool.busy == 0


def test_a_failed_request_gives_its_pair_back() -> None:
    pool: ModelPool[int, int] = ModelPool(1, 1, lambda _t: (0, 0))
    with pytest.raises(RuntimeError):
        with pool.borrow():
            raise RuntimeError("model crashed")
    with pool.borrow() as pair:
        assert pair == (0, 0)
    assert pool.busy == 0


def test_a_pair_that_cannot_load_gives_its_slot_back() -> None:
    attempts: list[int] = []

    def make(_threads: int) -> tuple[int, int]:
        attempts.append(1)
        if len(attempts) == 1:
            raise FileNotFoundError("model missing")
        return (1, 1)

    pool: ModelPool[int, int] = ModelPool(1, 1, make)
    with pytest.raises(FileNotFoundError):
        with pool.borrow():
            pass
    with pool.borrow() as pair:
        assert pair == (1, 1)


# ---- requests side by side ----------------------------------------------------


class _Result:
    def __init__(self, start: float, end: float, speaker: int) -> None:
        self.start, self.end, self.speaker = start, end, speaker


class MeetingDiarization:
    """Answers only once a second request is inside too: two parts must run side by side."""

    meeting = threading.Barrier(2, timeout=10)

    def __init__(self, threshold: float, num_speakers: int) -> None:
        self.threshold, self.num_speakers = threshold, num_speakers

    def process(self, samples: np.ndarray):  # noqa: ANN201 - mimics sherpa's result object
        MeetingDiarization.meeting.wait()
        n = len(samples) / SR

        class R(list):
            def sort_by_start_time(self):  # noqa: ANN202
                return self

        return R([_Result(0.0, n, 0)])


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def test_two_parts_of_a_long_detection_run_at_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    MeetingDiarization.meeting = threading.Barrier(2, timeout=10)
    pool: ModelPool[Diarizer, Embedder] = ModelPool(
        2,
        2,
        lambda threads: (
            Diarizer(threads, factory=lambda threshold, num_speakers: MeetingDiarization(threshold, num_speakers)),
            Embedder(threads, factory=FakeExtractor),
        ),
    )
    monkeypatch.setattr(app_mod, "_pool", pool)
    f = tmp_path / "audio.wav"
    write_wav(f, np.concatenate([tone(120, 4.0), tone(220, 4.0)]))
    client = TestClient(app_mod.app)

    def part(start: int) -> int:
        return client.post("/diarize-chunk", json={"audioPath": str(f), "startMs": start, "endMs": start + 4_000}).status_code

    with ThreadPoolExecutor(max_workers=2) as ex:
        codes = list(ex.map(part, [0, 4_000]))
    # With one lock (or one pair) the first would wait at the barrier alone and fail.
    assert codes == [200, 200]
    assert pool.peak == 2 and pool.loaded == 2
    assert client.get("/health").json()["pool"] == 2
