"""Pytest import-path setup for the OmniVoice engine tests.

Adds the worker root (parent of this tests/ dir) to sys.path so `import
vd_omnivoice` works whether pytest is launched from the repo root or the worker
dir, without an editable install. The tests exercise the non-ML surface only
(mlx-audio is NOT required), mirroring CI where the heavy SDK isn't installed.
"""

from __future__ import annotations

import os
import sys

_WORKER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _WORKER_ROOT not in sys.path:
    sys.path.insert(0, _WORKER_ROOT)
