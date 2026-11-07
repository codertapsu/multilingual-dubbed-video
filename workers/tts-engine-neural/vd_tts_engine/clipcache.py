"""Content-addressed clip reuse + atomic clip writes for the neural engine.

WHY THIS EXISTS: a 21-minute dub (330 lines grouped into 120 utterances) failed
step 6 twice with "Neural TTS engine did not respond within 1800000ms". The
engine had NOT hung: it synthesized steadily, and its clips kept landing for 19
minutes after the orchestrator gave up, until all 120 were on disk. Then the
retry threw that work away and started from clip one, because nothing recorded
which finished clip belonged to which line. On a CPU engine that is the
difference between a retry that resumes and one that can never finish.

So every clip is also stored under a key derived from everything that decides
its audio (variant, voice, text, SDK version). A request whose clip is already
in the cache is answered by copying it into place: no inference. The synthesis
is deterministic (engine.py pins the sampling RNG per voice), so a reused clip
is what re-synthesizing would have produced anyway.

The key deliberately leaves out WHERE the clip was made. The CPU pack (ONNX)
and the GPU pack (PyTorch) run the same checkpoint with the same voice token and
seed, so their takes differ only by float rounding: both are a finished line in
that voice. Keying on the backend would make someone who installs the GPU pack
halfway through a CPU dub pay for every line again.

The cache lives inside the request's output directory (``.vieneu-cache/``), so
a project stays self-contained and the cache is deleted with the project. Clips
are COPIED out of it, never hard-linked: the bundled Piper worker writes its
per-line clips in place, so a shared inode would let a Piper re-dub silently
overwrite a cached VieNeu take.

Every write is atomic (``<name>.partial.wav`` then rename), the same rule as
the media worker: a killed engine must never leave a truncated clip that a later
run trusts. The partial keeps the ``.wav`` extension because soundfile picks the
format from it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Callable

CACHE_DIRNAME = ".vieneu-cache"
# Bump to invalidate every cached clip when synthesis changes in a way the key
# below cannot see (e.g. a new RNG-pinning scheme).
CACHE_FORMAT = 1
# A RIFF/WAVE header alone is 44 bytes; anything that small holds no audio.
_MIN_WAV_BYTES = 45

# Windows refuses to replace a file while another handle is open on it (the
# studio preview streaming a clip, Defender scanning a fresh one) with
# PermissionError, which the other handle releases within milliseconds. Same
# schedule as the orchestrator's renameReplacing (src/fsRename.ts).
_RETRY_DELAYS_S = (0.01, 0.02, 0.04, 0.08, 0.16, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25)


def clip_key(variant: str, voice_name: str, text: str, sdk_version: str) -> str:
    """sha256 over everything that determines a clip's audio. Pure."""
    payload = json.dumps([CACHE_FORMAT, variant, voice_name, text, sdk_version], ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cache_dir(out_dir: Path) -> Path:
    return out_dir / CACHE_DIRNAME


def cached_clip(out_dir: Path, key: str) -> Path:
    return cache_dir(out_dir) / f"{key}.wav"


def lookup(out_dir: Path, key: str) -> Path | None:
    """The cached clip for ``key``, or None (missing, or too small to be audio)."""
    p = cached_clip(out_dir, key)
    try:
        return p if p.stat().st_size >= _MIN_WAV_BYTES else None
    except OSError:
        return None


def partial_for(final: Path) -> Path:
    """``<dir>/<stem>.<random>.partial.wav``: unique, same dir, real extension."""
    return final.with_name(f"{final.stem}.{uuid.uuid4().hex[:8]}.partial{final.suffix}")


def replace_with_retry(
    src: Path,
    dst: Path,
    *,
    replace: Callable[[str, str], None] = os.replace,
    sleep: Callable[[float], None] = time.sleep,
    platform: str = sys.platform,
) -> None:
    """``os.replace`` that waits out Windows' transient "target in use" errors."""
    delays = _RETRY_DELAYS_S if platform == "win32" else ()
    for attempt in range(len(delays) + 1):
        try:
            replace(str(src), str(dst))
            return
        except PermissionError:
            if attempt >= len(delays):
                raise
            sleep(delays[attempt])


def publish(partial: Path, final: Path) -> None:
    """Move a finished partial into place; remove it if that fails."""
    try:
        replace_with_retry(partial, final)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def materialize(src: Path, dest: Path) -> None:
    """Atomically put a copy of ``src`` at ``dest``."""
    tmp = partial_for(dest)
    try:
        shutil.copyfile(src, tmp)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    publish(tmp, dest)


def write_atomically(dest: Path, write: Callable[[Path], None]) -> None:
    """Run ``write(partial)`` and publish the result at ``dest`` only on success."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = partial_for(dest)
    try:
        write(tmp)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    publish(tmp, dest)
