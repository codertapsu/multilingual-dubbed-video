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

import hashlib
import logging
import random
import threading

from . import voices
from .wavio import write_pcm16_wav

logger = logging.getLogger("vd_tts_engine.engine")


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
    """Lazy VieNeu synthesizer (v2 or v3). Thread-safe load; sequential synth."""

    name = voices.ENGINE_NAME

    def __init__(self, variant: str | None = None) -> None:
        self._variant = variant or voices.current_variant()
        self._backend = None  # the loaded vieneu.Vieneu instance
        self._lock = threading.Lock()
        self._load_error: str | None = None  # last warm-up failure, surfaced via /health

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
                    logger.info("Loading VieNeu v3-Turbo…")
                    self._backend = Vieneu()
            except Exception as exc:  # noqa: BLE001
                raise EngineUnavailable(
                    f"VieNeu SDK could not be loaded (install the VieNeu engine pack): {exc}"
                ) from exc

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
        # audibly drifts between lines.
        _pin_rng(f"{self._variant}:{voice.sdk_name}")
        audio = self._infer(clean, voice)
        _save_via_backend_or_pcm(self._backend, audio, out_path, self.sample_rate)

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
