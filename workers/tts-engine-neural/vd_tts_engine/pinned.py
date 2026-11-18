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
    # Folder name under models/, when one repo is fetched as several subsets
    # (VieNeu 3.8's fp32 and int8 CPU graphs, its PyTorch checkpoint).
    folder: str | None = None

    @property
    def dirname(self) -> str:
        return self.folder or self.repo_id.replace("/", "__")


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


# --- VieNeu through SDK 3.8 (the `vieneu-tts` packs, engine38.py) -------------
#
# 3.8 reads the "update" architecture (speaker embedding + reference codes), on
# the CPU from ONNX graphs, on the GPU from a PyTorch checkpoint, plus two files
# at the repo root that cloning needs (the speaker encoder and the reference
# denoiser). Unpinned, the SDK fetches all of them from `main` on first use and
# the codec's ONNX export from a second repo the same way. Each subset below is
# its own folder so the fp32 and int8 CPU graphs can live side by side.
V38_REVISION = "61b85e3d937fbbacb387714180e8182823512523"
_V38_ROOT_FILES = ("config.json", "tokenizer.json", "speaker_encoder.onnx", "denoiser.onnx")
_V38_GRAPHS = (
    "vieneu_prefill.onnx",
    "vieneu_decode_step.onnx",
    "vieneu_acoustic_cached.onnx",
    "vieneu_backbone_shared.data",
    "vieneu_v3_heads.npz",
    "config.json",
    "tokenizer.json",
)


def _v38_onnx(subfolder: str, folder: str) -> PinnedRepo:
    return PinnedRepo(
        repo_id="pnnbao-ump/VieNeu-TTS-v3-Turbo",
        revision=V38_REVISION,
        files=(*_V38_ROOT_FILES, f"{subfolder}/*"),
        required=(*_V38_ROOT_FILES[2:], *(f"{subfolder}/{name}" for name in _V38_GRAPHS)),
        folder=folder,
    )


# fp32 (~546 MB) is the quality default; int8 (~236 MB) is ~3x faster per frame
# but "can produce garbled audio" on CPUs without VNNI (the SDK's own warning).
V38_ONNX = {
    "fp32": _v38_onnx("onnx_update", "vieneu38-onnx-fp32"),
    "int8": _v38_onnx("onnx_int8", "vieneu38-onnx-int8"),
}
V38_ONNX_SUBFOLDER = {"fp32": "onnx_update", "int8": "onnx_int8"}
V38_TORCH = PinnedRepo(
    repo_id="pnnbao-ump/VieNeu-TTS-v3-Turbo",
    revision=V38_REVISION,
    files=(*_V38_ROOT_FILES, "special_tokens_map.json", "update/*"),
    required=(*_V38_ROOT_FILES[2:], "update/config.json", "update/model.safetensors", "update/tokenizer.json"),
    folder="vieneu38-torch",
)
# The MOSS codec's ONNX export (decoder for synthesis, encoder for cloning).
# Plain ONNX graphs: no code from this repo runs.
CODEC_ONNX = PinnedRepo(
    repo_id="OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
    revision="ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae",
    files=("*.onnx", "*.data", "*.json"),
    required=(
        "moss_audio_tokenizer_decode_full.onnx",
        "moss_audio_tokenizer_decode_shared.data",
        "moss_audio_tokenizer_decode_step.onnx",
        "moss_audio_tokenizer_encode.onnx",
        "moss_audio_tokenizer_encode.data",
        "codec_browser_onnx_meta.json",
    ),
)


# --- The preset-voice ONNX engines (presets.py) --------------------------------
# File patterns as Phase 0 ran them (2026-11-18). ZeroTTS's repo also holds
# onnx/voice_encoder.onnx, an unannounced voice encoder its vendor says was left
# out of the public release on purpose; it is deliberately not fetched.
ZEROTTS = PinnedRepo(
    repo_id="zeroweight-ai/ZeroTTS",
    revision="18d6681518a4becaed3c125ceb3c7db59905fe86",
    files=(
        "config.json",
        "tokenizer.json",
        "null_voice_emb.npy",
        "silence_frame.npy",
        "onnx/text_encoder.onnx",
        "onnx/prefix_step.onnx",
        "onnx/local_frame_decode.onnx",
        "onnx/codec/*",
        "voices/index.json",
        "voices/*/voice.npz",
        "voices/*/meta.json",
    ),
    required=(
        "config.json",
        "tokenizer.json",
        "null_voice_emb.npy",
        "onnx/text_encoder.onnx",
        "onnx/prefix_step.onnx",
        "onnx/local_frame_decode.onnx",
        "onnx/codec/moss_audio_tokenizer_decode_full.onnx",
        "voices/index.json",
        "voices/maichi/voice.npz",
    ),
)
KOKORO = PinnedRepo(
    repo_id="onnx-community/Kokoro-82M-v1.0-ONNX",
    revision="1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    files=("onnx/model.onnx", "voices/*", "config.json", "tokenizer.json", "tokenizer_config.json"),
    required=("onnx/model.onnx", "voices/af_heart.bin", "voices/zm_yunxi.bin"),
)
SUPERTONIC = PinnedRepo(
    repo_id="supertone-oss-archive/supertonic-3",
    revision="aafc6e32416a594460b32413efc49d7fe4ce6d46",
    files=("onnx/*", "voice_styles/*", "config.json", "LICENSE"),
    required=(
        "onnx/duration_predictor.onnx",
        "onnx/text_encoder.onnx",
        "onnx/vector_estimator.onnx",
        "onnx/vocoder.onnx",
        "onnx/tts.json",
        "onnx/unicode_indexer.json",
        "voice_styles/F1.json",
        "voice_styles/M5.json",
    ),
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
