"""Optional CLI helper to pre-cache a faster-whisper model.

Usage
-----
    python -m app.download_model                 # uses FASTER_WHISPER_MODEL or "small"
    python -m app.download_model --model medium  # explicit model size
    python -m app.download_model --list          # show common model sizes

Downloading once (with network) lets the worker run fully offline afterwards.
The weights are cached under STT_MODEL_CACHE_DIR (if set) or the default
HuggingFace cache (~/.cache/huggingface).
"""

from __future__ import annotations

import argparse
import logging
import sys

from .config import get_settings
from .errors import AppError
from . import whisper_service

logger = logging.getLogger("videodubber.stt.download")

# Common faster-whisper model sizes (not exhaustive).
COMMON_MODELS = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v2",
    "large-v3",
]


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    settings = get_settings()
    parser = argparse.ArgumentParser(
        prog="app.download_model",
        description="Pre-cache a faster-whisper model so the STT worker can run offline.",
    )
    parser.add_argument(
        "--model",
        default=settings.model,
        help=f"Model size to download (default: {settings.model}).",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List common model sizes and exit.",
    )
    args = parser.parse_args(argv)

    if args.list:
        print("Common faster-whisper models:")
        for name in COMMON_MODELS:
            print(f"  - {name}")
        return 0

    logger.info(
        "Downloading/caching model '%s' (device=%s, compute_type=%s)...",
        args.model,
        settings.device,
        settings.compute_type,
    )
    try:
        # Loading the model triggers the download into the cache.
        whisper_service.warm_up(args.model)
    except AppError as exc:
        logger.error("Failed: %s", exc.message)
        if exc.remediation:
            logger.error("Remediation: %s", exc.remediation)
        return 1

    logger.info("Model '%s' is cached and ready.", args.model)
    return 0


if __name__ == "__main__":  # pragma: no cover - thin CLI shim
    sys.exit(main())
