"""How many CPU threads CTranslate2 should use — the PERFORMANCE cores.

faster-whisper documents ``cpu_threads=0`` as "4 by default", and that is what
this worker shipped with: every machine transcribed on four threads, however
many cores it had. Measured on an M4 Pro (8 performance + 4 efficiency cores),
42 s of speech, int8:

    model             4 threads   8 threads (P-cores)   12 threads (all cores)
    small               4.74 s        4.20 s                 7.91 s
    large-v3-turbo     10.24 s        7.02 s  (-31%)            —

Two lessons, both encoded below:

1. More threads help — up to the number of PERFORMANCE cores.
2. Past that it gets dramatically WORSE. CTranslate2 parallelises with OpenMP,
   whose barriers wait for the slowest thread; scheduling work on an efficiency
   core (Apple Silicon, Intel 12th-gen+ hybrids) or an SMT sibling makes every
   step wait for it. "Use every logical CPU" is not the same as "use the
   hardware fully" — it was 67% slower here.

So the default is the count of physical performance cores, discovered per OS:

* macOS: ``hw.perflevel0.physicalcpu`` (the P-cluster on Apple Silicon), else
  ``hw.physicalcpu`` (Intel Macs).
* Windows: ``GetLogicalProcessorInformationEx(RelationProcessorCore)`` — one
  record per PHYSICAL core, each with an ``EfficiencyClass``; on a hybrid CPU
  only the cores of the highest class are counted.
* Linux: unique ``(package, core)`` pairs from sysfs, intersected with the
  process's CPU affinity (containers and ``taskset`` limit it).

Everything falls back to ``os.cpu_count()`` when the platform probe fails —
never to a fixed small number. The probes are injected so the logic is
unit-testable on any OS.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable, Iterable, Optional

# Windows allocates a console for console-subsystem children of a console-less
# parent; never flash one for a sysctl-style probe.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _sysctl_int(name: str) -> Optional[int]:
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv
            ["/usr/sbin/sysctl", "-n", name],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        value = int(out.stdout.strip())
    except ValueError:
        return None
    return value if value > 0 else None


def macos_performance_cores(sysctl: Callable[[str], Optional[int]] = _sysctl_int) -> Optional[int]:
    """P-cluster core count on Apple Silicon; physical cores on Intel Macs."""
    return sysctl("hw.perflevel0.physicalcpu") or sysctl("hw.physicalcpu")


def performance_cores_from_efficiency_classes(classes: Iterable[int]) -> Optional[int]:
    """Count the cores of the HIGHEST efficiency class (Windows' P-cores).

    Windows reports one ``PROCESSOR_RELATIONSHIP`` per physical core with an
    ``EfficiencyClass`` byte; on a non-hybrid CPU every core reports 0, so this
    is simply the physical core count.
    """
    values = list(classes)
    if not values:
        return None
    top = max(values)
    return sum(1 for v in values if v == top)


def efficiency_classes_from_records(raw: bytes) -> list[int]:
    """EfficiencyClass of each record in a RelationProcessorCore buffer. Pure.

    Layout (winnt.h): SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX is
    ``DWORD Relationship; DWORD Size;`` followed by a PROCESSOR_RELATIONSHIP
    ``{ BYTE Flags; BYTE EfficiencyClass; BYTE Reserved[20]; WORD GroupCount;
    GROUP_AFFINITY GroupMask[]; }``. Records are variable-length, so walk by
    each record's own ``Size``; stop at anything malformed rather than guess.
    """
    classes: list[int] = []
    offset = 0
    while offset + 10 <= len(raw):
        record_size = int.from_bytes(raw[offset + 4 : offset + 8], "little")
        if record_size < 10 or offset + record_size > len(raw):
            break
        classes.append(raw[offset + 9])
        offset += record_size
    return classes


def _windows_core_efficiency_classes() -> Optional[list[int]]:
    """EfficiencyClass of each physical core, via GetLogicalProcessorInformationEx."""
    if sys.platform != "win32":
        return None
    # Deliberately broad: this runs while the worker STARTS, it has never had a
    # Windows CI runner, and a thread-count heuristic must not be able to stop
    # transcription from booting. Any surprise means "unknown" -> cpu_count().
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        relation_processor_core = 0
        size = ctypes.c_uint32(0)
        # First call sizes the buffer (it fails with ERROR_INSUFFICIENT_BUFFER).
        kernel32.GetLogicalProcessorInformationEx(relation_processor_core, None, ctypes.byref(size))
        if size.value == 0:
            return None
        buf = (ctypes.c_ubyte * size.value)()
        if not kernel32.GetLogicalProcessorInformationEx(relation_processor_core, buf, ctypes.byref(size)):
            return None
        return efficiency_classes_from_records(bytes(buf)[: size.value]) or None
    except Exception:  # noqa: BLE001 - see above
        return None


def linux_physical_cores(
    cpu_root: Path = Path("/sys/devices/system/cpu"),
    allowed: Optional[set[int]] = None,
) -> Optional[int]:
    """Unique (package, core) pairs among the CPUs this process may run on."""
    if allowed is None:
        try:
            allowed = set(os.sched_getaffinity(0))  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            allowed = None
    cores: set[tuple[str, str]] = set()
    try:
        for cpu_dir in cpu_root.glob("cpu[0-9]*"):
            try:
                index = int(cpu_dir.name[3:])
            except ValueError:
                continue
            if allowed is not None and index not in allowed:
                continue
            topo = cpu_dir / "topology"
            try:
                package = (topo / "physical_package_id").read_text().strip()
                core = (topo / "core_id").read_text().strip()
            except OSError:
                continue
            cores.add((package, core))
    except OSError:
        return None
    return len(cores) or None


def default_cpu_threads(
    platform: str = sys.platform,
    *,
    macos_probe: Callable[[], Optional[int]] = macos_performance_cores,
    windows_probe: Callable[[], Optional[list[int]]] = _windows_core_efficiency_classes,
    linux_probe: Callable[[], Optional[int]] = linux_physical_cores,
    logical: Callable[[], Optional[int]] = os.cpu_count,
) -> int:
    """The thread count to hand CTranslate2 when the user set none."""
    found: Optional[int] = None
    try:
        if platform == "darwin":
            found = macos_probe()
        elif platform == "win32":
            classes = windows_probe()
            found = performance_cores_from_efficiency_classes(classes) if classes else None
        elif platform.startswith("linux"):
            found = linux_probe()
    except Exception:  # noqa: BLE001 - a probe bug must cost speed, never startup
        found = None
    if found and found > 0:
        return found
    return max(1, logical() or 1)
