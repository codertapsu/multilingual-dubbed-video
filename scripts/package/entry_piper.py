"""PyInstaller entry point for the frozen `vd-piper` CLI sidecar.

This freezes the piper-tts console script (`piper`) into a single self-
contained executable so the packaged desktop app can synthesize neural speech
without a Python installation. The TTS worker invokes it as a SEPARATE process
(`vd-piper --model voice.onnx --output_file out.wav`, text on stdin) — exactly
like the dev venv's `piper` script — which also keeps the GPL-licensed
piper/espeak-ng code out of the MIT worker process (mere aggregation, same
posture as the bundled ffmpeg).
"""

from __future__ import annotations

import os
import sys

from piper.__main__ import main

# Built windowed (console=False) to avoid a console window on Windows. If launched
# without inherited stdio handles, sys.stdout/stderr can be None and piper's logging
# would crash; guard before running. (The TTS worker always pipes stdio, so normally
# a no-op.) piper reads text on stdin and writes audio to --output_file.
for _name in ("stdout", "stderr"):
    if getattr(sys, _name, None) is None:
        setattr(sys, _name, open(os.devnull, "w", encoding="utf-8"))

if __name__ == "__main__":
    sys.exit(main())
