"""VieNeu-TTS synthesis (v2 or v3) via the `vieneu` PyPI package.

The variant is chosen by the engine pack through the ``VIENEU_VARIANT`` env var:

  - "v3" (default): VieNeu-TTS v3-Turbo — 48 kHz, torch-free ONNX. Loaded with a
    bare ``Vieneu()`` (its default engine on vieneu>=3); preset voices addressed
    by display name via ``infer(voice="Ngọc Lan")``.
  - "v2": VieNeu-TTS v2 (standard) — 24 kHz, GGUF backbone + NeuCodec. Loaded with
    ``Vieneu(mode="standard")`` (or a bare ``Vieneu()`` on vieneu 2.x, where
    standard is the default); reference voices addressed via
    ``get_preset_voice(id)`` -> ``infer(voice=voice_data)``.

The `vieneu` SDK is imported LAZILY so this module loads (and /health + /voices
work) even before the engine pack's venv has it; ``synth()`` then raises
``EngineUnavailable`` and the caller writes placeholder silence. The SDK manages
its own model download (into HF_HOME, which the orchestrator points at the pack
dir) on first use.
"""

from __future__ import annotations

import functools
import hashlib
import inspect
import logging
import os
import random
import threading

from . import clipcache, hfcache, pinned, voices
from .wavio import write_pcm16_wav

# Before anything can import huggingface_hub (the SDK does, lazily, on load):
# its shared blob store splits a model's .onnx and .data across directories,
# which onnxruntime refuses to load. See hfcache.py.
hfcache.disable_shared_blob_store()

logger = logging.getLogger("vd_tts_engine.engine")

# ONNX Runtime intra-op threads for the v3 CPU engine.
#
# The SDK never sets this (Vieneu() does not forward a `threads` argument), so
# every session ran on ONNX Runtime's default pool, and that default was the
# slowest configuration measured. VieNeu v3 decodes autoregressively: thousands
# of tiny ONNX calls per line with numpy sampling in between, so extra threads
# add only synchronisation, and the pool's idle threads SPIN between calls,
# stealing CPU from the Python side. Real-time factor (seconds of compute per
# second of speech; lower is faster), i5-13400F (6P + 4E cores), three lines
# from a real dub, fixed seed so every run synthesizes identical audio:
#
#     threads    default  16    10    8     6     4     3     2     1
#     RTF        5.29     8.55  5.43  4.37  3.15  2.02  1.35  0.97  1.28
#
# The default reproduced the failed dub exactly (~5.2 observed): 48 min of
# compute for 9 min of speech, against a 30-min request budget. Two threads is
# 5.4x faster and beats real time. Disabling spinning flattens the curve (RTF
# 1.13-1.25 at 2-10 threads) but is still slower than 2 spinning threads, and
# running several engines side by side only reached RTF 0.63 combined at 1.4 GB
# RAM each (a shared memory-bandwidth ceiling): not worth a process pool.
# VIENEU_ONNX_THREADS overrides it, for measuring other hardware.
_DEFAULT_ONNX_THREADS = 2

# The GPU pack (PyTorch on CUDA). One line at a time is SLOWER on the GPU than
# the tuned CPU path: each audio frame is ~270 tiny kernel launches from Python,
# so an RTX 3050 sat at RTF 1.36 (vs 0.97 for 2-thread ONNX). Generating lines
# TOGETHER, through the SDK's own batched serving engine, amortises that:
#
#     lines per batch     1      6      12     24
#     RTF, torch cu126    1.36   0.48   0.40   0.34    (502-571 MB of VRAM)
#     RTF, torch cu130     -      -     0.20   0.18    (same card, same lines)
#
# measured on 24 real utterances from a dub (the pack installs cu130 wherever
# the card and driver allow; see uvRequirements.torchCudaBuildFor). The tuned
# CPU path did the same 24 lines at RTF 0.66. The SDK's CUDA-graph mode looked
# faster still (RTF 0.16) but needs repetition_penalty=1.0, and without the
# penalty the model often never stops: 12 short lines came back as 69-111 s of
# audio instead of 28. So: batches of 24 with the SDK's default sampling.
_GPU_BATCH_LINES = 24
# The SDK's infer() defaults, so a batched line matches a single-line one.
_V3_SAMPLING = {"temperature": 0.8, "top_k": 25, "top_p": 0.95, "repetition_penalty": 1.2, "max_new_frames": 300}
_V3_MAX_CHARS = 256  # infer() splits longer text into chunks of this size...
_V3_JOIN_SILENCE = 0.15  # ...and joins them with this many seconds of pause


def onnx_threads(environ: "os._Environ[str] | dict[str, str]" = os.environ, cpu_count: int | None = None) -> int:
    """Thread count for the v3 ONNX sessions: the env override, else 2. Pure."""
    raw = str(environ.get("VIENEU_ONNX_THREADS", "")).strip()
    if raw:
        try:
            n = int(raw)
        except ValueError:
            n = 0
        if n >= 1:
            return n
        logger.warning("Ignoring VIENEU_ONNX_THREADS=%r (want a positive integer).", raw)
    cores = cpu_count if cpu_count is not None else (os.cpu_count() or 1)
    return max(1, min(_DEFAULT_ONNX_THREADS, cores))


def _limit_onnx_threads(threads: int) -> bool:
    """Make the SDK's v3 ONNX engine default to ``threads`` intra-op threads.

    The SDK exposes no option, so this wraps the engine class's constructor and
    fills in its own ``threads`` parameter when the caller passed none. It
    checks rather than assumes: if a future SDK moves the class or drops that
    parameter, nothing is patched, the engine still loads (at the SDK's
    default speed), and the log says why. Returns True when the limit applies.
    """
    try:
        from vieneu._v3_turbo_engine import onnx_runtime_lite as orl  # type: ignore
    except Exception as exc:  # noqa: BLE001
        logger.warning("VieNeu ONNX thread limit not applied (SDK layout changed: %s); using its default.", exc)
        return False
    cls = getattr(orl, "OnnxV3LiteEngine", None)
    if cls is None or "threads" not in inspect.signature(cls.__init__).parameters:
        logger.warning("VieNeu ONNX thread limit not applied (no OnnxV3LiteEngine(threads=...)); using its default.")
        return False
    if getattr(cls, "_vd_onnx_threads", None) is not None:
        cls._vd_onnx_threads = threads  # already wrapped; just update the value
        return True
    original = cls.__init__

    @functools.wraps(original)
    def __init__(self, *args, **kwargs):  # noqa: ANN001, N807
        if not kwargs.get("threads"):
            kwargs["threads"] = type(self)._vd_onnx_threads
        return original(self, *args, **kwargs)

    cls.__init__ = __init__
    cls._vd_onnx_threads = threads
    return True


def cuda_build_supports(capability: tuple[int, int], arch_list: list[str]) -> bool:
    """Can a PyTorch build with these kernels run on a GPU of this capability? Pure.

    The arch list is not a lookup table, which is what the first version of this
    check got wrong. The cu126 build lists sm_86 and sm_90 but no sm_89, yet the
    whole RTX 40 series (sm_89) runs it: CUDA binaries (sm_XY) run on any GPU of
    the SAME major generation with an equal or higher minor version, and PTX
    (compute_XY) is compiled by the driver for any newer GPU. What does NOT run:
    a newer major generation with no PTX to compile (RTX 50 / sm_120 on cu126).
    """
    major, minor = capability
    for arch in arch_list:
        kind, _, digits = arch.partition("_")
        if not digits.isdigit() or len(digits) < 2:
            continue
        a_major, a_minor = int(digits[:-1]), int(digits[-1])
        if kind == "sm" and a_major == major and a_minor <= minor:
            return True
        if kind == "compute" and (a_major, a_minor) <= (major, minor):
            return True
    return False


def vieneu_device(environ: "os._Environ[str] | dict[str, str]" = os.environ) -> str:
    """Where the pack wants v3 to run: "cuda" (the GPU pack) or "cpu". Pure.

    The orchestrator sets VIENEU_DEVICE from the pack's catalog `accel`. Anything
    unrecognized means CPU: the ONNX path works everywhere.
    """
    raw = str(environ.get("VIENEU_DEVICE", "")).strip().lower()
    return "cuda" if raw == "cuda" else "cpu"


@functools.lru_cache(maxsize=1)
def _sdk_version() -> str:
    """The installed vieneu version (part of every clip-cache key)."""
    try:
        from importlib.metadata import version  # noqa: PLC0415

        return version("vieneu")
    except Exception:  # noqa: BLE001
        return "unknown"


def _pin_rng(voice_key: str) -> None:
    """Pin every RNG the SDK may sample from to a per-voice seed.

    VieNeu v3 samples its speech tokens with ``np.random.choice`` at
    temperature 0.8 from the GLOBAL, unseeded numpy RNG (and exposes no seed
    parameter), so every utterance re-rolls the delivery — across a whole dub
    the same preset audibly drifts, which users hear as "two different
    speakers". Re-seeding per synthesis call from the VOICE id removes the
    per-utterance dice roll (same voice -> same sampling stream) while
    different voices keep distinct streams. Same trick OmniVoice uses
    (fixed per-voice seed) for cross-segment speaker consistency.
    """
    seed = int.from_bytes(hashlib.sha256(voice_key.encode("utf-8")).digest()[:4], "big") & 0x7FFFFFFF
    random.seed(seed)
    try:  # numpy is a hard dep of the vieneu SDK, but guard anyway
        import numpy as np  # noqa: PLC0415

        np.random.seed(seed)
    except Exception:  # noqa: BLE001
        pass
    try:  # torch only exists in the v2 (GGUF/NeuCodec) venv
        import torch  # noqa: PLC0415

        torch.manual_seed(seed)
    except Exception:  # noqa: BLE001
        pass

# Native output rate per variant (the SDK's own save() uses it; we mirror it for
# the silent-fallback clip so placeholder audio matches).
_SAMPLE_RATE = {"v2": 24000, "v3": 48000}


class EngineUnavailable(RuntimeError):
    """Raised when the vieneu SDK/weights aren't present; caller falls back."""


class VieNeuEngine:
    """Lazy VieNeu synthesizer (v2 or v3). Thread-safe load; sequential synth.

    "Sequential synth" was a claim, not a fact: only the LOAD was locked, while
    ``/synthesize-segments`` is a plain ``def`` route, so FastAPI dispatches it
    to the threadpool and two overlapping requests (the editor allows concurrent
    actions on different segments) genuinely ran ``_infer`` at the same time on
    one ONNX session. Worse, :func:`_pin_rng` seeds the PROCESS-GLOBAL
    generators, so concurrent calls interleave their seeds and pollute each
    other's sampling stream — reintroducing, non-deterministically, exactly the
    cross-segment voice drift ``_pin_rng`` exists to remove. ``_synth_lock``
    below makes the docstring true.
    """

    name = voices.ENGINE_NAME

    def __init__(self, variant: str | None = None) -> None:
        self._variant = variant or voices.current_variant()
        self._backend = None  # the loaded vieneu.Vieneu instance
        self._lock = threading.Lock()
        # Distinct from _lock (which guards loading): serializes seeding +
        # inference + save, which share global RNG state and one model session.
        self._synth_lock = threading.Lock()
        self._load_error: str | None = None  # last warm-up failure, surfaced via /health
        # Where synthesis actually runs, once loaded: "cuda" or "cpu", the GPU's
        # name, and (when a GPU pack had to fall back) why. Surfaced via /health.
        self._device: str | None = None
        self._device_name: str | None = None
        self._device_note: str | None = None
        # The SDK's batched serving engine, on the GPU path only (synth_many).
        self._batcher: object | None = None

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
    def variant(self) -> str:
        return self._variant

    @property
    def sample_rate(self) -> int:
        return _SAMPLE_RATE.get(self._variant, 48000)

    def available(self) -> bool:
        """Best-effort: True if the vieneu SDK can be imported in this venv.

        Does NOT cache a prior failure: the venv may be (re)installed in the
        background, and /health should reflect that without a worker restart.
        """
        if self._backend is not None:
            return True
        try:
            import importlib.util as _u  # noqa: PLC0415

            return _u.find_spec("vieneu") is not None
        except Exception:
            return False

    def loaded(self) -> bool:
        """True once the model is RESIDENT (warm) — synthesis will be fast.

        Distinct from ``available()`` (SDK importable): the model is downloaded
        (first use) + loaded lazily, which is the expensive part. The orchestrator
        waits for this before a long run so the one-time load isn't charged to the
        /synthesize-segments timeout budget.
        """
        return self._backend is not None

    @property
    def load_error(self) -> str | None:
        """Last warm-up/load failure message (so callers fail fast vs. timing out)."""
        return self._load_error

    def warmup(self) -> None:
        """Eagerly load the model (downloading it on first use). Records the failure
        for /health and re-raises so the background warm-up can log it."""
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
            # Repair a cache written while the shared blob store was on (every
            # fresh install from 2026-09-24 until this fix): no network, and a
            # no-op on an already-flat cache.
            hub = hfcache.hub_dir()
            if hub is not None:
                hfcache.unshare_repo_blobs(hub)
            try:
                from vieneu import Vieneu  # type: ignore

                if self._variant == "v2":
                    logger.info("Loading VieNeu v2 (standard)…")
                    try:
                        self._backend = Vieneu(mode="standard")
                    except TypeError:
                        # vieneu 2.x: `standard` (v2) is the default; no mode arg.
                        self._backend = Vieneu()
                else:
                    if vieneu_device() == "cuda":
                        try:
                            self._backend = self._load_v3_cuda(Vieneu)
                            return
                        except Exception as exc:  # noqa: BLE001
                            # A GPU pack must never be WORSE than the CPU one: an
                            # old driver, a card the build has no kernels for, or
                            # an exhausted GPU all land here, and the same venv
                            # carries the ONNX path below.
                            self._device_note = f"GPU unavailable, using the CPU instead: {exc}"
                            logger.warning("VieNeu v3: %s", self._device_note)
                    threads = onnx_threads()
                    if _limit_onnx_threads(threads):
                        logger.info("Loading VieNeu v3-Turbo (ONNX Runtime: %d intra-op threads)…", threads)
                    else:
                        logger.info("Loading VieNeu v3-Turbo…")
                    self._backend = Vieneu()
                    self._device = "cpu"
            except Exception as exc:  # noqa: BLE001
                raise EngineUnavailable(
                    f"VieNeu SDK could not be loaded (install the VieNeu engine pack): {exc}"
                ) from exc

    def _load_v3_cuda(self, vieneu_factory) -> object:  # noqa: ANN001 - the SDK's Vieneu()
        """Load the PyTorch build of v3 on the first CUDA GPU, from pinned snapshots."""
        import torch  # noqa: PLC0415 - only the GPU pack's venv has torch

        if not torch.cuda.is_available():
            raise RuntimeError(
                f"PyTorch {torch.__version__} (CUDA {torch.version.cuda}) found no usable NVIDIA GPU; "
                "the most common cause is a graphics driver older than this build needs"
            )
        name = torch.cuda.get_device_name(0)
        major, minor = torch.cuda.get_device_capability(0)
        if not cuda_build_supports((major, minor), torch.cuda.get_arch_list()):
            # Without this check an unsupported card fails on the FIRST inference
            # ("no kernel image is available"), after the model loaded, and every
            # line of the dub becomes silence.
            raise RuntimeError(
                f"{name} (sm_{major}{minor}) is not supported by this PyTorch build "
                f"(it has kernels for {', '.join(torch.cuda.get_arch_list())})"
            )
        capability = f"sm_{major}{minor}"
        backbone, codec = pinned.ensure_gpu_models(pinned.models_root())
        logger.info("Loading VieNeu v3-Turbo on %s (%s, PyTorch %s)…", name, capability, torch.__version__)
        backend = vieneu_factory(
            device="cuda", backend="pytorch", backbone_repo=str(backbone), moss_tokenizer=str(codec)
        )
        try:
            from vieneu.v3_turbo_serve.engine import V3TurboBatchEngine  # noqa: PLC0415

            self._batcher = V3TurboBatchEngine(backend.engine)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001 - still correct, just slower
            logger.warning("VieNeu batched GPU engine unavailable (%s); synthesizing one line at a time.", exc)
        self._device, self._device_name = "cuda", name
        return backend

    def clip_key(self, text: str, voice_id: str | None) -> str:
        """The clip-cache key for this text in this voice (see clipcache.py).

        Resolves the voice and cleans the text exactly as :meth:`synth` does,
        so two requests share a key iff they would synthesize the same audio.
        Raises ValueError for empty text, like :meth:`synth`.
        """
        voice = voices.resolve(self._variant, voice_id)
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")
        return clipcache.clip_key(self._variant, voice.sdk_name, clean, _sdk_version())

    def synth(self, text: str, out_path: str, voice_id: str | None, speed: float) -> None:
        """Synthesize `text` to a WAV at `out_path`. Raises on failure.

        `speed` is intentionally unused — VieNeu synthesizes at natural rate and
        the orchestrator's alignment/ffmpeg stage time-stretches to the window.
        """
        self._ensure_loaded()
        voice = voices.resolve(self._variant, voice_id)
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")

        # Deterministic per-voice sampling: without this the SDK's temperature
        # sampling re-rolls the delivery on every call and the dub's voice
        # audibly drifts between lines. The seed is process-global, so seeding
        # and inference have to be ONE critical section — see the class
        # docstring. The SDK exposes no per-call seed parameter, so serializing
        # is the only correct answer today.
        with self._synth_lock:
            _pin_rng(f"{self._variant}:{voice.sdk_name}")
            audio = self._infer(clean, voice)
            _save_via_backend_or_pcm(self._backend, audio, out_path, self.sample_rate)

    def synth_many(
        self, texts: list[str], out_paths: list[str], voice_id: str | None, speed: float
    ) -> list[BaseException | None]:
        """Synthesize several lines in one voice; one error (or None) per line.

        On the GPU the lines are generated TOGETHER (see _synth_batch_gpu): one
        line at a time leaves the card mostly idle. Elsewhere this is a loop over
        :meth:`synth`. A line that fails never stops the others.
        """
        self._ensure_loaded()
        if self._device == "cuda" and self._batcher is not None and len(texts) > 1:
            try:
                return self._synth_batch_gpu(texts, out_paths, voice_id)
            except Exception as exc:  # noqa: BLE001 - e.g. out of GPU memory
                logger.warning("Batched GPU synthesis failed (%s); synthesizing these lines one by one.", exc)
        errors: list[BaseException | None] = []
        for text, out_path in zip(texts, out_paths):
            try:
                self.synth(text, out_path, voice_id, speed)
                errors.append(None)
            except Exception as exc:  # noqa: BLE001 - reported per line
                errors.append(exc)
        return errors

    def _synth_batch_gpu(
        self, texts: list[str], out_paths: list[str], voice_id: str | None
    ) -> list[BaseException | None]:
        """Generate every line's chunks in shared GPU batches, then join per line.

        Mirrors what the SDK's own ``infer()`` does around generation, so a line
        comes out the same shape either way: split at 256 characters, phonemize
        with emotion cues, the same sampling settings, chunks joined with the
        same pause, the watermark hook applied. Only the generation loop differs,
        and that is the SDK's own batched serving engine.
        """
        from vieneu_utils.core_utils import join_audio_chunks, split_text_into_chunks  # noqa: PLC0415
        from vieneu_utils.phonemize_text import phonemize_text_with_emotions  # noqa: PLC0415

        voice = voices.resolve(self._variant, voice_id)
        ref_codes, voice_token = self._backend._resolve_v3_ref(voice.sdk_name, None, None)  # type: ignore[union-attr]
        errors: list[BaseException | None] = [None] * len(texts)
        chunks: list[tuple[int, dict]] = []  # (line index, batch request)
        for i, text in enumerate(texts):
            clean = (text or "").strip()
            parts = split_text_into_chunks(clean, max_chars=_V3_MAX_CHARS) if clean else []
            if not parts:
                errors[i] = ValueError("empty text")
                continue
            for part in parts:
                chunks.append(
                    (i, {"phonemes": phonemize_text_with_emotions(part), "ref_codes": ref_codes, "voice_token_id": voice_token})
                )
        # Similar lengths batch together: a batch runs until its longest line ends.
        order = sorted(range(len(chunks)), key=lambda k: len(chunks[k][1]["phonemes"]))
        waves: dict[int, object] = {}
        with self._synth_lock:
            _pin_rng(f"{self._variant}:{voice.sdk_name}")
            for at in range(0, len(order), _GPU_BATCH_LINES):
                picked = order[at : at + _GPU_BATCH_LINES]
                out = self._batcher.generate_batch(  # type: ignore[union-attr]
                    [chunks[k][1] for k in picked], **_V3_SAMPLING
                )
                waves.update(zip(picked, out))
            for i, out_path in enumerate(out_paths):
                if errors[i] is not None:
                    continue
                try:
                    parts = [waves[k] for k in range(len(chunks)) if chunks[k][0] == i]
                    audio = join_audio_chunks(parts, self.sample_rate, silence_p=_V3_JOIN_SILENCE, crossfade_p=0.0)
                    audio = self._backend._apply_watermark(audio)  # type: ignore[union-attr]
                    _save_via_backend_or_pcm(self._backend, audio, out_path, self.sample_rate)
                except Exception as exc:  # noqa: BLE001 - reported per line
                    errors[i] = exc
        return errors

    def _infer(self, text: str, voice: "voices.NeuralVoice") -> object:
        """Run inference for the active variant. Falls back to the default voice
        if a preset name is rejected so one stale name can't silence the dub."""
        backend = self._backend
        if self._variant == "v2":
            try:
                get_preset = getattr(backend, "get_preset_voice", None)
                if callable(get_preset):
                    return backend.infer(text, voice=get_preset(voice.sdk_name))  # type: ignore[union-attr]
                return backend.infer(text, voice=voice.sdk_name)  # type: ignore[union-attr]
            except Exception as exc:  # noqa: BLE001
                logger.warning("VieNeu v2 voice '%s' failed (%s); using the default voice.", voice.sdk_name, exc)
                return backend.infer(text)  # type: ignore[union-attr]
        # v3: preset addressed by display name.
        try:
            return backend.infer(text, voice=voice.sdk_name)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("VieNeu v3 voice '%s' failed (%s); using the default voice.", voice.sdk_name, exc)
            return backend.infer(text)  # type: ignore[union-attr]


def _save_via_backend_or_pcm(backend: object, audio: object, out_path: str, sample_rate: int) -> None:
    """Write the synthesized audio: prefer the SDK's own save (handles the rate);
    fall back to a PCM-16 writer for array-like output."""
    save = getattr(backend, "save", None)
    if callable(save):
        save(audio, out_path)
        return
    write_pcm16_wav(out_path, audio, sample_rate)
