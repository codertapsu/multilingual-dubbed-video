"""OmniVoice (k2-fsa) multilingual TTS via mlx-audio on Apple Silicon (MLX).

Lazy-loads `mlx-community/OmniVoice-bf16` through mlx-audio. Synthesis uses
OmniVoice "Voice Design" — a natural-language ``instruct`` description of the
speaker — plus a fixed per-voice random seed so the zero-shot speaker timbre is
reproduced across EVERY segment of a dub (a speaker that drifts per line would
make the dub incoherent). The model is multilingual (~646 languages); the target
language is passed by name (see voices.language_name).

Reference-audio voice CLONING is intentionally NOT wired: the current MLX
checkpoint ships without the HiggsAudio audio-tokenizer, so passing ``ref_audio``
raises "tokenizer (HiggsAudioTokenizer) is required for voice cloning". Cloning is
a clean future addition once an MLX checkpoint includes that encoder.

mlx + mlx-audio are Apple-Silicon-only, so the engine pack is gated to
darwin/arm64 (this module never runs elsewhere). The SDK is imported LAZILY so
/health + /voices answer before the pack's venv is installed; ``synth()`` then
raises and the caller writes placeholder silence.
"""

from __future__ import annotations

import logging
import os
import threading

from . import voices
from .wavio import write_pcm16_wav

logger = logging.getLogger("vd_omnivoice.engine")

DEFAULT_MODEL = "mlx-community/OmniVoice-bf16"
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


# Diffusion unmasking steps — quality/speed knob (mlx-audio default is 32). Parsed
# defensively so a bad OMNIVOICE_NUM_STEPS value can't crash the worker at import.
NUM_STEPS = max(1, _env_int("OMNIVOICE_NUM_STEPS", 32))


# --- Dub-fitting -------------------------------------------------------------
# Target each segment's on-screen duration so OmniVoice speaks to FIT it — native
# rate control sounds better than the post-hoc ffmpeg atempo stretch. We don't
# force the raw window blindly: it's BOUNDED so OmniVoice never garbles (too fast)
# or drags (too slow). The orchestrator's alignment/ffmpeg stage stays the safety
# net for any residual. Disable with OMNIVOICE_FIT_DURATION=0.
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
# OmniVoice's zero-shot sampler occasionally emits a near-silent / mostly-silent
# draw for a segment (a brief blip then silence, or near-zero amplitude) — these
# are the "I can't hear anything" clips. Detect a WEAK result by RMS + peak and
# re-roll with a perturbed seed; the attribute instruct still pins the speaker,
# so a re-roll keeps the same gender/pitch. We keep the LOUDEST draw and only
# fall back to placeholder silence if every attempt is essentially mute. Tunable.
SYNTH_ATTEMPTS = max(1, _env_int("OMNIVOICE_SYNTH_ATTEMPTS", 3))
MIN_AUDIBLE_RMS = _env_float("OMNIVOICE_MIN_AUDIBLE_RMS", 0.02)
MIN_AUDIBLE_PEAK = _env_float("OMNIVOICE_MIN_AUDIBLE_PEAK", 0.05)
# Distinct prime offset per retry so each re-roll is a fresh sampler draw.
_RETRY_SEED_STRIDE = 7919


class EngineUnavailable(RuntimeError):
    """Raised when mlx-audio/mlx aren't present; caller falls back to silence."""


class OmniVoiceEngine:
    """Lazy OmniVoice synthesizer. Thread-safe load; sequential synth."""

    name = voices.ENGINE_NAME

    def __init__(self) -> None:
        self._model = None  # the loaded mlx-audio model
        self._lock = threading.Lock()
        self._load_error: str | None = None
        self._model_id = (os.environ.get("OMNIVOICE_MODEL") or DEFAULT_MODEL).strip()

    @property
    def sample_rate(self) -> int:
        return SAMPLE_RATE

    def available(self) -> bool:
        """True if mlx-audio + mlx can be imported in this venv (best-effort).

        Does NOT cache a prior failure — the venv may be (re)installed in the
        background, and /health should reflect that without a worker restart.
        """
        if self._model is not None:
            return True
        try:
            import importlib.util as _u  # noqa: PLC0415

            return _u.find_spec("mlx_audio") is not None and _u.find_spec("mlx") is not None
        except Exception:
            return False

    def loaded(self) -> bool:
        """True once the model is RESIDENT (warm). The orchestrator waits for this
        before a long run so the one-time download/load isn't charged to the
        /synthesize-segments timeout budget."""
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
                from mlx_audio.tts.utils import load_model  # type: ignore

                logger.info("Loading OmniVoice (%s) via mlx-audio…", self._model_id)
                model = load_model(self._model_id)
                # Fix mlx-audio's silent-output bug on this checkpoint (see below).
                self._attach_audio_codec(model)
                if getattr(model, "audio_tokenizer", None) is None:
                    raise EngineUnavailable(
                        "OmniVoice loaded but its HiggsAudio codec is unavailable — "
                        "output would be silent (incompatible MLX checkpoint)."
                    )
                self._model = model
            except EngineUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001
                raise EngineUnavailable(
                    f"OmniVoice/mlx-audio could not be loaded (install the OmniVoice engine pack): {exc}"
                ) from exc

    def _attach_audio_codec(self, model: object) -> None:
        """Work around mlx-audio's silent-output bug on the OmniVoice bf16 MLX
        checkpoint.

        mlx-audio loads the HiggsAudio codec STRICTLY, but this checkpoint ships
        WITHOUT the 225 encode-path params (the semantic encoder, used only for
        reference-audio cloning). The strict load therefore fails and leaves
        ``model.audio_tokenizer = None`` — and with no codec, ``generate()`` emits
        pure SILENCE (correct duration, zero amplitude). The DECODER (tokens ->
        waveform) is all TTS needs, so we reload the codec NON-STRICTLY here. No-op
        when a future checkpoint loads it cleanly. (Cloning stays unavailable.)
        """
        if getattr(model, "audio_tokenizer", None) is not None:
            return
        import json  # noqa: PLC0415
        from pathlib import Path  # noqa: PLC0415

        import mlx.core as mx  # noqa: PLC0415

        # This reaches into mlx-audio internals (HiggsAudioTokenizer,
        # _init_encode_modules, sanitize, get_model_path) that are private/unstable
        # — pin-tested against mlx-audio 0.4.4 (see uvRequirements). Wrap so a future
        # bump that renames/moves them fails LOUD (EngineUnavailable -> the provider
        # fails fast) instead of silently leaving the codec unattached (= mute).
        try:
            from mlx_audio.codec.models.higgs_audio.higgs_audio import (  # type: ignore  # noqa: PLC0415
                HiggsAudioConfig,
                HiggsAudioTokenizer,
            )
            from mlx_audio.tts.utils import get_model_path  # type: ignore  # noqa: PLC0415

            resolved = get_model_path(self._model_id)
            root = Path(resolved[0] if isinstance(resolved, tuple) else resolved)
            codec_dir = root / "audio_tokenizer"
            cfg = HiggsAudioConfig.from_dict(json.loads((codec_dir / "config.json").read_text()))
            codec = HiggsAudioTokenizer(cfg)
            if cfg.semantic_model_config is not None:
                codec._init_encode_modules()
            raw = mx.load(str(codec_dir / "model.safetensors"))
            codec.load_weights(list(codec.sanitize(raw).items()), strict=False)
            mx.eval(codec.parameters())
            model.audio_tokenizer = codec
            logger.info("OmniVoice: reattached HiggsAudio codec (non-strict) — audio output enabled.")
        except Exception as exc:  # noqa: BLE001
            import mlx_audio  # type: ignore  # noqa: PLC0415

            version = getattr(mlx_audio, "__version__", "unknown")
            raise EngineUnavailable(
                f"OmniVoice codec reattach failed on mlx-audio {version} (pin-tested 0.4.4) — "
                f"output would be silent: {exc}"
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
        # Coarse natural-duration estimate (per-language rate), used ONLY to bound.
        natural_s = max(MIN_DURATION_S, len(text) / max(1.0, _chars_per_sec(language)))
        lo = natural_s / max(1.0, MAX_SPEED)  # fastest acceptable -> shortest
        hi = natural_s * max(1.0, MAX_SLOW)  # slowest acceptable -> longest
        return max(MIN_DURATION_S, min(max(window_s, lo), hi))

    def synth(
        self,
        text: str,
        out_path: str,
        voice_id: str | None,
        language: str | None,
        target_ms: int = 0,
    ) -> None:
        """Synthesize `text` (in `language`) to a 24 kHz WAV at `out_path`.

        When `target_ms` (the segment's on-screen window) is given and dub-fitting
        is enabled, OmniVoice is asked to speak to (a bounded) that duration so it
        natively fits the slot; otherwise it synthesizes at natural rate. Either
        way the orchestrator's alignment/ffmpeg stage time-stretches any residual.
        Raises on failure (caller writes placeholder silence).
        """
        self._ensure_loaded()
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")

        voice = voices.resolve(voice_id)
        lang = voices.language_name(language)

        import numpy as np  # noqa: PLC0415

        # mlx is only needed to seed the speaker + recognise mx.array output. Import
        # it optionally so the post-generate guards stay unit-testable with a fake
        # model + plain numpy (production always has mlx via mlx-audio).
        mx = None
        try:
            import mlx.core as _mx  # type: ignore  # noqa: PLC0415

            mx = _mx
        except Exception:  # noqa: BLE001
            pass

        gen_kwargs: dict[str, object] = {
            "text": clean,
            "language": lang,
            "instruct": voice.instruct,
            "num_steps": NUM_STEPS,
        }
        duration_s = self._fit_duration_s(clean, target_ms, language)
        if duration_s is not None:
            gen_kwargs["duration_s"] = duration_s

        # Re-roll a weak (near-silent) draw, keeping the loudest. Attempt 0 uses the
        # voice's pinned seed (consistent speaker); retries perturb it (the attribute
        # instruct still pins gender/pitch, so the voice stays put). Empty/non-finite
        # draws are skipped, never written.
        best: np.ndarray | None = None
        best_rms = -1.0
        saw_nonfinite = False
        for attempt in range(SYNTH_ATTEMPTS):
            if mx is not None:
                mx.random.seed(voice.seed + attempt * _RETRY_SEED_STRIDE)
            audio = self._generate_once(gen_kwargs, mx, np)
            if audio.size == 0:
                continue
            # Reject NaN/Inf (np.max(|nan|) is nan and `nan <= 1e-5` is False, so a
            # non-finite array would slip past the amplitude checks below) and re-roll.
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
            # Every attempt was empty or non-finite — let the caller place sized silence.
            if saw_nonfinite:
                raise RuntimeError("OmniVoice produced non-finite audio (NaN/Inf)")
            raise RuntimeError("OmniVoice produced no audio")
        # Essentially mute (e.g. codec not attached) — surface as a fallback rather
        # than ship a silent dub. With the codec attached at load this never fires.
        if float(np.max(np.abs(best))) <= 1e-5:
            raise RuntimeError("OmniVoice produced silent audio (HiggsAudio codec not loaded?)")
        write_pcm16_wav(out_path, best, SAMPLE_RATE)

    def _generate_once(self, gen_kwargs: dict[str, object], mx, np) -> "object":
        """One generate() pass -> a 1-D float32 numpy waveform (may be empty)."""
        chunks: list[object] = []
        for result in self._model.generate(**gen_kwargs):
            audio = getattr(result, "audio", result)
            if mx is not None and isinstance(audio, mx.array):
                audio = np.array(audio)
            chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
