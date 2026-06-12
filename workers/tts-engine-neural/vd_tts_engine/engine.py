"""VieNeu (NeuTTS Air) neural TTS synthesis.

Architecture (per the VieNeu-TTS / NeuTTS Air model cards): a ~0.5B Qwen2 speech
LLM backbone (shipped as a GGUF, run on CPU via llama-cpp-python) autoregressively
predicts NeuCodec audio-codec tokens, which the NeuCodec decoder turns into a
24 kHz waveform. Voice identity is *instant voice cloning*: a short reference clip
+ its transcript condition the speaker. VieNeu bundles preset Vietnamese voices so
no user-supplied clip is needed.

Design notes:
  * The heavy deps (`neuttsair`/`vieneu`, `llama-cpp-python`, `neucodec`) are
    imported LAZILY inside `_ensure_loaded()`, so this module imports cleanly
    (and /health + /voices work) even before the engine pack's venv has them. In
    that state `synth()` raises `EngineUnavailable` and the caller writes silence.
  * The encoded reference codes are cached per voice (encode once, reuse for every
    segment of a video — the model load + reference encode is the main fixed cost).
  * NeuTTS has no direct speed control; we synthesize at natural rate and report
    speedRatio = 1.0. The orchestrator's alignment/ffmpeg stage time-stretches each
    clip to its timing window downstream.

The exact preset-reference wiring (resolving a `voices.json` entry to a reference
wav + transcript) depends on the upstream model layout and should be validated on
a real pack install; it is factored into `_resolve_reference()` with a graceful
fallback so a mismatch degrades to the default preset rather than failing.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from . import voices
from .prereqs import espeak_ng_available
from .wavio import NEURAL_SAMPLE_RATE, write_pcm16_wav

logger = logging.getLogger("vd_tts_engine.engine")

# Model sources (Apache-2.0). Overridable via env for pinning a known-good rev.
BACKBONE_REPO = os.environ.get("VIENEU_BACKBONE_REPO", "pnnbao-ump/VieNeu-TTS-q4-gguf")
CODEC_REPO = os.environ.get("VIENEU_CODEC_REPO", "neuphonic/neucodec")
VIENEU_VOICES_REPO = os.environ.get("VIENEU_VOICES_REPO", "pnnbao-ump/VieNeu-TTS")


class EngineUnavailable(RuntimeError):
    """Raised when the neural deps/weights aren't present; caller falls back."""


class VieNeuEngine:
    """Lazy VieNeu synthesizer. Thread-safe load; sequential synth per request."""

    name = voices.ENGINE_NAME

    def __init__(self) -> None:
        self._backend = None  # the loaded model handle (NeuTTSAir or Vieneu)
        self._mode: str | None = None  # "vieneu" | "neuttsair"
        self._ref_codes: dict[str, object] = {}  # voice.ref -> encoded ref codes
        self._lock = threading.Lock()
        self._load_failed: str | None = None

    # -- availability ---------------------------------------------------------

    def available(self) -> bool:
        """Best-effort: True if a neural backend can be imported in this venv.

        Deliberately does NOT short-circuit on a prior `_load_failed`: deps (or
        espeak-ng) may be installed in the background after an early failed synth,
        and /health should reflect that without a worker restart.
        """
        if self._backend is not None:
            return True
        try:
            import importlib.util as _u  # noqa: PLC0415

            return _u.find_spec("vieneu") is not None or _u.find_spec("neuttsair") is not None
        except Exception:
            return False

    # -- loading --------------------------------------------------------------

    def _ensure_loaded(self) -> None:
        if self._backend is not None:
            return
        with self._lock:
            if self._backend is not None:
                return
            # Preferred: VieNeu's high-level SDK (presets + Vietnamese G2P built in).
            try:
                from vieneu import Vieneu  # type: ignore

                logger.info("Loading VieNeu (high-level SDK)…")
                self._backend = Vieneu()
                self._mode = "vieneu"
                return
            except Exception as exc:  # noqa: BLE001
                logger.info("VieNeu SDK unavailable (%s); trying NeuTTS Air.", exc)

            # NeuTTS Air phonemizes via espeak-ng — refuse early (clear message)
            # if it's missing rather than producing broken pronunciation. The
            # VieNeu high-level SDK uses sea-g2p, so it doesn't hit this branch.
            if not espeak_ng_available():
                self._load_failed = "espeak-ng not found"
                raise EngineUnavailable(
                    "espeak-ng is required for VieNeu/NeuTTS phonemization but was not found on PATH. "
                    "Install it (macOS: `brew install espeak-ng`; Debian/Ubuntu: `apt install espeak-ng`; "
                    "Windows: install eSpeak NG and add its folder, e.g. `C:\\Program Files\\eSpeak NG`, "
                    "to PATH), then restart."
                )

            # Fallback: NeuTTS Air GGUF CPU path.
            try:
                from neuttsair.neutts import NeuTTSAir  # type: ignore

                logger.info("Loading NeuTTS Air backbone=%s codec=%s …", BACKBONE_REPO, CODEC_REPO)
                self._backend = NeuTTSAir(
                    backbone_repo=BACKBONE_REPO,
                    backbone_device="cpu",
                    codec_repo=CODEC_REPO,
                    codec_device="cpu",
                )
                self._mode = "neuttsair"
                return
            except Exception as exc:  # noqa: BLE001
                self._load_failed = str(exc)
                raise EngineUnavailable(
                    "Neural TTS backend could not be loaded "
                    f"(install the VieNeu engine pack): {exc}"
                ) from exc

    # -- reference resolution (NeuTTS Air path) -------------------------------

    def _resolve_reference(self, voice: "voices.NeuralVoice") -> tuple[object, str]:
        """Encode (and cache) the reference codes + transcript for a preset voice.

        Downloads the model repo's preset reference clip via huggingface_hub. The
        precise voices.json schema is upstream-defined, so this is best-effort and
        falls back to any bundled example reference; on total failure it raises
        EngineUnavailable (the caller then writes silence for that segment).
        """
        cached = self._ref_codes.get(voice.ref)
        if cached is not None:
            return cached  # type: ignore[return-value]

        ref_wav, ref_text = self._download_reference(voice)
        codes = self._backend.encode_reference(str(ref_wav))  # type: ignore[union-attr]
        self._ref_codes[voice.ref] = (codes, ref_text)
        return codes, ref_text

    def _download_reference(self, voice: "voices.NeuralVoice") -> tuple[Path, str]:
        try:
            import json

            from huggingface_hub import hf_hub_download  # type: ignore

            vj = hf_hub_download(VIENEU_VOICES_REPO, "voices.json")
            data = json.loads(Path(vj).read_text(encoding="utf-8"))
            entry = _lookup_voice_entry(data, voice.ref)
            wav_rel = entry.get("audio") or entry.get("ref_audio") or entry.get("wav")
            text = entry.get("text") or entry.get("ref_text") or entry.get("transcript") or ""
            if wav_rel:
                wav = hf_hub_download(VIENEU_VOICES_REPO, wav_rel)
                if not text:
                    # Some layouts ship a sibling .txt transcript.
                    try:
                        text = Path(hf_hub_download(VIENEU_VOICES_REPO, _swap_ext(wav_rel, ".txt"))).read_text(
                            encoding="utf-8"
                        )
                    except Exception:  # noqa: BLE001
                        text = ""
                return Path(wav), text.strip()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not resolve preset reference for %s: %s", voice.id, exc)
        raise EngineUnavailable(f"No usable reference clip for voice {voice.id}.")

    # -- synthesis ------------------------------------------------------------

    def synth(self, text: str, out_path: str, voice_id: str | None, speed: float) -> None:
        """Synthesize `text` to a 24 kHz mono WAV at `out_path`. Raises on failure."""
        self._ensure_loaded()
        voice = voices.resolve(voice_id)
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")

        if self._mode == "vieneu":
            # High-level SDK: presets by display identity; save handles WAV write.
            audio = self._backend.infer(clean, voice=voice.display_name)  # type: ignore[union-attr]
            _save_via_backend_or_pcm(self._backend, audio, out_path)
            return

        # NeuTTS Air path: condition on the cached reference codes.
        ref_codes, ref_text = self._resolve_reference(voice)
        wav = self._backend.infer(clean, ref_codes, ref_text)  # type: ignore[union-attr]
        write_pcm16_wav(out_path, wav, NEURAL_SAMPLE_RATE)


def _lookup_voice_entry(data: object, ref: str) -> dict:
    """Find a preset entry by key/name in a few plausible voices.json shapes."""
    if isinstance(data, dict):
        # { "ngoc_huyen": {...} } or { "voices": {...} } / { "voices": [...] }
        if ref in data and isinstance(data[ref], dict):
            return data[ref]
        inner = data.get("voices")
        if isinstance(inner, dict) and ref in inner and isinstance(inner[ref], dict):
            return inner[ref]
        if isinstance(inner, list):
            data = inner
        else:
            # First dict value as a last resort (default preset).
            for v in data.values():
                if isinstance(v, dict):
                    return v
    if isinstance(data, list):
        for v in data:
            if isinstance(v, dict) and (v.get("id") == ref or v.get("name") == ref):
                return v
        for v in data:
            if isinstance(v, dict):
                return v
    return {}


def _swap_ext(rel: str, ext: str) -> str:
    p = Path(rel)
    return str(p.with_suffix(ext))


def _save_via_backend_or_pcm(backend: object, audio: object, out_path: str) -> None:
    save = getattr(backend, "save", None)
    if callable(save):
        save(audio, out_path)
        return
    write_pcm16_wav(out_path, audio, NEURAL_SAMPLE_RATE)
