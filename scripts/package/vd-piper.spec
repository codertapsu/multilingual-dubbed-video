# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Piper CLI -> binary `vd-piper`.
#
# Build (from the repo root, inside the TTS worker's venv — piper-tts is
# installed there):
#     pyinstaller --noconfirm --clean \
#         --distpath apps/desktop/src-tauri/binaries/.pyi/piper \
#         --workpath apps/desktop/src-tauri/binaries/.pyi/build-piper \
#         scripts/package/vd-piper.spec
#
# Notes
# -----
# * This is a CLI tool, not a service: the TTS worker spawns it per segment
#   (`vd-piper --model voice.onnx --output_file out.wav`, text on stdin). The
#   shell hands the worker its path via PIPER_BINARY_PATH (see sidecar.rs).
# * piper-tts (piper1-gpl) bundles its phonemizer data INSIDE the package:
#   piper/espeak-ng-data (espeak dictionaries) and piper/tashkeel (Arabic
#   diacritizer model) — collect_data_files() picks both up.
# * piper.train needs torch and is NEVER imported by the CLI — exclude it so
#   the analysis cannot accidentally pull a multi-GB ML stack.
# * Voice models (*.onnx) are NOT bundled; the orchestrator downloads them on
#   first run into <config>/models/piper (PIPER_VOICES_DIR).

import os

from PyInstaller.utils.hooks import collect_data_files

REPO_ROOT = os.path.abspath(os.path.join(os.getcwd()))
ENTRY = os.path.join(REPO_ROOT, "scripts", "package", "entry_piper.py")

datas = []
binaries = []
hiddenimports = []

# --- piper package data (espeak-ng-data, tashkeel onnx) ----------------------
datas += collect_data_files("piper")

# --- modules the CLI reaches (import graph is followed from the entry) -------
hiddenimports += [
    "piper",
    "piper.voice",
    "piper.config",
    "piper.phoneme_ids",
    "piper.phonemize_espeak",
    "piper.espeakbridge",
    "pathvalidate",
]

block_cipher = None

a = Analysis(
    [ENTRY],
    pathex=[REPO_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "piper.train",
        "torch",
        "tkinter",
        "matplotlib",
        "pytest",
        "numpy.distutils",
    ],
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
    name="vd-piper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # no console window on Windows; Tauri pipes stdio (see entry_piper)
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
