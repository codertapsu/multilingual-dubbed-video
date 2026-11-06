"""Keep each model's ONNX files and their external ``.data`` in ONE real directory.

WHY THIS EXISTS — a fresh install of the VieNeu pack stopped loading in late
2026 with:

    [ONNXRuntimeError] FAIL : External data path validation failed for
    initializer: … External data path escapes model directory.
    resolved path: …/hub/blobs/26/2611b7…  allowed directory: …/hub/blobs/8b

Nothing in this repo changed. Two upstream releases, neither pinned by the pack
(both arrive transitively through ``vieneu``), met:

* ``huggingface_hub`` 1.33 / 2.0 (2026-09-24) added a cache-wide SHARED BLOB
  STORE for Xet-backed files: ``<hub>/blobs/<2-hex>/<xet-hash>``, with each
  repo's ``blobs/<etag>`` turned into a symlink into it. Two files of the same
  repo now live in DIFFERENT shard directories.
* onnxruntime validates that an initializer's external-data file resolves
  inside the model's own directory, following symlinks.

VieNeu v3's backbone (``vieneu_prefill.onnx`` + ``vieneu_backbone_shared.data``)
and the MOSS codec (``*.onnx`` + ``*.data``) both use external data, so the
model loads its graph from one shard and its weights from another, and the
engine never comes up.

Two independent fixes, applied together:

1. ``HF_HUB_DISABLE_SHARED_BLOBS=1`` before ``huggingface_hub`` is imported, so
   new downloads use the classic per-repo layout (the orchestrator also sets it
   in the pack's environment; see engineManager ``neuralTtsEnv``).
2. :func:`unshare_repo_blobs` for caches written BEFORE the flag existed: each
   per-repo ``blobs/<etag>`` symlink is replaced by a hard link to (or a copy
   of) the file it points at. That is exactly the pre-1.33 layout, needs no
   network, and costs no disk space when the hard link succeeds.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Optional

logger = logging.getLogger("vd_tts_engine.hfcache")

DISABLE_SHARED_BLOBS_ENV = "HF_HUB_DISABLE_SHARED_BLOBS"


def disable_shared_blob_store() -> None:
    """Opt this process out of the shared store. Must run before importing hf_hub."""
    os.environ.setdefault(DISABLE_SHARED_BLOBS_ENV, "1")


def hub_dir(hf_home: Optional[str] = None) -> Optional[Path]:
    """The hub cache dir the SDK downloads into (HF_HUB_CACHE, else HF_HOME/hub)."""
    explicit = os.environ.get("HF_HUB_CACHE")
    if explicit and explicit.strip():
        return Path(explicit).expanduser()
    home = hf_home if hf_home is not None else os.environ.get("HF_HOME")
    if home and home.strip():
        return Path(home).expanduser() / "hub"
    return None


def unshare_repo_blobs(hub: Path) -> int:
    """Replace per-repo blob symlinks with real files. Returns how many changed.

    Only ``models--*/blobs/*`` entries that are SYMLINKS to an existing regular
    file are touched; regular files, dangling links and everything outside the
    per-repo blob dirs are left alone. Each replacement is atomic: the real file
    is linked/copied to a sibling temp name, then renamed over the symlink
    (rename replaces the link itself, never its target).
    """
    changed = 0
    try:
        candidates = list(hub.glob("models--*/blobs/*"))
    except OSError:
        return 0
    for blob in candidates:
        if blob.name.endswith((".incomplete", ".vd-unshare")) or not blob.is_symlink():
            continue
        target = Path(os.path.realpath(blob))
        if not target.is_file():
            continue
        tmp = blob.with_name(blob.name + ".vd-unshare")
        try:
            if tmp.exists() or tmp.is_symlink():
                tmp.unlink()
            try:
                os.link(target, tmp)
            except OSError:
                shutil.copyfile(target, tmp)
            os.replace(tmp, blob)
            changed += 1
        except OSError as exc:
            logger.warning("Could not unshare HF blob %s: %s", blob, exc)
            try:
                tmp.unlink()
            except OSError:
                pass
    if changed:
        logger.info(
            "Converted %d shared-store blob symlink(s) to real files so onnxruntime "
            "can load models with external data.",
            changed,
        )
    return changed
