"""Pytest fixtures and import-path setup for the STT worker tests.

Ensures the worker root (which contains the ``app`` package) is importable when
tests are run from anywhere, without requiring an editable install.
"""

from __future__ import annotations

import os
import sys

# Add the worker root (parent of this tests/ dir) to sys.path so `import app`
# works whether tests are launched from the repo root or the worker dir.
_WORKER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _WORKER_ROOT not in sys.path:
    sys.path.insert(0, _WORKER_ROOT)
