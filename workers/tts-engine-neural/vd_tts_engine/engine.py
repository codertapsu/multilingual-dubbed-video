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

import logging
import threading

from . import voices
from .wavio import write_pcm16_wav

logger = logging.getLogger("vd_tts_engine.engine")

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
