"""Shared PyInstaller entry point for the three VideoDubber Python workers.

This tiny launcher is what each frozen sidecar runs. PyInstaller calls into the
module's ``__main__`` block (we point the `.spec` files at this file), and it
boots the FastAPI app for the worker named in the ``VD_WORKER`` env var on the
configured port.

Why a single shared launcher?
-----------------------------
All three workers expose the same shape (``app.main:app`` ASGI app + a host/port
resolved from env). Rather than maintain three near-identical entry modules, the
``.spec`` files set ``VD_WORKER`` (one of ``stt`` / ``translation`` / ``tts``)
and add the matching worker's ``app`` package to the analysis path. At runtime we
import *that* worker's ``app.main`` and run uvicorn against it.

The frozen binary takes no CLI arguments — everything is env-driven, exactly like
the dev path (``scripts/dev.sh`` / the orchestrator's sidecar launcher), so the
Tauri shell can configure ports + model dirs purely through the child's
environment (see ``apps/desktop/src-tauri/src/sidecar.rs`` production path).

Default ports (overridable via the worker's own env var, matching its config.py):
    stt          -> STT_PORT                (default 5101)
    translation  -> TRANSLATION_WORKER_PORT (default 5102)
    tts          -> TTS_WORKER_PORT         (default 5103)
"""

from __future__ import annotations

import os
import sys


def _ensure_stdio() -> None:
    """Guarantee sys.stdout/sys.stderr are writable.

    The frozen workers are built windowed (console=False) so they don't pop a
    console window on Windows. In that mode, if a process is launched without
    inherited stdio handles, Python leaves sys.stdout/sys.stderr as ``None`` —
    and both this launcher and uvicorn write to stderr, which would crash with
    ``AttributeError: 'NoneType' object has no attribute 'write'``. The Tauri
    shell DOES pipe stdio (so this is normally a no-op), but guard regardless.
    """
    for _name in ("stdout", "stderr"):
        if getattr(sys, _name, None) is None:
            setattr(sys, _name, open(os.devnull, "w", encoding="utf-8"))


# (worker key) -> (host env var, port env var, default port)
_WORKER_NET = {
    "stt": ("STT_HOST", "STT_PORT", 5101),
    "translation": ("TRANSLATION_WORKER_HOST", "TRANSLATION_WORKER_PORT", 5102),
    "tts": ("TTS_WORKER_HOST", "TTS_WORKER_PORT", 5103),
}


# What each worker imports lazily, on its first real job. GET /health never
# touches these, so a frozen build that cannot load one looks healthy until a
# user's first dub. The 0.11.0 test build shipped exactly that: the translation
# worker could not import sentencepiece (a DLL its wheel renamed), and offline
# translation failed only once Settings or a dub asked for it. The build runs
# `<worker> --vd-import-check` on every frozen worker and refuses to ship one
# that fails (build-workers.ps1 / .sh).
_LAZY_IMPORTS = {
    "stt": ("app.main", "faster_whisper", "faster_whisper.vad", "ctranslate2", "onnxruntime"),
    "translation": (
        "app.main",
        "argostranslate.translate",
        "argostranslate.package",
        "sentencepiece",
        "ctranslate2",
        "minisbd",
    ),
    "tts": ("app.main",),
}


def _import_check(worker: str) -> int:
    """Import everything ``worker`` loads lazily. Exit code 0 only if all load."""
    import importlib  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    # Some of these write on import (argostranslate creates its data dirs, the
    # TTS config its cache dir). A build check must not leave them in the
    # builder's real profile, so every home-like location points at scratch.
    scratch = tempfile.mkdtemp(prefix="vd-import-check-")
    for var in ("USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"):
        os.environ[var] = scratch
    os.environ["VIDEODUBBER_CONFIG_DIR"] = os.path.join(scratch, "VideoDubber")
    os.environ["VIDEODUBBER_CACHE_DIR"] = os.path.join(scratch, "VideoDubber", "cache")
    os.environ["ARGOS_PACKAGES_DIR"] = os.path.join(scratch, "argos")

    failed: list[str] = []
    try:
        for name in _LAZY_IMPORTS[worker]:
            try:
                importlib.import_module(name)
                sys.stderr.write(f"[vd-{worker}-worker] import ok: {name}\n")
            except Exception as exc:  # noqa: BLE001 - report every failure, not only the first
                failed.append(name)
                sys.stderr.write(f"[vd-{worker}-worker] IMPORT FAILED: {name}: {type(exc).__name__}: {exc}\n")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    if failed:
        sys.stderr.write(f"[vd-{worker}-worker] {len(failed)} import(s) failed: {', '.join(failed)}\n")
        return 1
    sys.stderr.write(f"[vd-{worker}-worker] import check passed ({len(_LAZY_IMPORTS[worker])} modules)\n")
    return 0


def _resolve_worker() -> str:
    worker = os.environ.get("VD_WORKER", "").strip().lower()
    if worker not in _WORKER_NET:
        sys.stderr.write(
            f"[vd-worker] FATAL: VD_WORKER must be one of {sorted(_WORKER_NET)} "
            f"(got {worker!r}). The .spec file should set it at build time.\n"
        )
        raise SystemExit(2)
    return worker


def main() -> None:
    _ensure_stdio()
    worker = _resolve_worker()
    if "--vd-import-check" in sys.argv[1:]:
        raise SystemExit(_import_check(worker))
    host_env, port_env, default_port = _WORKER_NET[worker]

    host = os.environ.get(host_env, "127.0.0.1").strip() or "127.0.0.1"
    try:
        port = int(os.environ.get(port_env, str(default_port)).strip() or default_port)
    except ValueError:
        port = default_port

    log_level = os.environ.get("VD_LOG_LEVEL", "info").strip().lower() or "info"

    # Import uvicorn + the selected worker's ASGI app lazily so import errors are
    # attributed to the running binary (and so PyInstaller's analysis only needs
    # the hidden import, which the .spec declares).
    import uvicorn  # noqa: PLC0415
    from app.main import app  # type: ignore[import-not-found]  # noqa: PLC0415

    sys.stderr.write(f"[vd-{worker}-worker] listening on http://{host}:{port}\n")

    # Pass the app *object* (not the "app.main:app" import string): the frozen
    # bundle has no source tree for uvicorn to re-import by name, and we never
    # want reload in production.
    uvicorn.run(app, host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
