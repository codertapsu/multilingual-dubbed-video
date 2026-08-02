# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the VideoDubber Translation worker -> `vd-translation-worker`.
#
# Build (from the repo root, inside the translation worker's venv):
#     pyinstaller --noconfirm --clean \
#         --distpath apps/desktop/src-tauri/binaries/.pyi/translation \
#         --workpath apps/desktop/src-tauri/binaries/.pyi/build-translation \
#         scripts/package/vd-translation-worker.spec
#
# Notes
# -----
# * argostranslate depends on stanza (sentence boundary detection) + sentencepiece
#   + ctranslate2 for the actual NMT. Stanza ships many data files; sentencepiece
#   ships a compiled extension. The Argos *language packages* (.argosmodel) are
#   NOT bundled — they download on first run into the Argos user-data dir.
# * stanza also pulls torch transitively in some setups; we DON'T force-bundle
#   torch (huge) — argostranslate's default pipeline uses ctranslate2, and stanza
#   here is only used for tokenization. If a build errors on a missing torch
#   submodule, add it to hiddenimports rather than excluding stanza.

import os

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

REPO_ROOT = os.path.abspath(os.path.join(os.getcwd()))
WORKER_DIR = os.path.join(REPO_ROOT, "workers", "translation-worker")
ENTRY = os.path.join(REPO_ROOT, "scripts", "package", "entry_worker.py")
RT_HOOK = os.path.join(REPO_ROOT, "scripts", "package", "rthook_translation.py")

datas = []
binaries = []
hiddenimports = []

# --- The worker's own FastAPI app package ----------------------------------
hiddenimports += collect_submodules("app")

# --- argostranslate + its NMT/tokenization stack ---------------------------
datas += collect_data_files("argostranslate")
hiddenimports += collect_submodules("argostranslate")
hiddenimports += [
    "argostranslate.translate",
    "argostranslate.package",
    "argostranslate.settings",
    "argostranslate.utils",
]

# ctranslate2 (the NMT runtime) — compiled libs.
binaries += collect_dynamic_libs("ctranslate2")
hiddenimports += ["ctranslate2"]

# sentencepiece — compiled tokenizer used by Argos models.
binaries += collect_dynamic_libs("sentencepiece")
hiddenimports += ["sentencepiece"]

# MiniSBD — sentence segmentation on onnxruntime. This REPLACES stanza, which
# imports torch and so dragged ~580 MB (40% of the app) into the bundle for
# sentence boundaries alone. rthook_translation.py stubs `stanza` and forces
# ARGOS_CHUNK_TYPE=MINISBD; the models are seeded into each Argos package at
# install time (ArgosBackend._seed_minisbd_model) so nothing downloads mid-dub.
datas += collect_data_files("minisbd")
hiddenimports += collect_submodules("minisbd")

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
    # spacy is optional in argostranslate.sbd (try/except) and unused by the
    # default sentencizer — verified an en->vi translation works without it.
    # onnxruntime is hard-required (MiniSBD runs on it); torch is NOT — it only
    # stay. Dropping spacy shaves ~24 MB.
    excludes=[
        "tkinter",
        "matplotlib",
        "pytest",
        "spacy",
        # stanza -> torch is the single edge that made this worker 739 MB. The
        # runtime hook stubs stanza, so nothing here imports either at run time;
        # excluding them stops PyInstaller following the graph at BUILD time.
        # sympy/networkx/mpmath are torch's own deps and go with it.
        "stanza",
        "torch",
        "torchgen",
        "functorch",
        "sympy",
        "networkx",
        "mpmath",
    ],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="vd-translation-worker",
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
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="vd-translation-worker",
)
