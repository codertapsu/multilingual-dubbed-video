"""Pinned model snapshots for the GPU (PyTorch) build of VieNeu v3.

The CPU pack runs VieNeu's ONNX export; the GPU pack runs the original PyTorch
checkpoint, which needs two Hugging Face repos the SDK would otherwise fetch at
whatever revision `main` points to that day:

  * the VieNeu-TTS v3-Turbo backbone (``model.safetensors`` + tokenizer), and
  * the MOSS-Audio-Tokenizer-Nano codec, which the SDK loads with
    ``AutoModel.from_pretrained(..., trust_remote_code=True)``: that EXECUTES
    the ``.py`` files shipped in the repo. Unpinned, whoever can push to that
    repo can run code on every user's machine at its next model load.

So both are downloaded once, at a fixed commit, into the pack directory, and the
SDK is pointed at those local folders. A ``.vd-revision`` marker records which
commit a folder holds, so later loads never touch the network (the app works
offline after the first load) and a pin bump re-downloads exactly once.

Only the files the PyTorch path reads are fetched: the backbone repo also hosts
the CPU pack's ONNX graphs, a GGUF export and an ``update/`` checkpoint, about
1.8 GB this path never opens.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

logger = logging.getLogger("vd_tts_engine.pinned")

MARKER = ".vd-revision"


@dataclass(frozen=True)
class PinnedRepo:
    repo_id: str
    revision: str
    # Glob patterns passed to snapshot_download(allow_patterns=...).
    files: Sequence[str]
    # Files that must exist for the snapshot to count as complete.
    required: Sequence[str]

    @property
    def dirname(self) -> str:
        return self.repo_id.replace("/", "__")


# Commits read from the Hub API on 2026-11-07. Bump deliberately: the codec's
# revision decides which Python code runs (see module doc).
BACKBONE = PinnedRepo(
    repo_id="pnnbao-ump/VieNeu-TTS-v3-Turbo",
    revision="61b85e3d937fbbacb387714180e8182823512523",
    files=("config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"),
    required=("config.json", "model.safetensors", "tokenizer.json"),
)
CODEC = PinnedRepo(
    repo_id="OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano",
    revision="6aa02b01e445cc585582cf0ba480bc3ea6c8dd68",
    files=("*.json", "*.py", "*.safetensors"),
    required=("config.json", "modeling_moss_audio_tokenizer.py", "model-00001-of-00001.safetensors"),
)


def models_root(environ: "os._Environ[str] | dict[str, str]" = os.environ) -> Path:
    """``<pack>/models`` (VD_PACK_DIR is set by the orchestrator), else beside HF_HOME."""
    pack = environ.get("VD_PACK_DIR")
    if pack:
        return Path(pack) / "models"
    hf_home = environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home).parent / "models"
    return Path.home() / ".cache" / "vd_tts_engine" / "models"


def is_complete(dest: Path, repo: PinnedRepo) -> bool:
    """True when ``dest`` holds this exact revision with every required file."""
    try:
        if (dest / MARKER).read_text(encoding="utf-8").strip() != repo.revision:
            return False
    except OSError:
        return False
    return all((dest / name).is_file() for name in repo.required)


def ensure(
    repo: PinnedRepo,
    root: Path,
    *,
    download: Callable[..., object] | None = None,
) -> Path:
    """The local folder holding ``repo`` at its pinned revision, downloading if needed."""
    dest = root / repo.dirname
    if is_complete(dest, repo):
        return dest
    if download is None:
        from huggingface_hub import snapshot_download  # noqa: PLC0415 - lazy: heavy import

        download = snapshot_download
    logger.info("Downloading %s @ %s (pinned)…", repo.repo_id, repo.revision[:12])
    dest.mkdir(parents=True, exist_ok=True)
    (dest / MARKER).unlink(missing_ok=True)  # invalidate before touching any file
    download(
        repo_id=repo.repo_id,
        revision=repo.revision,
        allow_patterns=list(repo.files),
        local_dir=str(dest),
    )
    missing = [name for name in repo.required if not (dest / name).is_file()]
    if missing:
        raise RuntimeError(f"{repo.repo_id} @ {repo.revision[:12]} is missing {', '.join(missing)} after download")
    tmp = dest / f"{MARKER}.tmp"
    tmp.write_text(repo.revision, encoding="utf-8")
    os.replace(tmp, dest / MARKER)  # the marker is written last: present = complete
    return dest


def ensure_gpu_models(root: Path, *, download: Callable[..., object] | None = None) -> tuple[Path, Path]:
    """(backbone_dir, codec_dir) for the PyTorch path, both at their pinned commits."""
    return ensure(BACKBONE, root, download=download), ensure(CODEC, root, download=download)
