# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the VideoDubber STT worker -> binary `vd-stt-worker`.
#
# Build (from the repo root, inside the STT worker's venv):
#     pyinstaller --noconfirm --clean \
#         --distpath apps/desktop/src-tauri/binaries/.pyi/stt \
#         --workpath apps/desktop/src-tauri/binaries/.pyi/build-stt \
#         scripts/package/vd-stt-worker.spec
#
# `scripts/package/build-workers.sh` wires this up and then renames the output to
# `vd-stt-worker-<target-triple>` in `apps/desktop/src-tauri/binaries/`.
#
# Notes
# -----
# * The shared launcher (scripts/package/entry_worker.py) reads VD_WORKER to pick
#   the worker; we bake VD_WORKER=stt into the frozen env via a runtime hook so
#   the binary needs no arguments.
# * faster-whisper bundles model *metadata* (tokenizer assets) as package data;
#   ctranslate2 ships a compiled extension that PyInstaller's hooks usually find,
#   but we add it to hiddenimports defensively. The whisper *weights* are NOT
#   bundled — they download on first run into the HF cache.

import os

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

# Repo root = two levels up from this spec (scripts/package/<spec>).
REPO_ROOT = os.path.abspath(os.path.join(os.getcwd()))
WORKER_DIR = os.path.join(REPO_ROOT, "workers", "stt-worker")
ENTRY = os.path.join(REPO_ROOT, "scripts", "package", "entry_worker.py")
RT_HOOK = os.path.join(REPO_ROOT, "scripts", "package", "rthook_stt.py")

datas = []
binaries = []
hiddenimports = []

# --- The worker's own FastAPI app package ----------------------------------
hiddenimports += collect_submodules("app")

# --- faster-whisper + ctranslate2 ------------------------------------------
# Tokenizer / assets data files + the compiled ctranslate2 extension.
datas += collect_data_files("faster_whisper")
hiddenimports += collect_submodules("faster_whisper")
binaries += collect_dynamic_libs("ctranslate2")
hiddenimports += [
    "ctranslate2",
    # tokenizers (HF) ships a Rust extension faster-whisper uses.
    "tokenizers",
    "huggingface_hub",
    "onnxruntime",  # used by faster-whisper VAD (Silero); optional but safe.
    "av",           # PyAV decoder backend faster-whisper uses for audio I/O.
]
datas += collect_data_files("onnxruntime", include_py_files=False)

# --- uvicorn / fastapi / anyio dynamic imports ------------------------------
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "anyio",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]


block_cipher = None

a = Analysis(
    [ENTRY],
    pathex=[REPO_ROOT, WORKER_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[RT_HOOK],
    excludes=["tkinter", "matplotlib", "pytest"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="vd-stt-worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
