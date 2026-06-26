"""Entry point: `python -m vd_omnivoice --port <PORT>`.

Launched by the orchestrator's EngineManager (`<pack>/venv/bin/python -m
vd_omnivoice`) once the `tts-omnivoice` engine pack is installed. The venv
provides mlx-audio (Apple Silicon only); this package is loaded from bundled
source via PYTHONPATH.
"""

from __future__ import annotations

import argparse
import logging


def main() -> None:
    parser = argparse.ArgumentParser(prog="vd_omnivoice", description="VideoDubber neural TTS (OmniVoice) server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5105)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    import uvicorn

    from .app import app

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
