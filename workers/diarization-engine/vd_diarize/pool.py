"""Several loaded model pairs, so speaker detection can run parts side by side.

A pair is one sherpa-onnx diarizer (pyannote segmentation and the embedding
model) and one embedding extractor for the voice prints: about 150 MB once
loaded. Until 0.18 the engine had ONE pair behind one lock, so every request
waited for the one before it: the 27.8-hour series' detection ran its
10-minute parts strictly one after another, 4 h 56 min with about 3.6 of 16
threads busy (claude-dubber report, 2026-11-23, F6). Now the engine keeps up
to four pairs, with the thread budget split between them; a request borrows a
free pair for as long as it runs. GET /health says how many there are
(`pool`), and the orchestrator sends that many parts at once when no heavy
step runs on the machine, one otherwise.

Side by side, not just in turn, because sherpa-onnx releases the GIL inside
its own calls (process, compute): the Python around them is short.

Pairs are made on first use and the free one used last goes first, so a
machine that only ever detects one part at a time loads one pair, as before.
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import sys
import threading
from contextlib import contextmanager
from typing import Callable, Generic, Iterator, NamedTuple, Optional, TypeVar

# One pair's models (~150 MB) and a 10-minute part's samples and buffers.
PAIR_MB = 200
# Left free for everything else on the machine: the app, a dub, the browser.
RESERVE_MB = 1536
MAX_PAIRS = 4
# Logical threads per pair a machine needs before a second pair is worth it.
THREADS_PER_PAIR_MIN_LOGICAL = 4


class PoolPlan(NamedTuple):
    """How many pairs, and how many threads each one runs."""

    pairs: int
    threads: int


def plan_pool(logical_cpus: int, thread_hint: int, free_mb: Optional[int], override: Optional[int] = None) -> PoolPlan:
    """How many model pairs to keep and the threads of each. Pure.

    `thread_hint` is what one pair ran on before (the performance cores the
    orchestrator passes as VD_DIARIZE_THREADS: ONNX Runtime's own default
    thread count is never trusted). One pair keeps exactly that. Several pairs
    split the machine's logical threads, two left over for the rest, at least
    2 and at most the hint each: on a 16-thread i5-13400F (6 performance
    cores) that is 4 pairs of 3 threads, 12 busy where one pair kept ~3.6.

    Pairs: one per 4 logical threads and per 200 MB of free memory beyond
    1.5 GB, 1 to 4. Unknown free memory counts as room for two.
    `override` (VD_DIARIZE_POOL) sets the number of pairs outright.
    """
    logical = max(1, int(logical_cpus))
    hint = max(1, int(thread_hint))
    if override is not None and override >= 1:
        pairs = min(MAX_PAIRS, int(override))
    else:
        by_cores = logical // THREADS_PER_PAIR_MIN_LOGICAL
        by_ram = 2 if free_mb is None else (int(free_mb) - RESERVE_MB) // PAIR_MB
        pairs = max(1, min(MAX_PAIRS, by_cores, by_ram))
    if pairs == 1:
        return PoolPlan(1, hint)
    return PoolPlan(pairs, max(2, min(hint, (logical - 2) // pairs)))


def _windows_available_mb() -> Optional[int]:
    import ctypes

    class MemoryStatusEx(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatusEx()
    status.dwLength = ctypes.sizeof(MemoryStatusEx)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
        return None
    return int(status.ullAvailPhys // (1024 * 1024))


def parse_vm_stat(text: str) -> Optional[int]:
    """Free, inactive and speculative pages of macOS `vm_stat`, in MB. Pure."""
    size = re.search(r"page size of (\d+) bytes", text)
    if not size:
        return None
    pages = 0
    found = False
    for label in ("Pages free", "Pages inactive", "Pages speculative"):
        m = re.search(rf"^{label}:\s+(\d+)", text, re.MULTILINE)
        if m:
            pages += int(m.group(1))
            found = True
    return pages * int(size.group(1)) // (1024 * 1024) if found else None


def free_memory_mb() -> Optional[int]:
    """Memory the system can hand out without swapping, in MB; None when it cannot tell.

    Read once, when the engine starts (no psutil in the pack's venv).
    """
    try:
        if sys.platform == "win32":
            return _windows_available_mb()
        if os.path.exists("/proc/meminfo"):
            with open("/proc/meminfo", encoding="ascii", errors="replace") as f:
                for line in f:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) // 1024
            return None
        if sys.platform == "darwin":
            out = subprocess.run(["/usr/bin/vm_stat"], capture_output=True, text=True, timeout=5, check=False).stdout
            return parse_vm_stat(out)
    except Exception:  # noqa: BLE001 - a guess at memory must never stop the engine
        return None
    return None


def _env_int(name: str) -> Optional[int]:
    try:
        value = int(os.environ.get(name, "0"))
    except ValueError:
        return None
    return value if value > 0 else None


def plan_from_environment() -> PoolPlan:
    """The pool for this machine: VD_DIARIZE_THREADS (the orchestrator's
    performance cores) as the hint, VD_DIARIZE_POOL to force the pair count."""
    logical = os.cpu_count() or 4
    hint = _env_int("VD_DIARIZE_THREADS") or min(8, logical)
    return plan_pool(logical, hint, free_memory_mb(), _env_int("VD_DIARIZE_POOL"))


D = TypeVar("D")
E = TypeVar("E")


class ModelPool(Generic[D, E]):
    """`size` (diarizer, embedder) pairs; a request borrows a free pair for as long as it runs.

    `make_pair(threads)` builds one pair; the models inside load on their first
    use (Diarizer and Embedder build lazily), so a pair nobody borrows costs
    nothing. Borrowing blocks while every pair is busy.
    """

    def __init__(self, size: int, threads: int, make_pair: Callable[[int], tuple[D, E]]) -> None:
        self.size = max(1, int(size))
        self.threads = max(1, int(threads))
        self._make_pair = make_pair
        self._pairs: list[Optional[tuple[D, E]]] = [None] * self.size
        # Last in, first out: the pair used last (warm, loaded) goes first.
        self._free: queue.LifoQueue[int] = queue.LifoQueue()
        for slot in reversed(range(self.size)):
            self._free.put(slot)
        self._lock = threading.Lock()
        self._busy = 0
        self._peak = 0

    @property
    def busy(self) -> int:
        return self._busy

    @property
    def peak(self) -> int:
        """The most pairs that were ever busy at once (for /health and tests)."""
        return self._peak

    @property
    def loaded(self) -> int:
        return sum(1 for p in self._pairs if p is not None)

    @contextmanager
    def borrow(self) -> Iterator[tuple[D, E]]:
        slot = self._free.get()
        try:
            with self._lock:
                self._busy += 1
                self._peak = max(self._peak, self._busy)
            pair = self._pairs[slot]
            if pair is None:
                pair = self._make_pair(self.threads)
                self._pairs[slot] = pair
            yield pair
        finally:
            with self._lock:
                self._busy -= 1
            self._free.put(slot)
