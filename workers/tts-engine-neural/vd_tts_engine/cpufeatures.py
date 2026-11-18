"""Does this x86-64 CPU have VNNI (the int8 dot-product instructions)?

Why: VieNeu 3.8's int8 graphs are 1.4-1.6x faster than its fp32 ones on a
Windows desktop CPU (i5-13400F, RTF 0.31 against 0.48 at 4 threads) at the same
accuracy (Phase 0, 2026-11-18), but its author warns that int8 distorts on CPUs
without VNNI: without it ONNX Runtime's u8s8 int8 kernels can saturate. Nothing
installed reports the feature: numpy lists AVX512_VNNI but not AVX-VNNI (the
VEX form Intel's 12th-gen and later desktop chips have), and neither the SDK nor
ONNX Runtime exposes CPUID. So this asks the CPU directly.

CPUID is one instruction, run from a few bytes of machine code through ctypes
(the way py-cpuinfo does it), in a CHILD process: whatever goes wrong there
(an allocation refused by security software, a crash) costs nothing but the
answer, which is then "no" and the engine stays on fp32.

    AVX512_VNNI = CPUID(EAX=7, ECX=0).ECX bit 11
    AVX_VNNI    = CPUID(EAX=7, ECX=1).EAX bit 4
"""

from __future__ import annotations

import functools
import platform
import subprocess
import sys

# void cpuid(uint32 leaf, uint32 subleaf, uint32 out[4]), x86-64.
#   Windows x64: leaf=ecx, subleaf=edx, out=r8
#   System V:    leaf=edi, subleaf=esi, out=rdx (moved to r8)
_STORE = bytes.fromhex("0fa2" "418900" "41895804" "41894808" "4189500c" "5b" "c3")
_CODE_WIN = bytes.fromhex("53" "89c8" "89d1") + _STORE
_CODE_SYSV = bytes.fromhex("53" "89f8" "89f1" "4989d0") + _STORE

_PROBE = r"""
import ctypes, sys
code = bytes.fromhex(sys.argv[1])
out = (ctypes.c_uint32 * 4)()
if sys.platform == "win32":
    k = ctypes.windll.kernel32
    k.VirtualAlloc.restype = ctypes.c_void_p
    k.VirtualAlloc.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_uint32)
    k.VirtualProtect.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32))
    buf = k.VirtualAlloc(None, 4096, 0x3000, 0x04)  # MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE
    if not buf:
        sys.exit(3)
    ctypes.memmove(buf, code, len(code))
    old = ctypes.c_uint32()
    if not k.VirtualProtect(buf, 4096, 0x20, ctypes.byref(old)):  # PAGE_EXECUTE_READ
        sys.exit(3)
    addr = buf
else:
    import mmap
    m = mmap.mmap(-1, 4096, prot=mmap.PROT_READ | mmap.PROT_WRITE | mmap.PROT_EXEC)
    m.write(code)
    addr = ctypes.addressof(ctypes.c_char.from_buffer(m))
fn = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32))(addr)
def cpuid(leaf, sub):
    fn(leaf, sub, out)
    return list(out)
regs = [cpuid(0, 0)]
if regs[0][0] >= 7:
    regs += [cpuid(7, 0), cpuid(7, 1)]
print(" ".join(",".join(str(r) for r in row) for row in regs))
"""


def vnni_from_cpuid(rows: list[list[int]]) -> bool:
    """VNNI from CPUID rows [leaf0, leaf7.0, leaf7.1] (EAX, EBX, ECX, EDX each). Pure."""
    if len(rows) < 3 or rows[0][0] < 7:
        return False
    avx512_vnni = bool(rows[1][2] >> 11 & 1)
    avx_vnni = bool(rows[2][0] >> 4 & 1)
    return avx512_vnni or avx_vnni


def is_x86_64(machine: str | None = None) -> bool:
    return (machine if machine is not None else platform.machine()).lower() in ("x86_64", "amd64")


@functools.lru_cache(maxsize=1)
def has_vnni() -> bool:
    """True only when the CPU is x86-64 and reports AVX-VNNI or AVX512-VNNI."""
    if not is_x86_64():
        return False
    code = _CODE_WIN if sys.platform == "win32" else _CODE_SYSV
    try:
        res = subprocess.run(
            [sys.executable, "-I", "-c", _PROBE, code.hex()],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if res.returncode != 0:
        return False
    try:
        rows = [[int(v) for v in row.split(",")] for row in res.stdout.split()]
    except ValueError:
        return False
    return vnni_from_cpuid(rows)
