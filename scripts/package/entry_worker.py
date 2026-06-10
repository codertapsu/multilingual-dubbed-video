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


# (worker key) -> (host env var, port env var, default port)
_WORKER_NET = {
    "stt": ("STT_HOST", "STT_PORT", 5101),
    "translation": ("TRANSLATION_WORKER_HOST", "TRANSLATION_WORKER_PORT", 5102),
    "tts": ("TTS_WORKER_HOST", "TTS_WORKER_PORT", 5103),
}


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
    worker = _resolve_worker()
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
