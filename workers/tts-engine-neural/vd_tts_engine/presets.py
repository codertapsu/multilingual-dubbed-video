"""Preset-voice ONNX engines served by vd_tts_engine: ZeroTTS, Kokoro, Supertonic 3.

One base (:class:`PresetEngine`) carries what the server needs from an engine
(the same surface as engine.py / engine38.py): lazy load with a recorded load
error for /health, strict voices, clip keys, per-line synthesis under one lock
with the sampling seeded per voice, PCM-16 WAV output. Each engine adds how it
loads (its model files fetched once at a pinned commit, pinned.py) and how it
speaks one line.

Picked by ``VD_TTS_ADAPTER`` (set by the orchestrator per engine pack).
Measured on an i5-13400F (Phase 0, 2026-11-18), all on the CPU through ONNX
Runtime, real-time factor (seconds of compute per second of speech):

    engine       threads   RTF     peak RAM
    ZeroTTS fp32   4       0.25    2.4 GB
    Kokoro         4       0.17-0.19  0.8 GB
    Supertonic 3   4       0.16    0.66 GB

None of them is autoregressive per frame the way VieNeu is, so they use more
threads well; 4 was at or near the best for each (8 was no faster), and
``VD_TTS_THREADS`` overrides it.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import clipcache, hfcache, pinned
from .engine import EngineUnavailable, _pin_rng
from .engine38 import UnknownVoice
from .wavio import write_pcm16_wav

hfcache.disable_shared_blob_store()

logger = logging.getLogger("vd_tts_engine.presets")

DEFAULT_THREADS = 4


def engine_threads(environ: "os._Environ[str] | dict[str, str]" = os.environ, cpu_count: int | None = None) -> int:
    """ONNX intra-op threads: VD_TTS_THREADS, else 4 (never more than the machine has)."""
    raw = str(environ.get("VD_TTS_THREADS", "")).strip()
    if raw.isdigit() and int(raw) >= 1:
        return int(raw)
    cores = cpu_count if cpu_count is not None else (os.cpu_count() or 1)
    return max(1, min(DEFAULT_THREADS, cores))


@dataclass(frozen=True)
class PresetVoice:
    id: str
    sdk_name: str
    display_name: str
    gender: str | None = None
    #: BCP-47 tags it speaks; ("*",) = every language of its engine.
    languages: tuple[str, ...] = ("*",)
    recommended: bool = False
    accent: str | None = None
    extra: dict[str, Any] = field(default_factory=dict, compare=False, hash=False)


def base_language(tag: str | None) -> str:
    return (tag or "").replace("_", "-").split("-")[0].lower()


class PresetEngine:
    """Shared lifecycle; subclasses set the class fields and implement _load/_speak."""

    name = "preset"
    variant = "preset"
    sample_rate = 24_000
    supports_cloning = False
    #: Honours a speaking rate natively (the orchestrator re-synthesizes over-long lines at a faster rate).
    supports_speed = False
    #: Needs the request's language (multilingual engines).
    takes_language = True
    #: The Python module that must import for the engine to work.
    module = ""
    repo: pinned.PinnedRepo | None = None
    voices_table: tuple[PresetVoice, ...] = ()

    def __init__(self) -> None:
        self._backend: Any = None
        self._lock = threading.Lock()
        self._synth_lock = threading.Lock()
        self._load_error: str | None = None
        self._device: str | None = None

    # ---- state the server reports -------------------------------------------

    @property
    def device(self) -> str | None:
        return self._device

    @property
    def device_name(self) -> str | None:
        return None

    @property
    def device_note(self) -> str | None:
        return None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def available(self) -> bool:
        if self._backend is not None:
            return True
        try:
            return importlib.util.find_spec(self.module) is not None
        except Exception:  # noqa: BLE001
            return False

    def loaded(self) -> bool:
        return self._backend is not None

    def sdk_version(self) -> str:
        try:
            from importlib.metadata import version  # noqa: PLC0415

            return version(self.module.replace("_", "-"))
        except Exception:  # noqa: BLE001
            return "unknown"

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
            if not self.available():
                raise EngineUnavailable(f"{self.name} is not installed in this engine pack ({self.module} missing).")
            model_dir = pinned.ensure(self.repo, pinned.models_root()) if self.repo else Path(".")
            self._backend = self._load(model_dir, engine_threads())
            self._device = "cpu"

    def _load(self, model_dir: Path, threads: int) -> Any:  # pragma: no cover - per engine
        raise NotImplementedError

    def _speak(self, text: str, voice: PresetVoice, language: str, speed: float) -> Any:  # pragma: no cover
        raise NotImplementedError

    # ---- voices ----------------------------------------------------------------

    def voices(self, language: str | None = None) -> list[PresetVoice]:
        if not language:
            return list(self.voices_table)
        base = base_language(language)
        return [v for v in self.voices_table if "*" in v.languages or any(base_language(l) == base for l in v.languages)]

    def _preset(self, voice_id: str | None) -> PresetVoice:
        if not voice_id:
            return next((v for v in self.voices_table if v.recommended), self.voices_table[0])
        vid = voice_id.strip().split(":", 1)[-1].strip()
        hit = next((v for v in self.voices_table if v.id == vid), None)
        if hit is None:
            raise UnknownVoice(f'{self.name} has no voice "{voice_id}".')
        return hit

    def validate_voice(self, voice_id: str | None, voice_ref: Any = None) -> None:
        if voice_ref is not None:
            raise UnknownVoice(f"{self.name} only speaks its preset voices.")
        self._preset(voice_id)

    def clip_key(self, text: str, voice_id: str | None, voice_ref: Any = None, language: str | None = None, speed: float = 1.0) -> str:
        clean = (text or "").strip()
        if not clean:
            raise ValueError("empty text")
        voice = self._preset(voice_id)
        # Everything that changes the audio: the voice, the language it reads
        # in (multilingual engines), and the rate (engines that honour one).
        ident = f"{voice.sdk_name}|{base_language(language)}|{speed:.3f}" if self.supports_speed else f"{voice.sdk_name}|{base_language(language)}"
        return clipcache.clip_key(self.variant, ident + self._key_extra(voice), clean, self.sdk_version())

    def _key_extra(self, voice: PresetVoice) -> str:
        """More of what decides a voice's audio, for engines that have more (Kokoro's G2P)."""
        return ""

    # ---- synthesis -------------------------------------------------------------

    def synth_many(
        self,
        texts: list[str],
        out_paths: list[str],
        voice_id: str | None,
        speed: float,
        voice_ref: Any = None,
        language: str | None = None,
    ) -> list[BaseException | None]:
        self._ensure_loaded()
        voice = self._preset(voice_id)
        rate = speed if self.supports_speed and speed and speed > 0 else 1.0
        errors: list[BaseException | None] = []
        for text, out_path in zip(texts, out_paths):
            try:
                clean = (text or "").strip()
                if not clean:
                    raise ValueError("empty text")
                with self._synth_lock:
                    _pin_rng(f"{self.variant}:{voice.sdk_name}")
                    audio = self._speak(clean, voice, language or "", rate)
                write_pcm16_wav(out_path, audio, self.sample_rate)
                errors.append(None)
            except Exception as exc:  # noqa: BLE001 - reported per line
                errors.append(exc)
        return errors


# ---- ZeroTTS ---------------------------------------------------------------------

ZEROTTS_VOICES = (
    PresetVoice("zerotts-maichi", "maichi", "Mai Chi", "female", ("vi-VN",), recommended=True),
    PresetVoice("zerotts-baotrang", "baotrang", "Bảo Trang", "female", ("vi-VN",)),
    PresetVoice("zerotts-kimoanh", "kimoanh", "Kim Oanh", "female", ("vi-VN",)),
    PresetVoice("zerotts-hamy", "hamy", "Hà My", "female", ("vi-VN",)),
    PresetVoice("zerotts-giahuy", "giahuy", "Gia Huy", "male", ("vi-VN",)),
    PresetVoice("zerotts-huuduc", "huuduc", "Hữu Đức", "male", ("vi-VN",)),
    PresetVoice("zerotts-quangminh", "quangminh", "Quang Minh", "male", ("vi-VN",)),
    PresetVoice("zerotts-tiendat", "tiendat", "Tiến Đạt", "male", ("vi-VN",)),
)


#: The three graphs on ZeroTTS's per-frame path; the codec decoder stays fp32.
ZEROTTS_HOT_GRAPHS = ("text_encoder.onnx", "prefix_step.onnx", "local_frame_decode.onnx")
#: Written last into an int8 folder: the fp32 revision it was built from + how.
ZEROTTS_INT8_MARKER = ".vd-int8"
ZEROTTS_INT8_RECIPE = "matmul-qint8-v1"


def quantize_zerotts_graph(src: Path, dst: Path) -> None:
    """One graph to int8, the way ZeroTTS's own tools/quantize_onnx_int8.py does
    it (MIT, ZeroWeight AI): let ONNX Runtime fold the graph first, which removes
    the Identity nodes the weights reach the MatMuls through (otherwise only 41 of
    local_frame_decode's 561 MatMuls quantize), then dynamic-quantize the MatMuls."""
    import onnxruntime as ort  # noqa: PLC0415
    from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: PLC0415 - needs `onnx`

    folded = dst.with_name(dst.name + ".opt")
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.optimized_model_filepath = str(folded)
    ort.InferenceSession(str(src), options, providers=["CPUExecutionProvider"])  # writes `folded`, never runs
    try:
        quantize_dynamic(str(folded), str(dst), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
    finally:
        folded.unlink(missing_ok=True)


def zerotts_int8(model_dir: Path, quantize: Any = quantize_zerotts_graph) -> Path:
    """The int8 copy of a pinned ZeroTTS folder, built once beside it.

    Why: ZeroTTS's fp32 graphs are memory-bound, and on a Windows desktop they
    ran SLOWER than real time (i5-13400F, RTF 1.20 at 4 threads); the int8 copy
    ran at 0.41 there and 0.14 on an M4 Pro (fp32 0.245), reading as accurately
    (all eight voices: WER 5.3 % against 5.1 %, CER 2.2 % both, no garbled line;
    Phase 0, 2026-11-18). ZeroTTS hosts no int8 copy, so it is built here: about
    a minute on Windows, 6 s on the Mac, once per model revision, 309 MB.

    Built in a ``.partial`` folder and renamed into place with its marker written
    last, so a crash mid-build never leaves a folder that looks complete.
    """
    import shutil  # noqa: PLC0415

    dest = model_dir.parent / f"{model_dir.name}-int8"
    stamp = f"{(model_dir / pinned.MARKER).read_text(encoding='utf-8').strip()}|{ZEROTTS_INT8_RECIPE}"
    try:
        if (dest / ZEROTTS_INT8_MARKER).read_text(encoding="utf-8").strip() == stamp:
            return dest
    except OSError:
        pass
    tmp = model_dir.parent / f"{model_dir.name}-int8.partial-{os.getpid()}"
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        # Everything but the hot graphs (rewritten below) and the HF download cache.
        shutil.copytree(model_dir, tmp, ignore=shutil.ignore_patterns(".cache", pinned.MARKER, *ZEROTTS_HOT_GRAPHS))
        for name in ZEROTTS_HOT_GRAPHS:
            quantize(model_dir / "onnx" / name, tmp / "onnx" / name)
        (tmp / ZEROTTS_INT8_MARKER).write_text(stamp, encoding="utf-8")
        shutil.rmtree(dest, ignore_errors=True)
        os.replace(tmp, dest)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return dest


class ZeroTTSEngine(PresetEngine):
    """8 Vietnamese preset voices, 48 kHz. Generation samples from numpy's
    global generator, so the per-voice seed makes it reproducible. Speaks from
    int8 graphs (zerotts_int8), the fp32 ones only when those cannot be built."""

    name = "zerotts"
    variant = "zerotts"
    sample_rate = 48_000
    module = "zerotts"
    repo = pinned.ZEROTTS
    voices_table = ZEROTTS_VOICES

    def __init__(self) -> None:
        super().__init__()
        #: "int8" or "fp32" once loaded. Not the device note: the runner logs
        #: that as a warning (a GPU pack that fell back to the CPU).
        self.precision: str | None = None

    def _load(self, model_dir: Path, threads: int) -> Any:
        from zerotts import ZeroTTS  # type: ignore  # noqa: PLC0415

        try:
            graphs, self.precision = zerotts_int8(model_dir), "int8"
        except Exception as exc:  # noqa: BLE001 - e.g. a pack built before `onnx` was in it
            logger.warning("Could not build ZeroTTS's int8 graphs (%s); speaking with the fp32 ones.", exc)
            graphs, self.precision = model_dir, "fp32"
        logger.info("Loading ZeroTTS (%s, %d threads)…", self.precision, threads)
        tts = ZeroTTS(graphs, intra_op_num_threads=threads, warmup=True)
        self.sample_rate = int(getattr(tts, "sample_rate", 48_000))
        return tts

    def _speak(self, text: str, voice: PresetVoice, language: str, speed: float) -> Any:
        import numpy as np  # noqa: PLC0415

        return np.asarray(self._backend.synthesize(text, voice=voice.sdk_name), dtype=np.float32).reshape(-1)


# ---- Kokoro ----------------------------------------------------------------------

#: The language a Kokoro voice speaks, from its code's first letter, and the
#: espeak-ng language kokoro-onnx phonemizes it with (except MISAKI_CODES).
KOKORO_LANGS = {
    "a": ("en-US", "en-us"),
    "b": ("en-GB", "en-gb"),
    "e": ("es-ES", "es"),
    "f": ("fr-FR", "fr-fr"),
    "h": ("hi-IN", "hi"),
    "i": ("it-IT", "it"),
    "j": ("ja-JP", "ja"),
    "p": ("pt-BR", "pt-br"),
    "z": ("zh-CN", "cmn"),
}
KOKORO_CODES = (
    "af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky "
    "am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa "
    "bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis "
    "ef_dora em_alex em_santa ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola "
    "jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo pf_dora pm_alex pm_santa "
    "zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang"
).split()
KOKORO_RECOMMENDED = {"af_heart", "bf_emma", "ef_dora", "ff_siwis", "hf_alpha", "if_sara", "jf_alpha", "pf_dora", "zf_xiaobei"}

#: Japanese and Chinese get their phonemes from misaki, the G2P Kokoro's voices
#: for them were trained on, not from espeak-ng. Through espeak-ng every kanji
#: came out as its NAME: "こんにちは。これは私の声です。…" became 20-25 s of
#: "Chinese letter, Japanese letter…" for all five Japanese voices, and the
#: Chinese voices lost their tones ("你好" heard back as "你要做事"). Whisper
#: large-v3 on the voice previews, 2026-11-18. misaki's Japanese is cutlet over
#: fugashi + UniDic-lite (JAG2P's default, imported directly because misaki.ja
#: also imports pyopenjtalk, which has no wheels); Chinese is ZHG2P's 1.0 path
#: (jieba + pypinyin), the one for the v1.0 model this pack runs.
MISAKI_CODES = frozenset("jz")
KOKORO_VOICES = tuple(
    PresetVoice(
        f"kokoro-{code}",
        code,
        code[3:].capitalize(),
        "female" if code[1] == "f" else "male",
        (KOKORO_LANGS[code[0]][0],),
        recommended=code in KOKORO_RECOMMENDED,
    )
    for code in KOKORO_CODES
)


def kokoro_voice_pack(voices_dir: Path, out: Path) -> Path:
    """kokoro-onnx reads every voice from ONE .npz; the pinned repo ships one raw
    float32 file per voice (510 x 1 x 256). Build the npz once, beside the model
    (never inside the pinned folder, whose marker vouches for its contents)."""
    import numpy as np  # noqa: PLC0415

    if out.is_file():
        return out
    arrays = {p.stem: np.fromfile(p, dtype=np.float32).reshape(-1, 1, 256) for p in sorted(voices_dir.glob("*.bin"))}
    if not arrays:
        raise EngineUnavailable(f"No Kokoro voices in {voices_dir}")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f"{out.stem}.{os.getpid()}.partial.npz")
    np.savez(tmp, **arrays)
    clipcache.replace_with_retry(tmp, out)
    return out


class KokoroEngine(PresetEngine):
    """54 voices in 9 locales, 24 kHz, with a native speaking rate."""

    name = "kokoro"
    variant = "kokoro"
    sample_rate = 24_000
    supports_speed = True
    module = "kokoro_onnx"
    repo = pinned.KOKORO
    voices_table = KOKORO_VOICES

    def __init__(self) -> None:
        super().__init__()
        #: misaki G2P per voice-code letter, made on first use (under the synth lock).
        self._g2p: dict[str, Any] = {}

    def _key_extra(self, voice: PresetVoice) -> str:
        # A take phonemized by espeak-ng must never be reused for misaki's.
        return f"|g2p=misaki-{_misaki_version()}" if voice.sdk_name[0] in MISAKI_CODES else ""

    def _misaki(self, code: str) -> Any:
        g2p = self._g2p.get(code)
        if g2p is None:
            try:
                if code == "j":
                    from misaki.cutlet import Cutlet  # noqa: PLC0415

                    g2p = Cutlet()
                else:
                    from misaki.zh import ZHG2P  # noqa: PLC0415

                    g2p = ZHG2P()
            except ImportError as exc:
                raise EngineUnavailable(
                    "This Kokoro engine pack is too old to speak Japanese or Chinese correctly: "
                    "update it in Settings → Engines."
                ) from exc
            self._g2p[code] = g2p
        return g2p

    def _load(self, model_dir: Path, threads: int) -> Any:
        import onnxruntime as ort  # noqa: PLC0415
        from kokoro_onnx import Kokoro  # type: ignore  # noqa: PLC0415

        npz = kokoro_voice_pack(model_dir / "voices", model_dir.parent / f"{model_dir.name}-derived" / "voices.npz")
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        logger.info("Loading Kokoro (%d threads)…", threads)
        session = ort.InferenceSession(str(model_dir / "onnx" / "model.onnx"), so, providers=["CPUExecutionProvider"])
        return Kokoro.from_session(session, voices_path=str(npz))

    def _speak(self, text: str, voice: PresetVoice, language: str, speed: float) -> Any:
        import numpy as np  # noqa: PLC0415

        # A Kokoro voice speaks its own language; the project's must match
        # (the library and the run gate check that).
        code = voice.sdk_name[0]
        if code in MISAKI_CODES:
            phonemes, _ = self._misaki(code)(text)
            if not phonemes.strip():
                raise ValueError("no speakable text")
            audio, sr = self._backend.create(phonemes, voice=voice.sdk_name, speed=speed, is_phonemes=True)
        else:
            audio, sr = self._backend.create(text, voice=voice.sdk_name, speed=speed, lang=KOKORO_LANGS[code][1])
        self.sample_rate = int(sr)
        return np.asarray(audio, dtype=np.float32).reshape(-1)


def _misaki_version() -> str:
    try:
        from importlib.metadata import version  # noqa: PLC0415

        return version("misaki")
    except Exception:  # noqa: BLE001 - not installed: synthesis says so
        return "missing"


# ---- Supertonic 3 ----------------------------------------------------------------

#: Supertonic 3's 31 languages (its model card).
SUPERTONIC_LANGS = (
    "en ko ja ar bg cs da de el es et fi fr hi hr hu id it lt lv nl pl pt ro ru sk sl sv tr uk vi"
).split()
SUPERTONIC_VOICES = tuple(
    PresetVoice(f"supertonic-{s.lower()}", s, s, "female" if s[0] == "F" else "male", tuple(SUPERTONIC_LANGS), recommended=s in ("F1", "M1"))
    for s in ("F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5")
)
#: Flow-matching steps: the sample code's default quality setting.
SUPERTONIC_STEPS = 8


class SupertonicEngine(PresetEngine):
    """10 voices, each in 31 languages, 44.1 kHz, native speaking rate. Archived
    upstream (no fixes will come); the inference loop is Supertone's MIT
    sample (supertonic_helper.py). The latent noise comes from numpy's global
    generator, so the per-voice seed makes it reproducible."""

    name = "supertonic"
    variant = "supertonic"
    sample_rate = 44_100
    supports_speed = True
    module = "onnxruntime"
    repo = pinned.SUPERTONIC
    voices_table = SUPERTONIC_VOICES

    def __init__(self) -> None:
        super().__init__()
        self._styles: dict[str, Any] = {}
        self._styles_dir: Path | None = None

    def _load(self, model_dir: Path, threads: int) -> Any:
        import onnxruntime as ort  # noqa: PLC0415

        from . import supertonic_helper as H  # noqa: PLC0415

        onnx_dir = str(model_dir / "onnx")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        logger.info("Loading Supertonic 3 (%d threads)…", threads)
        dp, te, ve, voc = H.load_onnx_all(onnx_dir, opts, ["CPUExecutionProvider"])
        tts = H.TextToSpeech(H.load_cfgs(onnx_dir), H.load_text_processor(onnx_dir), dp, te, ve, voc)
        self.sample_rate = int(tts.sample_rate)
        self._styles_dir = model_dir / "voice_styles"
        return tts

    def _style(self, name: str) -> Any:
        from . import supertonic_helper as H  # noqa: PLC0415

        if name not in self._styles:
            self._styles[name] = H.load_voice_style([str(self._styles_dir / f"{name}.json")])
        return self._styles[name]

    def _speak(self, text: str, voice: PresetVoice, language: str, speed: float) -> Any:
        import numpy as np  # noqa: PLC0415

        lang = base_language(language)
        if lang not in SUPERTONIC_LANGS:
            raise ValueError(f"Supertonic 3 does not speak '{language}'")
        # The sample's default pace is 1.05; the requested rate scales it.
        wav, dur = self._backend(text, lang, self._style(voice.sdk_name), SUPERTONIC_STEPS, 1.05 * speed)
        n = int(self.sample_rate * float(np.asarray(dur).reshape(-1)[0]))
        return np.asarray(wav, dtype=np.float32).reshape(-1)[:n]


ADAPTERS: dict[str, type[PresetEngine]] = {
    "zerotts": ZeroTTSEngine,
    "kokoro": KokoroEngine,
    "supertonic": SupertonicEngine,
}


def make_adapter(name: str) -> PresetEngine | None:
    cls = ADAPTERS.get((name or "").strip().lower())
    return cls() if cls else None


def table_digest() -> str:
    """A hash of every preset table (a test pins the catalog to it)."""
    rows = [(v.id, v.sdk_name, v.gender, v.languages) for t in (ZEROTTS_VOICES, KOKORO_VOICES, SUPERTONIC_VOICES) for v in t]
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode("utf-8")).hexdigest()
