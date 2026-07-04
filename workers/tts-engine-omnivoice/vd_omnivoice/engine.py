"""OmniVoice (k2-fsa) multilingual TTS via the official PyTorch package on Apple
Silicon (MPS).

Lazy-loads ``k2-fsa/OmniVoice`` through the official ``omnivoice`` package — the
SAME pipeline the HuggingFace Space runs — on the Metal (MPS) backend in float16.
Synthesis uses OmniVoice "Voice Design": a comma-separated list of TRAINED speaker
attributes (gender, age, pitch — see voices.py) passed as ``instruct``. A fixed
per-voice seed reproduces the zero-shot speaker timbre across every segment of a
dub (a speaker that drifts per line would make the dub incoherent).

Why PyTorch and not an MLX port: the audio quality lives in the HiggsAudio codec
(tokens -> waveform). The community MLX port (mlx-audio) ports that codec to bf16
MLX and audibly degrades it; the official runtime keeps the codec in
full-precision PyTorch. Listening A/B confirmed only the PyTorch path matches the
Space, so this engine runs the full PyTorch model on MPS (RTF ~1 on Apple Silicon).

Reference-audio voice CLONING is intentionally NOT wired here (Voice Design only);
it's a clean future addition via ``ref_audio`` / ``ref_text``.

torch + omnivoice are heavy + Apple-Silicon-tuned (MPS), so the engine pack is
gated to darwin/arm64. The SDK is imported LAZILY so /health + /voices answer
before the pack's venv is installed; ``synth()`` then raises and the caller writes
placeholder silence.
"""

from __future__ import annotations

import logging
import os
import threading

from . import voices
from .wavio import write_pcm16_wav

logger = logging.getLogger("vd_omnivoice.engine")

# The official PyTorch checkpoint (full-precision codec) — NOT an MLX conversion.
DEFAULT_MODEL = "k2-fsa/OmniVoice"
# OmniVoice outputs 24 kHz mono.
SAMPLE_RATE = 24000


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default


# Diffusion steps — quality/speed knob (OmniVoice default is 32; 16 is faster).
# Parsed defensively so a bad OMNIVOICE_NUM_STEPS value can't crash the worker.
NUM_STEPS = max(1, _env_int("OMNIVOICE_NUM_STEPS", 32))


# --- Dub-fitting -------------------------------------------------------------
# Target each segment's on-screen duration so OmniVoice speaks to FIT it (the
# model's native ``duration`` control) — better than the post-hoc ffmpeg atempo
# stretch. We don't force the raw window blindly: it's BOUNDED so OmniVoice never
# garbles (too fast) or drags (too slow). The orchestrator's alignment/ffmpeg
# stage stays the safety net for any residual. Disable with OMNIVOICE_FIT_DURATION=0.
FIT_DURATION = _env_flag("OMNIVOICE_FIT_DURATION", True)
# Per-language natural speaking rate (characters/second), used ONLY to bound the
# fit target. CJK/Korean/Thai pack far more meaning per character than Latin, so
# their cps is much lower. OMNIVOICE_CHARS_PER_SEC, when set, overrides ALL
# languages with one value; otherwise the per-language table applies (with a
# 14 cps default for anything unlisted).
_CPS_ENV = os.environ.get("OMNIVOICE_CHARS_PER_SEC")
_DEFAULT_CHARS_PER_SEC = 14.0
_CHARS_PER_SEC_BY_LANG: dict[str, float] = {
    "zh": 5.5,   # Chinese — each hanzi ≈ a syllable
    "yue": 5.5,  # Cantonese
    "ja": 7.0,   # Japanese (kanji/kana mix)
    "ko": 7.0,   # Korean (hangul syllable blocks)
    "th": 8.0,   # Thai (no word spaces)
    "lo": 8.0,   # Lao
    "my": 8.0,   # Burmese
    "km": 8.0,   # Khmer
    "ar": 12.0,  # Arabic
    "fa": 12.0,  # Persian
    "he": 12.0,  # Hebrew
    "hi": 11.0,  # Hindi (Devanagari)
    "bn": 11.0,  # Bengali
    "ta": 10.0,  # Tamil
    "te": 10.0,  # Telugu
}


def _chars_per_sec(language: str | None) -> float:
    """Natural chars/sec for a language (BCP-47 code). An explicit
    OMNIVOICE_CHARS_PER_SEC env wins globally; else the per-language table."""
    if _CPS_ENV is not None:
        try:
            return float(_CPS_ENV)
        except ValueError:
            pass
    return _CHARS_PER_SEC_BY_LANG.get(voices.base_subtag(language), _DEFAULT_CHARS_PER_SEC)


# Don't speak faster than MAX_SPEED× natural, nor slower than 1/MAX_SLOW× natural
# (mirrors the pipeline's maxSpeedRatio idea).
MAX_SPEED = _env_float("OMNIVOICE_MAX_SPEED", 1.6)
MAX_SLOW = _env_float("OMNIVOICE_MAX_SLOW", 1.3)
MIN_DURATION_S = 0.6


# --- Audibility retry --------------------------------------------------------
# OmniVoice's zero-shot sampler can (rarely) emit a near-silent / mostly-silent
# draw for a segment. Detect a WEAK result by RMS + peak and re-roll with a
# perturbed seed; the attribute instruct still pins the speaker, so a re-roll
# keeps the same gender/pitch. We keep the LOUDEST draw and only fall back to
# placeholder silence if every attempt is essentially mute. Tunable via env.
SYNTH_ATTEMPTS = max(1, _env_int("OMNIVOICE_SYNTH_ATTEMPTS", 3))
MIN_AUDIBLE_RMS = _env_float("OMNIVOICE_MIN_AUDIBLE_RMS", 0.02)
MIN_AUDIBLE_PEAK = _env_float("OMNIVOICE_MIN_AUDIBLE_PEAK", 0.05)
# Distinct prime offset per retry so each re-roll is a fresh sampler draw.
_RETRY_SEED_STRIDE = 7919


class EngineUnavailable(RuntimeError):
    """Raised when torch/omnivoice aren't present; caller falls back to silence."""


class OmniVoiceEngine:
    """Lazy OmniVoice synthesizer. Thread-safe load; sequential synth."""

    name = voices.ENGINE_NAME

    def __init__(self) -> None:
        self._model = None  # the loaded omnivoice.OmniVoice
        self._torch = None  # the torch module (kept for seeding)
        self._device = "cpu"
        self._lock = threading.Lock()
        self._load_error: str | None = None
        self._model_id = (os.environ.get("OMNIVOICE_MODEL") or DEFAULT_MODEL).strip()

    @property
    def sample_rate(self) -> int:
        return SAMPLE_RATE

    def available(self) -> bool:
        """True if torch + omnivoice can be imported in this venv (best-effort).

        Does NOT cache a prior failure — the venv may be (re)installed in the
        background, and /health should reflect that without a worker restart.
        """
        if self._model is not None:
            return True
        try:
            import importlib.util as _u  # noqa: PLC0415

            return _u.find_spec("omnivoice") is not None and _u.find_spec("torch") is not None
        except Exception:  # noqa: BLE001
            return False

    def loaded(self) -> bool:
        return self._model is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def warmup(self) -> None:
        """Eagerly load (downloading on first use). Records the failure for /health
        and re-raises so the background warm-up can log it."""
        try:
            self._ensure_loaded()
            self._load_error = None
        except Exception as exc:  # noqa: BLE001
            self._load_error = str(exc)
            raise

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            try:
                import torch  # type: ignore  # noqa: PLC0415
                from omnivoice import OmniVoice  # type: ignore  # noqa: PLC0415

                # MPS (Metal) on Apple Silicon, float16 — the Space's pipeline.
                # CPU fallback runs in float32 (float16 math is poorly supported
                # on CPU) so a non-Metal box still works, just slower.
                if torch.backends.mps.is_available():
                    device, dtype = "mps", torch.float16
                else:
                    device, dtype = "cpu", torch.float32
                logger.info("Loading OmniVoice (%s) on %s…", self._model_id, device)
                self._model = OmniVoice.from_pretrained(self._model_id, device_map=device, dtype=dtype)
                self._torch = torch
                self._device = device
                logger.info("OmniVoice ready on %s.", device)
            except Exception as exc:  # noqa: BLE001
                raise EngineUnavailable(
                    f"OmniVoice/omnivoice could not be loaded (install the OmniVoice engine pack): {exc}"
                ) from exc

    def _fit_duration_s(self, text: str, target_ms: int, language: str | None = None) -> float | None:
        """A BOUNDED target duration (seconds) so OmniVoice speaks to fit the
        segment window. Returns None to synthesize at natural rate (fitting off or
        no target). The window is clamped to [natural/MAX_SPEED, natural*MAX_SLOW]
        so a too-short window can't garble the speech and a too-long one can't drag
        it — the orchestrator's ffmpeg stage handles any residual."""
        if not FIT_DURATION or not target_ms or target_ms <= 0:
            return None
        window_s = target_ms / 1000.0
        natural_s = max(MIN_DURATION_S, len(text) / max(1.0, _chars_per_sec(language)))
        lo = natural_s / max(1.0, MAX_SPEED)  # fastest acceptable -> shortest
        hi = natural_s * max(1.0, MAX_SLOW)  # slowest acceptable -> longest
        return min(max(window_s, lo), hi)

    def synth(
        self,
        text: str,
        out_path: str,
        voice_id: str | None,
        language: str | None,
        target_ms: int = 0,
    ) -> None:
        """Synthesize `text` (in `language`) to a 24 kHz WAV at `out_path`.

        Uses OmniVoice Voice Design (the resolved voice's trained `instruct`
        attributes) and, when a segment window is given + dub-fitting is enabled,
        the model's native `duration` control so it natively fits the slot.
        Raises on failure (caller writes placeholder silence).
        """
        self._ensure_loaded()
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")

        voice = voices.resolve(voice_id)
        lang = voices.language_name(language)  # OmniVoice language name, or None to auto-detect

        import numpy as np  # noqa: PLC0415

        gen_kwargs: dict[str, object] = {
            "text": clean,
            "instruct": voice.instruct,
            "num_step": NUM_STEPS,
        }
        if lang:
            gen_kwargs["language"] = lang
        duration_s = self._fit_duration_s(clean, target_ms, language)
        if duration_s is not None:
            gen_kwargs["duration"] = duration_s

        # Re-roll a weak (near-silent) draw, keeping the loudest. Attempt 0 uses the
        # voice's pinned seed (consistent speaker); retries perturb it (the attribute
        # instruct still pins gender/pitch, so the voice stays put).
        best: np.ndarray | None = None
        best_rms = -1.0
        saw_nonfinite = False
        for attempt in range(SYNTH_ATTEMPTS):
            self._seed(voice.seed + attempt * _RETRY_SEED_STRIDE)
            audio = self._generate_once(gen_kwargs, np)
            if audio.size == 0:
                continue
            if not np.all(np.isfinite(audio)):
                saw_nonfinite = True
                continue
            rms = float(np.sqrt(np.mean(np.square(audio))))
            peak = float(np.max(np.abs(audio)))
            if rms > best_rms:
                best, best_rms = audio, rms
            if peak >= MIN_AUDIBLE_PEAK and rms >= MIN_AUDIBLE_RMS:
                break  # audible enough — stop re-rolling
            logger.warning(
                "OmniVoice weak draw (attempt %d/%d): peak=%.3f rms=%.3f — re-rolling",
                attempt + 1, SYNTH_ATTEMPTS, peak, rms,
            )

        if best is None:
            if saw_nonfinite:
                raise RuntimeError("OmniVoice produced non-finite audio (NaN/Inf)")
            raise RuntimeError("OmniVoice produced no audio")
        if float(np.max(np.abs(best))) <= 1e-5:
            raise RuntimeError("OmniVoice produced silent audio")
        write_pcm16_wav(out_path, best, SAMPLE_RATE)

    def _seed(self, seed: int) -> None:
        """Pin the diffusion sampler so a voice reproduces across segments."""
        if self._torch is None:
            return
        self._torch.manual_seed(seed)
        if self._device == "mps":
            try:
                self._torch.mps.manual_seed(seed)
            except Exception:  # noqa: BLE001
                pass

    def _generate_once(self, gen_kwargs: dict[str, object], np) -> "object":
        """One generate() pass -> a 1-D float32 numpy waveform (may be empty).

        OmniVoice.generate() returns a list of np.ndarray (one per input text, or
        per chunk for very long text); we synthesize a single segment, so flatten
        + concatenate defensively."""
        out = self._model.generate(**gen_kwargs)
        if isinstance(out, (list, tuple)):
            arrs = [np.asarray(a, dtype=np.float32).reshape(-1) for a in out]
            return np.concatenate(arrs) if arrs else np.zeros(0, dtype=np.float32)
        return np.asarray(out, dtype=np.float32).reshape(-1)
