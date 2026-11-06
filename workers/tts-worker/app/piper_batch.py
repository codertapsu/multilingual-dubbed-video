"""Persistent Piper processes: load each voice ONCE, synthesize many lines.

The worker used to spawn one Piper process per subtitle line. Each spawn paid
interpreter start + voice-model load (~0.7 s on an M4 Pro) before speaking a
single word; measured throughput was 4.0 lines/s at the shipped concurrency of
4, and 4.9 at 8. The same voice kept loaded in ONE process does 16.3 lines/s —
and MORE persistent processes are slower (2 → 14.3, 6 → 7.3 lines/s), because
ONNX Runtime already spreads one synthesis over every core. So: one long-lived
process per voice model, requests serialized through it.

The process is still a separate program speaking a line-oriented JSON protocol
over pipes (scripts/package/entry_piper.py `--vd-batch`), so the GPL Piper code
stays out of this MIT process exactly as before.

How a batch command is found (first that works):
  1. the configured binary answers `--vd-batch-probe` (the frozen vd-piper);
  2. a DEV layout: the binary is a console script in a venv whose `python`
     sits beside it, and the repo's entry_piper.py exists — run that;
  3. otherwise None, and the engine keeps spawning one process per line.
`PIPER_BATCH=0` disables batch mode entirely (an escape hatch, not a default).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger("tts.piper_batch")

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
PROTOCOL = 1
_READY_TIMEOUT_S = 60.0
_REQUEST_TIMEOUT_S = 120.0
_IDLE_REAP_S = 300.0


def _repo_entry_script() -> Optional[Path]:
    """scripts/package/entry_piper.py when running from a source checkout."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "scripts" / "package" / "entry_piper.py"
        if cand.is_file():
            return cand
    return None


def resolve_batch_command(binary: str, run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> Optional[list[str]]:
    """The argv prefix that starts a batch-mode Piper, or None (see module doc)."""
    if os.environ.get("PIPER_BATCH", "").strip() == "0" or not binary:
        return None
    try:
        probe = run(
            [binary, "--vd-batch-probe"],
            capture_output=True,
            timeout=20,
            check=False,
            creationflags=_NO_WINDOW,
        )
        if probe.returncode == 0 and f"vd-batch/{PROTOCOL}" in probe.stdout.decode("utf-8", "replace"):
            return [binary, "--vd-batch"]
    except (OSError, subprocess.SubprocessError):
        pass
    # Dev: `.../.venv/bin/piper` (a console script) with `.../.venv/bin/python`.
    bin_dir = Path(binary).parent
    py = bin_dir / ("python.exe" if sys.platform == "win32" else "python")
    entry = _repo_entry_script()
    if py.is_file() and entry is not None:
        return [str(py), str(entry), "--vd-batch"]
    return None


class BatchUnavailable(RuntimeError):
    """The batch process could not start or died; the caller falls back."""


class PiperBatchProcess:
    """One running `--vd-batch` Piper serving one voice model."""

    def __init__(self, command: list[str], model: Path) -> None:
        self.model = model
        self.last_used = time.monotonic()
        self._lock = threading.Lock()
        self._lines: "queue.Queue[Optional[str]]" = queue.Queue()
        try:
            self._proc = subprocess.Popen(  # noqa: S603 - argv array, no shell
                [*command, "--model", str(model)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as exc:
            raise BatchUnavailable(f"could not start batch Piper: {exc}") from exc
        # A reader thread, because Windows pipes cannot be select()ed.
        threading.Thread(target=self._read, name="piper-batch-reader", daemon=True).start()
        ready = self._next(_READY_TIMEOUT_S)
        if not ready or not ready.get("ready"):
            self.close()
            raise BatchUnavailable(f"batch Piper did not become ready: {ready}")

    def _read(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            self._lines.put(line)
        self._lines.put(None)  # EOF

    def _next(self, timeout: float) -> Optional[dict]:
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            return None
        if line is None:
            return None
        try:
            return json.loads(line)
        except ValueError:
            return {"ok": False, "error": f"bad response: {line[:200]}"}

    @property
    def alive(self) -> bool:
        return self._proc.poll() is None

    def synth(self, text: str, out_path: str, length_scale: Optional[float]) -> None:
        """Synthesize one line. Raises BatchUnavailable when the process is gone."""
        with self._lock:
            self.last_used = time.monotonic()
            if not self.alive or self._proc.stdin is None:
                raise BatchUnavailable("batch Piper is not running")
            req = {"text": text, "output_file": out_path, **({"length_scale": length_scale} if length_scale else {})}
            try:
                self._proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
                self._proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise BatchUnavailable(f"batch Piper pipe closed: {exc}") from exc
            res = self._next(_REQUEST_TIMEOUT_S)
            if res is None:
                self.close()
                raise BatchUnavailable("batch Piper stopped responding")
            if not res.get("ok"):
                # A real synthesis error for THIS line (bad text, ...): the
                # process is fine; surface it like the per-line path would.
                raise RuntimeError(f"piper failed: {res.get('error')}")

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._proc.kill()


class PiperBatchPool:
    """At most one batch process per voice model, started lazily, reaped when idle."""

    def __init__(self, command: list[str]) -> None:
        self._command = command
        self._procs: dict[Path, PiperBatchProcess] = {}
        self._lock = threading.Lock()
        threading.Thread(target=self._reaper, name="piper-batch-reaper", daemon=True).start()

    def synth(self, model: Path, text: str, out_path: str, length_scale: Optional[float]) -> None:
        for attempt in (1, 2):
            proc = self._get(model)
            try:
                proc.synth(text, out_path, length_scale)
                return
            except BatchUnavailable:
                with self._lock:
                    if self._procs.get(model) is proc:
                        del self._procs[model]
                if attempt == 2:
                    raise

    def _get(self, model: Path) -> PiperBatchProcess:
        with self._lock:
            proc = self._procs.get(model)
            if proc is not None and proc.alive:
                return proc
            proc = PiperBatchProcess(self._command, model)
            self._procs[model] = proc
            logger.info("started persistent Piper for %s", model.name)
            return proc

    def _reaper(self) -> None:
        while True:
            time.sleep(30)
            now = time.monotonic()
            with self._lock:
                idle = [m for m, p in self._procs.items() if now - p.last_used > _IDLE_REAP_S or not p.alive]
                for m in idle:
                    self._procs.pop(m).close()
                    logger.info("stopped idle Piper for %s", m.name)

    def close(self) -> None:
        with self._lock:
            for proc in self._procs.values():
                proc.close()
            self._procs.clear()
