"""Content-addressed cache for synthesized segment audio.

Cache key = sha256(segmentId + text + voiceId + str(speed)). When a cached WAV
exists for a key we reuse it by copying it into the requested outputDir under
the expected `segment_0001.wav` name (so resuming a project / re-running a step
is fast and deterministic).

We copy rather than symlink by default for cross-platform robustness (Windows
symlinks need privileges); a symlink fast-path is attempted opportunistically.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path

logger = logging.getLogger("tts.cache")


def cache_key(segment_id: str, text: str, voice_id: str | None, speed: float) -> str:
    """Compute the sha256 cache key for a synthesis request.

    The components are joined with a NUL separator so distinct fields cannot
    collide (e.g. "a" + "bc" vs "ab" + "c").
    """
    parts = [segment_id, text, voice_id or "", str(speed)]
    h = hashlib.sha256("\x00".join(parts).encode("utf-8"))
    return h.hexdigest()


class AudioCache:
    """Filesystem cache living under a single directory."""

    def __init__(self, cache_dir: str | Path) -> None:
        self.cache_dir = Path(cache_dir)
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.warning("cache dir %s not creatable; caching disabled", self.cache_dir)

    def _path_for(self, key: str) -> Path:
        return self.cache_dir / f"{key}.wav"

    def get(self, key: str) -> Path | None:
        """Return the cached WAV path for a key, or None if absent."""
        p = self._path_for(key)
        return p if p.is_file() else None

    def put(self, key: str, source_wav: str | Path) -> Path:
        """Store a freshly synthesized WAV under its cache key.

        Returns the cached path. Best-effort: on failure the source is left
        untouched and the source path is returned.
        """
        dest = self._path_for(key)
        try:
            shutil.copyfile(source_wav, dest)
            logger.debug("cached %s -> %s", source_wav, dest)
            return dest
        except OSError as exc:
            logger.warning("failed to cache %s: %s", source_wav, exc)
            return Path(source_wav)

    def materialize(self, cached_wav: str | Path, dest_wav: str | Path) -> Path:
        """Place a cached WAV at `dest_wav` (the expected segment filename).

        Tries a symlink first (cheap), falling back to a copy. Returns the
        destination path.
        """
        src = Path(cached_wav)
        dest = Path(dest_wav)
        dest.parent.mkdir(parents=True, exist_ok=True)

        # If they're already the same file, nothing to do.
        try:
            if dest.exists() and dest.samefile(src):
                return dest
        except OSError:
            pass

        if dest.exists() or dest.is_symlink():
            try:
                dest.unlink()
            except OSError:
                pass

        try:
            dest.symlink_to(src)
            logger.debug("symlinked cache %s -> %s", src, dest)
            return dest
        except (OSError, NotImplementedError):
            shutil.copyfile(src, dest)
            logger.debug("copied cache %s -> %s", src, dest)
            return dest
