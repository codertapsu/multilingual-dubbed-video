# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the VideoDubber TTS worker -> binary `vd-tts-worker`.
#
# Build (from the repo root, inside the TTS worker's venv):
#     pyinstaller --noconfirm --clean \
#         --distpath apps/desktop/src-tauri/binaries/.pyi/tts \
#         --workpath apps/desktop/src-tauri/binaries/.pyi/build-tts \
#         scripts/package/vd-tts-worker.spec
#
# Notes
# -----
# * The TTS worker is the lightest: it has NO heavy ML python deps. Piper is
#   invoked as a *separate binary* via subprocess (see workers/tts-worker — the
#   piper executable + the .onnx voice are NOT python deps). So this build only
#   needs FastAPI/uvicorn/pydantic + the app package + the stdlib fallback engine.
# * The Piper executable itself is bundled as its own sidecar only if you choose
#   to ship it; by default the orchestrator downloads Piper *voices* on first run
#   and the worker uses system/fallback TTS until a voice + binary are present.
#   (Bundling the piper binary is optional and orthogonal to this spec.)

import os

from PyInstaller.utils.hooks import collect_submodules

REPO_ROOT = os.path.abspath(os.path.join(os.getcwd()))
WORKER_DIR = os.path.join(REPO_ROOT, "workers", "tts-worker")
ENTRY = os.path.join(REPO_ROOT, "scripts", "package", "entry_worker.py")
RT_HOOK = os.path.join(REPO_ROOT, "scripts", "package", "rthook_tts.py")

datas = []
binaries = []
hiddenimports = []

# --- The worker's own FastAPI app package ----------------------------------
hiddenimports += collect_submodules("app")

# --- uvicorn / fastapi dynamic imports -------------------------------------
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
    excludes=["tkinter", "matplotlib", "pytest", "torch", "numpy.distutils"],
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
    name="vd-tts-worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # no console window on Windows; Tauri pipes stdio (see entry_worker._ensure_stdio)
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
