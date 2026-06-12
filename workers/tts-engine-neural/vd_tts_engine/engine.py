"""VieNeu-TTS v3-Turbo synthesis, via the `vieneu` PyPI package.

v3-Turbo is an original architecture (model_type ``vieneu_v3_turbo``) that runs
torch-free on CPU via ONNX Runtime: a small speech-LLM backbone predicts
MOSS-Audio-Tokenizer-Nano codec tokens, decoded to a 48 kHz waveform. Voice
identity comes from named preset voices (no reference clip needed). Vietnamese/
English G2P is the bundled sea-g2p (Rust) — there is NO espeak-ng dependency.
Output carries an imperceptible Resemble Perth watermark (AI-audio disclosure).

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
from .wavio import NEURAL_SAMPLE_RATE, write_pcm16_wav

logger = logging.getLogger("vd_tts_engine.engine")


class EngineUnavailable(RuntimeError):
    """Raised when the vieneu SDK/weights aren't present; caller falls back."""


class VieNeuEngine:
    """Lazy VieNeu v3-Turbo synthesizer. Thread-safe load; sequential synth."""

    name = voices.ENGINE_NAME

    def __init__(self) -> None:
        self._backend = None  # the loaded vieneu.Vieneu instance
        self._lock = threading.Lock()

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

                # The `vieneu` version is pinned in the engine pack (uvRequirements.ts)
                # so the default engine is deterministically v3-Turbo (CPU -> ONNX,
                # torch-free). First init downloads the model into HF_HOME.
                logger.info("Loading VieNeu v3-Turbo (vieneu SDK)…")
                self._backend = Vieneu()
            except Exception as exc:  # noqa: BLE001
                raise EngineUnavailable(
                    f"VieNeu SDK could not be loaded (install the VieNeu engine pack): {exc}"
                ) from exc

    def synth(self, text: str, out_path: str, voice_id: str | None, speed: float) -> None:
        """Synthesize `text` to a 48 kHz WAV at `out_path`. Raises on failure.

        `speed` is intentionally unused — VieNeu synthesizes at natural rate and
        the orchestrator's alignment/ffmpeg stage time-stretches to the window.
        """
        self._ensure_loaded()
        voice = voices.resolve(voice_id)
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")

        # Preset voices are addressed by their SDK name. If the SDK rejects a
        # name (e.g. the preset set drifted upstream), retry with its default so
        # one stale name can't silence the whole dub.
        try:
            audio = self._backend.infer(clean, voice=voice.sdk_name)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("VieNeu voice '%s' failed (%s); using the default voice.", voice.sdk_name, exc)
            audio = self._backend.infer(clean)  # type: ignore[union-attr]

        _save_via_backend_or_pcm(self._backend, audio, out_path)


def _save_via_backend_or_pcm(backend: object, audio: object, out_path: str) -> None:
    """Write the synthesized audio: prefer the SDK's own save (handles the
    48 kHz rate); fall back to a PCM-16 writer for array-like output."""
    save = getattr(backend, "save", None)
    if callable(save):
        save(audio, out_path)
        return
    write_pcm16_wav(out_path, audio, NEURAL_SAMPLE_RATE)
