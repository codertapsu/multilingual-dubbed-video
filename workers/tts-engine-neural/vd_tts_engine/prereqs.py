"""System-tool prerequisite checks for the neural TTS engine.

NeuTTS Air phonemizes Vietnamese via `phonemizer`, which shells out to the
**espeak-ng** system binary. Without it, pronunciation is wrong (or synthesis
fails), so we surface its presence in `/health` and refuse the NeuTTS path when
it's missing (the caller then falls back to silence with a clear message).
"""

from __future__ import annotations

import shutil

# We check ONLY the `espeak-ng` binary name. Modern espeak-ng installs it under
# that name on every platform; the bare `espeak` name can be the legacy (pre-ng)
# eSpeak, which phonemizer's EspeakBackend rejects — matching on it would be a
# false positive that defeats the whole prerequisite check.
_ESPEAK_BINARIES = ("espeak-ng",)


def espeak_ng_path() -> str | None:
    """Absolute path to an espeak-ng binary on PATH, or None if absent."""
    for name in _ESPEAK_BINARIES:
        found = shutil.which(name)
        if found:
            return found
    return None


def espeak_ng_available() -> bool:
    """True when espeak-ng (or its `espeak` alias) is on PATH."""
    return espeak_ng_path() is not None
