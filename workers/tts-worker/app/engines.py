"""TTS engines and engine selection.

Priority order (highest first):

    1. PiperEngine    — invokes the Piper *binary* via subprocess (offline, best quality).
    2. SystemEngine   — OS built-in TTS: macOS `say`, linux `espeak-ng`.
    3. FallbackEngine — silent (or soft sine) WAV sized to the segment window.
                        ALWAYS available, zero external dependencies.

Each engine implements the `Engine` protocol. The fallback guarantees the whole
pipeline works even with no TTS software installed.

Forcing an engine: a caller may prefix `voiceId` with an engine name, e.g.
"fallback", "piper:my-voice", "system:Alex". See `select_engine`.
"""

from __future__ import annotations

import logging
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Protocol, runtime_checkable

from app.config import Settings
from app.wavutil import write_silent_wav

logger = logging.getLogger("tts.engines")

# Default length for a fallback clip when no segment window is known.
_FALLBACK_DEFAULT_MS = 1200
# Hard cap on external-process runtime so a stuck binary cannot hang the worker.
_SUBPROCESS_TIMEOUT_S = 120


@runtime_checkable
class Engine(Protocol):
    """The synthesis contract every engine implements."""

    name: str

    def available(self) -> bool:
        """True if this engine can run on the current machine/config."""
        ...

    def synth(
        self,
        text: str,
        out_path: str,
        language: str,
        voice: str | None,
        speed: float,
        *,
        window_ms: int = 0,
    ) -> None:
        """Synthesize `text` into a WAV at `out_path`.

        Args:
            text: Text to speak.
            out_path: Destination WAV path (parent dirs created by caller).
            language: Base language subtag (e.g. "vi", "en").
            voice: Engine-specific voice id (already stripped of the engine prefix).
            speed: Requested speed multiplier (engines may ignore; handled downstream).
            window_ms: Target segment window length in ms (used by the fallback).
        """
        ...


def _run_subprocess(
    argv: list[str],
    *,
    input_bytes: bytes | None = None,
    timeout: int = _SUBPROCESS_TIMEOUT_S,
) -> subprocess.CompletedProcess[bytes]:
    """Run an external command safely with an argv array (never a shell string)."""
    logger.debug("exec %s", " ".join(argv))
    return subprocess.run(  # noqa: S603 — argv array, no shell
        argv,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=True,
    )


class PiperEngine:
    """Local neural TTS via the Piper binary.

    Invocation: `piper --model voice.onnx --output_file out.wav`, feeding the
    text on stdin. We deliberately do NOT depend on the `piper-tts` Python
    package; only the binary + a .onnx voice model are needed.
    """

    name = "piper"

    def __init__(self, settings: Settings) -> None:
        self._binary = settings.piper_binary_path
        self._model = settings.piper_voice_model_path

    def available(self) -> bool:
        if not self._binary or not self._model:
            return False
        bin_ok = Path(self._binary).is_file() or shutil.which(self._binary) is not None
        model_ok = Path(self._model).is_file()
        return bool(bin_ok and model_ok)

    def synth(
        self,
        text: str,
        out_path: str,
        language: str,
        voice: str | None,
        speed: float,
        *,
        window_ms: int = 0,
    ) -> None:
        if not self.available():
            raise RuntimeError("Piper engine is not available")

        # voice may name an alternate model path; otherwise use the configured one.
        model = self._model
        if voice and Path(voice).is_file() and voice.endswith(".onnx"):
            model = voice

        argv = [
            str(self._binary),
            "--model",
            str(model),
            "--output_file",
            str(out_path),
        ]
        # Piper supports --length_scale to slow/speed speech: length_scale > 1
        # is slower. We map speed (rate multiplier) to 1/speed.
        if speed and speed > 0 and abs(speed - 1.0) > 1e-3:
            argv += ["--length_scale", f"{1.0 / speed:.4f}"]

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        _run_subprocess(argv, input_bytes=text.encode("utf-8"))
        logger.info("piper synthesized %d chars -> %s", len(text), out_path)


class SystemEngine:
    """OS built-in TTS.

    * macOS: `say -o tmp.aiff` then convert to WAV with `afconvert` (or ffmpeg).
    * Linux: `espeak-ng -w out.wav`.
    """

    name = "system"

    def __init__(self, settings: Settings) -> None:
        self._ffmpeg = settings.ffmpeg_path or shutil.which("ffmpeg")
        self._is_macos = sys.platform == "darwin"
        self._is_linux = sys.platform.startswith("linux")

    # --- capability detection -------------------------------------------------

    @property
    def _say(self) -> str | None:
        return shutil.which("say") if self._is_macos else None

    @property
    def _afconvert(self) -> str | None:
        return shutil.which("afconvert") if self._is_macos else None

    @property
    def _espeak(self) -> str | None:
        if not self._is_linux:
            return None
        return shutil.which("espeak-ng") or shutil.which("espeak")

    def available(self) -> bool:
        if self._is_macos:
            # `say` plus a way to get to WAV (afconvert ships with macOS; ffmpeg ok too).
            return bool(self._say and (self._afconvert or self._ffmpeg))
        if self._is_linux:
            return self._espeak is not None
        # Other platforms (e.g. Windows) — no built-in path wired up here.
        return False

    # --- synthesis ------------------------------------------------------------

    def synth(
        self,
        text: str,
        out_path: str,
        language: str,
        voice: str | None,
        speed: float,
        *,
        window_ms: int = 0,
    ) -> None:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        if self._is_macos:
            self._synth_macos(text, out_path, voice, speed)
        elif self._is_linux:
            self._synth_linux(text, out_path, language, voice, speed)
        else:
            raise RuntimeError(f"SystemEngine unsupported on {platform.system()}")
        logger.info("system(%s) synthesized -> %s", sys.platform, out_path)

    def _synth_macos(
        self, text: str, out_path: str, voice: str | None, speed: float
    ) -> None:
        say = self._say
        if not say:
            raise RuntimeError("macOS `say` not found")

        aiff_path = str(Path(out_path).with_suffix(".aiff"))
        say_argv = [say, "-o", aiff_path]
        if voice:
            say_argv += ["-v", voice]
        # `say` rate is words/minute; ~175 wpm is default. Scale by speed.
        if speed and speed > 0 and abs(speed - 1.0) > 1e-3:
            say_argv += ["-r", str(int(175 * speed))]
        say_argv += [text]
        _run_subprocess(say_argv)

        try:
            if self._afconvert:
                # Convert AIFF -> 16-bit PCM WAV.
                _run_subprocess(
                    [
                        self._afconvert,
                        "-f",
                        "WAVE",
                        "-d",
                        "LEI16",
                        aiff_path,
                        out_path,
                    ]
                )
            elif self._ffmpeg:
                _run_subprocess(
                    [self._ffmpeg, "-y", "-i", aiff_path, "-acodec", "pcm_s16le", out_path]
                )
            else:
                raise RuntimeError("No afconvert/ffmpeg to convert AIFF to WAV")
        finally:
            try:
                Path(aiff_path).unlink(missing_ok=True)
            except OSError:
                pass

    def _synth_linux(
        self, text: str, out_path: str, language: str, voice: str | None, speed: float
    ) -> None:
        espeak = self._espeak
        if not espeak:
            raise RuntimeError("espeak-ng/espeak not found")

        argv = [espeak, "-w", out_path]
        # Voice precedence: explicit voice id, else language subtag.
        if voice:
            argv += ["-v", voice]
        elif language:
            argv += ["-v", language]
        # espeak words-per-minute; default ~175.
        if speed and speed > 0 and abs(speed - 1.0) > 1e-3:
            argv += ["-s", str(int(175 * speed))]
        argv += [text]
        _run_subprocess(argv)


class FallbackEngine:
    """Always-available dev engine.

    Writes a silent WAV (default) sized to the segment window, so downstream
    alignment/mix/render stages have a real, correctly-timed audio file. This is
    what makes the whole pipeline testable with zero TTS software installed.

    Set `use_sine=True` for an audible (low-volume) placeholder tone instead.
    """

    name = "fallback"

    def __init__(self, settings: Settings, use_sine: bool = False) -> None:
        self._sample_rate = settings.default_sample_rate
        self._use_sine = use_sine

    def available(self) -> bool:  # noqa: D102 — always available
        return True

    def synth(
        self,
        text: str,
        out_path: str,
        language: str,
        voice: str | None,
        speed: float,
        *,
        window_ms: int = 0,
    ) -> None:
        duration_ms = window_ms if window_ms > 0 else _FALLBACK_DEFAULT_MS
        if self._use_sine:
            from app.wavutil import write_sine_wav

            write_sine_wav(out_path, duration_ms, sample_rate=self._sample_rate)
        else:
            write_silent_wav(out_path, duration_ms, sample_rate=self._sample_rate)
        logger.info(
            "fallback synthesized %dms %s -> %s",
            duration_ms,
            "sine" if self._use_sine else "silent",
            out_path,
        )


# ---------------------------------------------------------------------------
# Engine registry & selection
# ---------------------------------------------------------------------------


class EngineRegistry:
    """Builds the ordered engine list and resolves the engine for a request."""

    def __init__(self, settings: Settings) -> None:
        self.piper = PiperEngine(settings)
        self.system = SystemEngine(settings)
        self.fallback = FallbackEngine(settings)
        # Priority order, highest first.
        self._ordered: list[Engine] = [self.piper, self.system, self.fallback]

    def by_name(self, name: str) -> Engine | None:
        return {
            "piper": self.piper,
            "system": self.system,
            "fallback": self.fallback,
        }.get(name)

    def capabilities(self) -> dict[str, bool]:
        """Map of engine name -> availability (fallback is always True)."""
        return {
            "piper": self.piper.available(),
            "system": self.system.available(),
            "fallback": True,
        }

    def best_available(self) -> Engine:
        """Return the highest-priority available engine (fallback never fails)."""
        for engine in self._ordered:
            if engine.available():
                return engine
        # Unreachable — fallback.available() is always True — but keep it safe.
        return self.fallback


def parse_voice(voice_id: str | None) -> tuple[str | None, str | None]:
    """Split an optional voiceId into (forced_engine_name, voice).

    Recognized forms:
        None              -> (None, None)        auto-select
        "fallback"        -> ("fallback", None)
        "piper:my-voice"  -> ("piper", "my-voice")
        "system:Alex"     -> ("system", "Alex")
        "Alex"            -> (None, "Alex")       just a voice name
    """
    if not voice_id:
        return None, None

    vid = voice_id.strip()
    if not vid:
        return None, None

    # Bare engine name.
    if vid in ("piper", "system", "fallback"):
        return vid, None

    # "engine:voice" form.
    if ":" in vid:
        prefix, _, rest = vid.partition(":")
        if prefix in ("piper", "system", "fallback"):
            return prefix, (rest or None)

    # Otherwise it's just a voice name with no forced engine.
    return None, vid
