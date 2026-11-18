"""The VNNI probe (cpufeatures.py) that decides VieNeu 3.8's CPU precision."""

from __future__ import annotations

import platform

import pytest

from vd_tts_engine import cpufeatures


def _rows(max_leaf=0x20, leaf7_ecx=0, leaf71_eax=0):
    return [[max_leaf, 0, 0, 0], [0, 0, leaf7_ecx, 0], [leaf71_eax, 0, 0, 0]]


def test_either_vnni_bit_counts_and_nothing_else_does():
    assert cpufeatures.vnni_from_cpuid(_rows(leaf71_eax=1 << 4))  # AVX-VNNI (Intel 12th gen+)
    assert cpufeatures.vnni_from_cpuid(_rows(leaf7_ecx=1 << 11))  # AVX512-VNNI
    assert not cpufeatures.vnni_from_cpuid(_rows(leaf7_ecx=(1 << 10) | (1 << 12), leaf71_eax=(1 << 3) | (1 << 5)))
    # A CPU too old to have leaf 7, or an answer cut short, is "no".
    assert not cpufeatures.vnni_from_cpuid(_rows(max_leaf=6, leaf71_eax=1 << 4))
    assert not cpufeatures.vnni_from_cpuid([[0x20, 0, 0, 0]])


def test_only_x86_64_is_asked():
    assert cpufeatures.is_x86_64("AMD64") and cpufeatures.is_x86_64("x86_64")
    assert not cpufeatures.is_x86_64("arm64") and not cpufeatures.is_x86_64("aarch64")


@pytest.mark.skipif(not cpufeatures.is_x86_64(platform.machine()), reason="CPUID is x86-only")
def test_the_probe_answers_on_this_cpu():
    cpufeatures.has_vnni.cache_clear()
    assert isinstance(cpufeatures.has_vnni(), bool)


def test_a_probe_that_fails_means_no(monkeypatch):
    cpufeatures.has_vnni.cache_clear()
    monkeypatch.setattr(cpufeatures, "is_x86_64", lambda machine=None: True)

    class Failed:
        returncode = 3
        stdout = ""

    monkeypatch.setattr(cpufeatures.subprocess, "run", lambda *a, **k: Failed())
    assert cpufeatures.has_vnni() is False
    cpufeatures.has_vnni.cache_clear()
