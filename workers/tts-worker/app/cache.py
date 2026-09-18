"""Content-addressed cache for synthesized segment audio.

Cache key = sha256(segmentId + text + voiceId + str(speed)). When a cached WAV
exists for a key we reuse it by copying it into the requested outputDir under
the expected `segment_0001.wav` name (so resuming a project / re-running a step
is fast and deterministic).

We ALWAYS copy. The module said "we copy rather than symlink by default" while
the code tried ``symlink_to`` first and only fell back to a copy when that
failed — which on macOS/Linux made every cache-hit ``segment_NNNN.wav`` in a
project directory a link into this cache. Settings shows the cache as a
"Temporary cache" location with a delete button, so the app invites the user to
press the button that silently orphans the audio of every previously-rendered
project. The saved bytes are not worth a project directory that is not
self-contained and behaves differently on Windows (real copies) than on macOS.

The cache is bounded (``TTS_CACHE_MAX_BYTES``, see :meth:`AudioCache.prune`):
the key includes the segment id, so without eviction it grows monotonically for
the lifetime of the install.
"""

from __future__ import annotations

import hashlib
import logging
import os
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
    """Filesystem cache living under a single directory, bounded by total bytes."""

    def __init__(self, cache_dir: str | Path, max_bytes: int = 0) -> None:
        self.cache_dir = Path(cache_dir)
        #: Byte ceiling for the whole directory; 0 (the default) disables eviction.
        self.max_bytes = max(0, int(max_bytes))
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.warning("cache dir %s not creatable; caching disabled", self.cache_dir)

    def _path_for(self, key: str) -> Path:
        return self.cache_dir / f"{key}.wav"

    def get(self, key: str) -> Path | None:
        """Return the cached WAV path for a key, or None if absent.

        A hit refreshes the entry's access time so :meth:`prune` evicts by true
        recency of USE rather than of creation — otherwise a long-running
        project's own clips would be the first to go.
        """
        p = self._path_for(key)
        if not p.is_file():
            return None
        try:
            os.utime(p, None)
        except OSError:  # read-only cache dir, or a racing prune — not fatal
            pass
        return p

    def put(self, key: str, source_wav: str | Path) -> Path:
        """Store a freshly synthesized WAV under its cache key.

        Returns the cached path. Best-effort: on failure the source is left
        untouched and the source path is returned.
        """
        dest = self._path_for(key)
        try:
            shutil.copyfile(source_wav, dest)
            logger.debug("cached %s -> %s", source_wav, dest)
        except OSError as exc:
            logger.warning("failed to cache %s: %s", source_wav, exc)
            return Path(source_wav)
        self.prune()
        return dest

    def total_bytes(self) -> int:
        """Bytes currently held by the cache (best-effort; never raises)."""
        total = 0
        try:
            for entry in self.cache_dir.glob("*.wav"):
                try:
                    total += entry.stat().st_size
                except OSError:
                    continue
        except OSError:
            return 0
        return total

    def prune(self) -> int:
        """Evict least-recently-USED entries until the cache fits `max_bytes`.

        Returns the number of files deleted. Best-effort throughout: a cache we
        cannot tidy is a disk-space problem, never a failed dub, so every error
        is swallowed. Called from :meth:`put`, i.e. once per freshly synthesized
        segment — cheap, because it stats one directory and stops early when the
        cache already fits.
        """
        if self.max_bytes <= 0:
            return 0
        try:
            entries = []
            total = 0
            for entry in self.cache_dir.glob("*.wav"):
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                entries.append((stat.st_atime, stat.st_size, entry))
                total += stat.st_size
        except OSError:
            return 0

        if total <= self.max_bytes:
            return 0

        removed = 0
        for _atime, size, entry in sorted(entries):  # oldest access first
            try:
                entry.unlink()
            except OSError:
                continue
            total -= size
            removed += 1
            if total <= self.max_bytes:
                break
        logger.info(
            "cache pruned %d file(s); now %.1f MB of %.1f MB budget",
            removed,
            total / 1e6,
            self.max_bytes / 1e6,
        )
        return removed

    def materialize(self, cached_wav: str | Path, dest_wav: str | Path) -> Path:
        """COPY a cached WAV to `dest_wav` (the expected segment filename).

        Always a real copy — see the module docstring: the symlink fast-path
        this used to attempt made a cache clear (offered right in Settings)
        silently destroy the audio of every project that had been rendered from
        a cache hit.
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

        shutil.copyfile(src, dest)
        logger.debug("copied cache %s -> %s", src, dest)
        return dest
