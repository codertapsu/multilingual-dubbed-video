"""The default CTranslate2 thread count is the PERFORMANCE-core count.

Pins the decision in app/cpu.py: faster-whisper's own default is a flat 4
threads, and "every logical CPU" is worse still on hybrid chips (12 threads on an
8P+4E M4 Pro ran 67% slower than 8). Every probe is injected, so these run the
macOS / Windows / Linux branches on any host.
"""

from __future__ import annotations

from pathlib import Path

from app.cpu import (
    default_cpu_threads,
    efficiency_classes_from_records,
    linux_physical_cores,
    macos_performance_cores,
    performance_cores_from_efficiency_classes,
)


def test_macos_prefers_the_performance_cluster() -> None:
    values = {"hw.perflevel0.physicalcpu": 8, "hw.physicalcpu": 12}
    assert macos_performance_cores(values.get) == 8


def test_macos_intel_falls_back_to_physical_cores() -> None:
    # Intel Macs have no perflevel sysctls.
    values = {"hw.physicalcpu": 6}
    assert macos_performance_cores(values.get) == 6


def test_windows_hybrid_counts_only_the_highest_efficiency_class() -> None:
    # Intel 13th-gen style: 8 P-cores (class 1) + 16 E-cores (class 0).
    classes = [1] * 8 + [0] * 16
    assert performance_cores_from_efficiency_classes(classes) == 8


def test_windows_non_hybrid_counts_every_physical_core() -> None:
    # Every core reports class 0 on a non-hybrid CPU (e.g. a Ryzen 7).
    assert performance_cores_from_efficiency_classes([0] * 8) == 8


def test_windows_empty_report_is_unknown() -> None:
    assert performance_cores_from_efficiency_classes([]) is None


def _cpu(root: Path, index: int, package: int, core: int) -> None:
    topo = root / f"cpu{index}" / "topology"
    topo.mkdir(parents=True)
    (topo / "physical_package_id").write_text(f"{package}\n")
    (topo / "core_id").write_text(f"{core}\n")


def test_linux_counts_smt_siblings_once(tmp_path: Path) -> None:
    # 4 physical cores, 2 threads each (cpu0/cpu4 are siblings, etc.).
    for core in range(4):
        _cpu(tmp_path, core, 0, core)
        _cpu(tmp_path, core + 4, 0, core)
    assert linux_physical_cores(tmp_path, allowed=set(range(8))) == 4


def test_linux_respects_the_process_affinity(tmp_path: Path) -> None:
    for core in range(4):
        _cpu(tmp_path, core, 0, core)
        _cpu(tmp_path, core + 4, 0, core)
    # A container pinned to cpu0-1 owns two physical cores, not four.
    assert linux_physical_cores(tmp_path, allowed={0, 1}) == 2


def test_default_uses_the_platform_probe() -> None:
    assert default_cpu_threads("darwin", macos_probe=lambda: 8, logical=lambda: 12) == 8
    assert default_cpu_threads("win32", windows_probe=lambda: [1] * 6 + [0] * 8, logical=lambda: 20) == 6
    assert default_cpu_threads("linux", linux_probe=lambda: 16, logical=lambda: 32) == 16


def test_default_falls_back_to_logical_cpus_never_a_fixed_small_number() -> None:
    # A failed probe must not silently reintroduce the old flat 4.
    assert default_cpu_threads("darwin", macos_probe=lambda: None, logical=lambda: 10) == 10
    assert default_cpu_threads("win32", windows_probe=lambda: None, logical=lambda: 16) == 16
    assert default_cpu_threads("freebsd", logical=lambda: 6) == 6


def test_default_is_at_least_one() -> None:
    assert default_cpu_threads("darwin", macos_probe=lambda: None, logical=lambda: None) == 1


def test_settings_resolve_threads_when_env_is_unset(monkeypatch) -> None:
    import app.config as config

    monkeypatch.delenv("STT_CPU_THREADS", raising=False)
    config.get_settings.cache_clear()
    try:
        assert config.get_settings().cpu_threads >= 1
    finally:
        config.get_settings.cache_clear()


def test_explicit_env_still_wins(monkeypatch) -> None:
    import app.config as config

    monkeypatch.setenv("STT_CPU_THREADS", "3")
    config.get_settings.cache_clear()
    try:
        assert config.get_settings().cpu_threads == 3
    finally:
        config.get_settings.cache_clear()


def _core_record(efficiency_class: int, groups: int = 1) -> bytes:
    """One SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX(RelationProcessorCore), x64.

    8-byte header, then PROCESSOR_RELATIONSHIP: Flags, EfficiencyClass,
    Reserved[20], GroupCount (WORD) = 32 bytes, then 16 bytes per
    GROUP_AFFINITY (KAFFINITY Mask + WORD Group + WORD Reserved[3]).
    """
    body = bytes([0, efficiency_class]) + bytes(20) + groups.to_bytes(2, "little")
    body += bytes(16 * groups)
    size = 8 + len(body)
    return (0).to_bytes(4, "little") + size.to_bytes(4, "little") + body


def test_windows_records_are_walked_by_their_own_size() -> None:
    # A hybrid part: 2 P-cores (class 1) and 4 E-cores (class 0), one of the
    # P-cores spanning two processor groups so the records differ in length.
    raw = _core_record(1) + _core_record(1, groups=2) + b"".join(_core_record(0) for _ in range(4))
    assert len(_core_record(0)) == 48
    classes = efficiency_classes_from_records(raw)
    assert classes == [1, 1, 0, 0, 0, 0]
    assert performance_cores_from_efficiency_classes(classes) == 2


def test_windows_malformed_records_stop_the_walk_instead_of_guessing() -> None:
    good = _core_record(0) + _core_record(0)
    assert efficiency_classes_from_records(good + _core_record(1)[:20]) == [0, 0]  # truncated tail
    zero_size = (0).to_bytes(4, "little") + (0).to_bytes(4, "little") + bytes(40)
    assert efficiency_classes_from_records(good + zero_size + _core_record(1)) == [0, 0]
    assert efficiency_classes_from_records(b"") == []


def test_a_probe_that_raises_costs_speed_never_startup() -> None:
    # The Windows probe has never run on a Windows CI machine; whatever it
    # throws, the worker must still start, on every logical CPU.
    def boom() -> list[int]:
        raise RuntimeError("unexpected ctypes failure")

    assert default_cpu_threads("win32", windows_probe=boom, logical=lambda: 16) == 16


def test_the_tts_worker_ships_the_same_cpu_module() -> None:
    # Each worker is its own package (own venv, own frozen binary), so the module
    # is duplicated on purpose; this keeps the two copies from drifting.
    here = Path(__file__).resolve()
    stt = here.parents[1] / "app" / "cpu.py"
    tts = here.parents[2] / "tts-worker" / "app" / "cpu.py"
    assert stt.read_bytes() == tts.read_bytes()
