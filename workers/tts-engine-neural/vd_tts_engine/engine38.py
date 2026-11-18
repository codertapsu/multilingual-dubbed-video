"""VieNeu-TTS v3-Turbo through SDK 3.8: 25 preset voices and voice cloning.

Served by the same ``vd_tts_engine`` server as the 3.0.5 engine (engine.py),
picked by ``VIENEU_VARIANT=v38`` from the ``tts-vieneu`` / ``tts-vieneu-cuda``
packs. The two run side by side on purpose: 3.8 dropped four of the ten 3.0.5
voices, including the old default, so projects made with those keep their
engine and their voices.

What 3.8 changes for us, read from the SDK source (``vieneu/v3turbo.py``):

* a voice is a 192-number speaker embedding plus reference codec codes. The
  presets ship in the package (``assets/voices_v3_turbo.json``), and the same
  two arrays come out of ``encode_reference()`` for a recording: that is voice
  cloning, torch-free on the CPU (speaker encoder, denoiser, codec encoder);
* ``Vieneu(...)`` takes ``threads`` and ``precision`` and stops ONNX Runtime's
  thread spinning itself, so the constructor patch 3.0.5 needed is gone, but
  the codec folder is still not passed through to the ONNX engine, so it is
  injected the same checked way (``_with_codec_dir``) to keep it pinned;
* ``infer_batch()`` batches every chunk of every line on the GPU, which is
  where the GPU's speed comes from (see engine.py on 3.0.5's numbers).

Sampling still draws from numpy's GLOBAL generator (``np.random.choice`` in
``onnx_runtime_lite._sample``), so lines are seeded per voice exactly like
3.0.5 (``engine._pin_rng``), under one lock with the inference.

Voices are strict: an id this engine does not have is an error, never the
default voice. A project must not change voice because an engine changed.
"""

from __future__ import annotations

import functools
import hashlib
import importlib.util
import inspect
import json
import logging
import os
import re
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import clipcache, hfcache, pinned
from .engine import (
    EngineUnavailable,
    _pin_rng,
    _save_via_backend_or_pcm,
    cuda_build_supports,
    onnx_threads,
    vieneu_device,
)

hfcache.disable_shared_blob_store()

logger = logging.getLogger("vd_tts_engine.engine38")

ENGINE_NAME = "vieneu"
VARIANT = "v38"
LANGUAGE = "vi-VN"
SAMPLE_RATE = 48_000
# Lines per GPU batch; requests from the orchestrator carry this many when
# /health says "cuda" (NEURAL_TTS_GPU_UNITS_PER_REQUEST).
GPU_BATCH_LINES = 24
# The speaker embedding size of v3-Turbo's update architecture.
SPEAKER_DIM = 192
# The engine trims a reference to its first 8 s of speech (prepare_reference).
REFERENCE_MAX_MS = 8_000

ID_PREFIX = "vieneu38-"
_GENDER = {"nữ": "female", "nam": "male", "female": "female", "male": "male"}
_ACCENT = {"Bắc": "north", "Trung": "central", "Nam": "south"}


def slug(name: str) -> str:
    """"Hải Đăng" -> "hai-dang": the catalog's id rule (scripts/gen-voice-catalog.mjs)."""
    folded = unicodedata.normalize("NFD", name)
    folded = "".join(c for c in folded if not unicodedata.category(c).startswith("M"))
    folded = folded.replace("đ", "d").replace("Đ", "D").lower()
    return re.sub(r"[^a-z0-9]+", "-", folded).strip("-")


@dataclass(frozen=True)
class Voice38:
    id: str
    sdk_name: str
    gender: str | None = None
    accent: str | None = None
    style: str | None = None
    featured: int | None = None
    recommended: bool = False

    @property
    def display_name(self) -> str:
        return self.sdk_name


def _sdk_voices_file() -> Path | None:
    """``vieneu/assets/voices_v3_turbo.json`` of the installed SDK, found without importing it."""
    try:
        spec = importlib.util.find_spec("vieneu")
    except (ImportError, ValueError):
        return None
    for root in (spec.submodule_search_locations or []) if spec else []:
        path = Path(root) / "assets" / "voices_v3_turbo.json"
        if path.is_file():
            return path
    return None


def parse_voices(data: dict[str, Any]) -> list[Voice38]:
    """The SDK's preset table as voices, editors' picks first. Pure."""
    default = data.get("default_voice")
    out: list[Voice38] = []
    for name, v in (data.get("presets") or {}).items():
        featured = v.get("featured")
        out.append(
            Voice38(
                id=ID_PREFIX + slug(name),
                sdk_name=name,
                gender=_GENDER.get(str(v.get("gender", "")).strip()),
                accent=_ACCENT.get(str(v.get("region", "")).strip()),
                style=v.get("style") or None,
                featured=featured if isinstance(featured, int) and not isinstance(featured, bool) else None,
                recommended=name == default,
            )
        )
    out.sort(key=lambda x: (x.featured is None, x.featured or 0, x.sdk_name))
    return out


@functools.lru_cache(maxsize=1)
def sdk_voices() -> tuple[Voice38, ...]:
    path = _sdk_voices_file()
    if path is None:
        return ()
    try:
        return tuple(parse_voices(json.loads(path.read_text(encoding="utf-8"))))
    except (OSError, ValueError) as exc:
        logger.warning("Could not read the VieNeu voice table %s: %s", path, exc)
        return ()


@functools.lru_cache(maxsize=1)
def _sdk_version() -> str:
    try:
        from importlib.metadata import version  # noqa: PLC0415

        return version("vieneu")
    except Exception:  # noqa: BLE001
        return "unknown"


def vieneu_precision(environ: "os._Environ[str] | dict[str, str]" = os.environ) -> str:
    """CPU graph precision: fp32 (default, best quality) or int8 (VIENEU_PRECISION)."""
    raw = str(environ.get("VIENEU_PRECISION", "")).strip().lower()
    return "int8" if raw == "int8" else "fp32"


class UnknownVoice(ValueError):
    """The request names a voice this engine does not have."""


@dataclass(frozen=True)
class VoiceRef:
    """A cloned voice: the enrollment file the orchestrator made, and its hash."""

    file: str
    fingerprint: str


def read_enrollment(path: str) -> dict[str, Any]:
    """Load an enrollment written by :func:`write_enrollment` (never pickles)."""
    import numpy as np  # noqa: PLC0415

    with np.load(path, allow_pickle=False) as z:
        emb = np.asarray(z["speaker_emb"], dtype=np.float32).reshape(-1)
        codes = np.asarray(z["codes"], dtype=np.int64) if "codes" in z.files else None
    if emb.shape != (SPEAKER_DIM,) or not emb.any():
        raise UnknownVoice(f"{path} is not a VieNeu voice (speaker embedding {emb.shape})")
    if codes is not None and codes.ndim != 2:
        raise UnknownVoice(f"{path} is not a VieNeu voice (reference codes {codes.shape})")
    return {"speaker_emb": emb, "codes": codes}


def enrollment_fingerprint(speaker_emb: Any, codes: Any) -> str:
    """sha256 over the voice data itself, so it names the voice, not the file. Pure."""
    import numpy as np  # noqa: PLC0415

    h = hashlib.sha256(b"vieneu38-voice/1")
    emb = np.ascontiguousarray(np.asarray(speaker_emb, dtype=np.float32).reshape(-1))
    h.update(str(emb.shape).encode())
    h.update(emb.tobytes())
    if codes is not None:
        c = np.ascontiguousarray(np.asarray(codes, dtype=np.int64))
        h.update(str(c.shape).encode())
        h.update(c.tobytes())
    return h.hexdigest()


def write_enrollment(out_path: str, speaker_emb: Any, codes: Any) -> str:
    """Write the voice data atomically (``.npz``); returns its fingerprint."""
    import numpy as np  # noqa: PLC0415

    dest = Path(out_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.stem}.{os.getpid()}.partial.npz")
    arrays = {"speaker_emb": np.asarray(speaker_emb, dtype=np.float32).reshape(-1)}
    if codes is not None:
        arrays["codes"] = np.asarray(codes, dtype=np.int64)
    try:
        np.savez(tmp, **arrays)
        clipcache.replace_with_retry(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)
    return enrollment_fingerprint(arrays["speaker_emb"], arrays.get("codes"))


def _with_codec_dir(codec_dir: str) -> bool:
    """Make the SDK's ONNX engine read the codec from our pinned folder.

    ``OnnxV3LiteEngine`` takes ``codec_dir`` but ``V3TurboVieNeuTTS`` never passes
    it, so without this the codec comes from the Hub's ``main``. Checked, not
    assumed: if a future SDK drops the parameter nothing is patched and the log
    says why (the engine still works, unpinned).
    """
    try:
        from vieneu._v3_turbo_engine import onnx_runtime_lite as orl  # type: ignore
    except Exception as exc:  # noqa: BLE001
        logger.warning("Pinned codec not applied (SDK layout changed: %s).", exc)
        return False
    cls = getattr(orl, "OnnxV3LiteEngine", None)
    if cls is None or "codec_dir" not in inspect.signature(cls.__init__).parameters:
        logger.warning("Pinned codec not applied (no OnnxV3LiteEngine(codec_dir=...)).")
        return False
    if getattr(cls, "_vd_codec_dir", None) is None:
        original = cls.__init__

        @functools.wraps(original)
        def __init__(self, *args, **kwargs):  # noqa: ANN001, N807
            if not kwargs.get("codec_dir"):
                kwargs["codec_dir"] = type(self)._vd_codec_dir
            return original(self, *args, **kwargs)

        cls.__init__ = __init__
    cls._vd_codec_dir = codec_dir
    return True


class VieNeu38Engine:
    """Lazy VieNeu 3.8 synthesizer. Thread-safe load; one inference at a time.

    ``_synth_lock`` serializes seeding and inference for the same reason as
    engine.VieNeuEngine: the sampling RNG is process-global.
    """

    name = ENGINE_NAME
    variant = VARIANT
    sample_rate = SAMPLE_RATE
    supports_cloning = True

    def __init__(self) -> None:
        self._backend: Any = None
        self._lock = threading.Lock()
        self._synth_lock = threading.Lock()
        self._load_error: str | None = None
        self._device: str | None = None
        self._device_name: str | None = None
        self._device_note: str | None = None
        self._precision: str | None = None

    # ---- state ---------------------------------------------------------------

    @property
    def device(self) -> str | None:
        return self._device

    @property
    def device_name(self) -> str | None:
        return self._device_name

    @property
    def device_note(self) -> str | None:
        return self._device_note

    @property
    def load_error(self) -> str | None:
        return self._load_error

    @property
    def precision(self) -> str | None:
        return self._precision

    def available(self) -> bool:
        if self._backend is not None:
            return True
        try:
            return importlib.util.find_spec("vieneu") is not None
        except Exception:  # noqa: BLE001
            return False

    def loaded(self) -> bool:
        return self._backend is not None

    def sdk_version(self) -> str:
        return _sdk_version()

    # ---- voices --------------------------------------------------------------

    def voices(self, language: str | None = None) -> list[Voice38]:
        if language and language.split("-")[0].split("_")[0].lower() != "vi":
            return []
        return list(sdk_voices())

    def _preset(self, voice_id: str | None) -> Voice38:
        presets = sdk_voices()
        if not presets:
            raise EngineUnavailable("The VieNeu 3.8 voice table is missing (install the VieNeu-TTS 3.8 engine pack).")
        if not voice_id:
            return next((v for v in presets if v.recommended), presets[0])
        vid = voice_id.strip().split(":", 1)[-1].strip()
        hit = next((v for v in presets if v.id == vid), None)
        if hit is None:
            raise UnknownVoice(f"VieNeu 3.8 has no voice \"{voice_id}\".")
        return hit

    def validate_voice(self, voice_id: str | None, voice_ref: VoiceRef | None = None) -> None:
        """Raise UnknownVoice before any work when a request names a voice we lack."""
        if voice_ref is not None:
            if not Path(voice_ref.file).is_file():
                raise UnknownVoice(f"The cloned voice file is missing: {voice_ref.file}")
            return
        if sdk_voices():  # an engine without its SDK fails later, per line
            self._preset(voice_id)

    def _voice_key(self, voice_id: str | None, voice_ref: VoiceRef | None) -> str:
        """What identifies the voice in clip keys and seeds: the preset's name,
        or the cloned voice's fingerprint (never its name, so a rename keeps
        every clip and a re-recording redoes them)."""
        if voice_ref is not None:
            return f"profile:{voice_ref.fingerprint}"
        return self._preset(voice_id).sdk_name

    def clip_key(self, text: str, voice_id: str | None, voice_ref: VoiceRef | None = None) -> str:
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")
        return clipcache.clip_key(VARIANT, self._voice_key(voice_id, voice_ref), clean, _sdk_version())

    # ---- loading -------------------------------------------------------------

    def warmup(self) -> None:
        try:
            self._ensure_loaded()
            self._load_error = None
        except Exception as exc:  # noqa: BLE001
            self._load_error = str(exc)
            raise

    def _ensure_loaded(self) -> None:
        if self._backend is not None:
            return
        with self._lock:
            if self._backend is not None:
                return
            hub = hfcache.hub_dir()
            if hub is not None:
                hfcache.unshare_repo_blobs(hub)
            try:
                from vieneu import Vieneu  # type: ignore
            except Exception as exc:  # noqa: BLE001
                raise EngineUnavailable(
                    f"VieNeu SDK could not be loaded (install the VieNeu-TTS 3.8 engine pack): {exc}"
                ) from exc
            root = pinned.models_root()
            if vieneu_device() == "cuda":
                try:
                    self._backend = self._load_cuda(Vieneu, root)
                    return
                except Exception as exc:  # noqa: BLE001
                    # A GPU pack must never be worse than the CPU one.
                    self._device_note = f"GPU unavailable, using the CPU instead: {exc}"
                    logger.warning("VieNeu 3.8: %s", self._device_note)
            self._backend = self._load_cpu(Vieneu, root)

    def _load_cpu(self, factory: Any, root: Path) -> Any:
        precision = vieneu_precision()
        repo = pinned.ensure(pinned.V38_ONNX[precision], root)
        codec = pinned.ensure(pinned.CODEC_ONNX, root)
        _with_codec_dir(str(codec))
        threads = onnx_threads()
        logger.info("Loading VieNeu 3.8 (ONNX %s, %d threads)…", precision, threads)
        backend = factory(
            mode="v3turbo",
            backbone_repo=str(repo),
            backend="onnx",
            device="cpu",
            onnx_dir=str(repo / pinned.V38_ONNX_SUBFOLDER[precision]),
            precision=precision,
            threads=threads,
        )
        self._device, self._precision = "cpu", precision
        return backend

    def _load_cuda(self, factory: Any, root: Path) -> Any:
        import torch  # noqa: PLC0415 - only the GPU pack's venv has torch

        if not torch.cuda.is_available():
            raise RuntimeError(
                f"PyTorch {torch.__version__} (CUDA {torch.version.cuda}) found no usable NVIDIA GPU; "
                "the most common cause is a graphics driver older than this build needs"
            )
        name = torch.cuda.get_device_name(0)
        major, minor = torch.cuda.get_device_capability(0)
        if not cuda_build_supports((major, minor), torch.cuda.get_arch_list()):
            raise RuntimeError(
                f"{name} (sm_{major}{minor}) is not supported by this PyTorch build "
                f"(it has kernels for {', '.join(torch.cuda.get_arch_list())})"
            )
        backbone = pinned.ensure(pinned.V38_TORCH, root)
        codec = pinned.ensure(pinned.CODEC, root)
        logger.info("Loading VieNeu 3.8 on %s (sm_%d%d, PyTorch %s)…", name, major, minor, torch.__version__)
        backend = factory(
            mode="v3turbo",
            backbone_repo=str(backbone),
            model_subfolder="update",
            moss_tokenizer=str(codec),
            backend="pytorch",
            device="cuda",
            max_batch_size=GPU_BATCH_LINES,
        )
        self._device, self._device_name = "cuda", name
        return backend

    # ---- synthesis -----------------------------------------------------------

    def _voice_arg(self, voice_id: str | None, voice_ref: VoiceRef | None) -> Any:
        if voice_ref is not None:
            return read_enrollment(voice_ref.file)
        return self._preset(voice_id).sdk_name

    def synth_many(
        self,
        texts: list[str],
        out_paths: list[str],
        voice_id: str | None,
        speed: float,  # noqa: ARG002 - natural rate; alignment stretches
        voice_ref: VoiceRef | None = None,
    ) -> list[BaseException | None]:
        """Synthesize several lines in one voice; one error (or None) per line."""
        self._ensure_loaded()
        voice = self._voice_arg(voice_id, voice_ref)
        key = self._voice_key(voice_id, voice_ref)
        cleaned = [(t or "").strip() for t in texts]
        if self._device == "cuda" and sum(1 for t in cleaned if t) > 1:
            try:
                return self._synth_batch(cleaned, out_paths, voice, key)
            except Exception as exc:  # noqa: BLE001 - e.g. out of GPU memory
                logger.warning("Batched GPU synthesis failed (%s); synthesizing these lines one by one.", exc)
        errors: list[BaseException | None] = []
        for text, out_path in zip(cleaned, out_paths):
            try:
                if not text:
                    raise ValueError("empty text")
                with self._synth_lock:
                    _pin_rng(f"{VARIANT}:{key}")
                    audio = self._backend.infer(text, voice=voice)
                    _save_via_backend_or_pcm(self._backend, audio, out_path, SAMPLE_RATE)
                errors.append(None)
            except Exception as exc:  # noqa: BLE001 - reported per line
                errors.append(exc)
        return errors

    def _synth_batch(self, texts: list[str], out_paths: list[str], voice: Any, key: str) -> list[BaseException | None]:
        errors: list[BaseException | None] = [None if t else ValueError("empty text") for t in texts]
        todo = [i for i, t in enumerate(texts) if t]
        with self._synth_lock:
            _pin_rng(f"{VARIANT}:{key}")
            waves = self._backend.infer_batch([texts[i] for i in todo], voice=voice, batch_size=GPU_BATCH_LINES)
            for i, audio in zip(todo, waves):
                try:
                    _save_via_backend_or_pcm(self._backend, audio, out_paths[i], SAMPLE_RATE)
                except Exception as exc:  # noqa: BLE001
                    errors[i] = exc
        return errors

    # ---- cloning -------------------------------------------------------------

    def enroll(self, reference_path: str, out_path: str, denoise: bool = True) -> dict[str, Any]:
        """Make a cloned voice from a reference clip; writes ``out_path`` (.npz)."""
        self._ensure_loaded()
        if not Path(reference_path).is_file():
            raise FileNotFoundError(reference_path)
        with self._synth_lock:
            speaker_emb, codes = self._backend.encode_reference(reference_path, denoise=denoise)
        fingerprint = write_enrollment(out_path, speaker_emb, codes)
        frames = int(getattr(codes, "shape", (0,))[0]) if codes is not None else 0
        return {"fingerprint": fingerprint, "engineVersion": _sdk_version(), "codeFrames": frames}
