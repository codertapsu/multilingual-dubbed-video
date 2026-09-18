"""TTS engines and engine selection.

Priority order (highest first):

    1. PiperEngine    — invokes the Piper *binary* via subprocess (offline, best quality).
    2. SystemEngine   — OS built-in TTS: macOS `say`, Linux `espeak-ng`,
                        Windows SAPI (System.Speech, via PowerShell).
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
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Protocol, runtime_checkable

from app.config import Settings
from app.wavutil import write_silent_wav

logger = logging.getLogger("tts.engines")

# Default length for a fallback clip when no segment window is known.
_FALLBACK_DEFAULT_MS = 1200
# Hard cap on external-process runtime so a stuck binary cannot hang the worker.
_SUBPROCESS_TIMEOUT_S = 120

# Tighter cap for the one-off Windows voice enumeration. It sits on the /health
# path (capabilities() -> SystemEngine.available()), and the orchestrator probes
# health with a 3 s budget, so a wedged PowerShell must not hold a worker thread
# for the full two minutes: report "no system voices" and move on.
_SAPI_LIST_TIMEOUT_S = 10

# Windows allocates a fresh console window for every console-subsystem child of a
# process that has no console of its own — and the orchestrator has none (Tauri's
# shell plugin spawns it with CREATE_NO_WINDOW). Without this flag each engine or
# ffmpeg call pops a black CMD window that steals focus, on the one platform where
# the user has already had to click through a SmartScreen warning. Zero elsewhere:
# CREATE_NO_WINDOW does not exist off Windows.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


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
        creationflags=_NO_WINDOW,
    )


def model_language(model_filename: str) -> str:
    """Base language subtag encoded in a Piper voice filename.

    Piper voices are named `<lang>_<REGION>-<dataset>-<quality>.onnx`,
    e.g. "vi_VN-vais1000-medium.onnx" -> "vi", "en_US-lessac-medium.onnx" -> "en".
    Returns "" if the name has no recognizable language prefix.
    """
    stem = Path(model_filename).name
    if stem.endswith(".onnx"):
        stem = stem[: -len(".onnx")]
    lang = stem.split("-")[0].split("_")[0].strip().lower()
    return lang if lang.isalpha() and 2 <= len(lang) <= 3 else ""


class PiperEngine:
    """Local neural TTS via the Piper binary.

    Invocation: `piper --model voice.onnx --output_file out.wav`, feeding the
    text on stdin. We deliberately do NOT depend on the `piper-tts` Python
    package in-process; only the binary + a .onnx voice model are needed.

    Voice models are resolved PER LANGUAGE, in precedence order:
        1. an explicit request voice that is a path to an .onnx file,
        2. the configured PIPER_VOICE_MODEL_PATH (if it matches the language),
        3. any *.onnx in the voices dir (PIPER_VOICES_DIR, default
           ~/VideoDubber/models/piper) whose filename matches the language.

    A model whose filename does not match the requested language is never used:
    synthesizing Vietnamese text through an English voice (or vice versa) is
    strictly worse than letting selection fall through to another engine.
    """

    name = "piper"

    def __init__(self, settings: Settings) -> None:
        self._binary = settings.piper_binary_path
        self._model = settings.piper_voice_model_path
        self._voices_dir = settings.piper_voices_dir

    def _binary_ok(self) -> bool:
        if not self._binary:
            return False
        return Path(self._binary).is_file() or shutil.which(self._binary) is not None

    def candidate_models(self) -> list[Path]:
        """All installed voice models, configured model first."""
        candidates: list[Path] = []
        if self._model and Path(self._model).is_file():
            candidates.append(Path(self._model))
        try:
            for p in sorted(self._voices_dir.glob("*.onnx")):
                if p.is_file() and p not in candidates:
                    candidates.append(p)
        except OSError:
            pass
        return candidates

    def model_for(self, language: str, voice: str | None = None) -> Path | None:
        """Resolve the voice model to use for a base language subtag."""
        if voice and voice.endswith(".onnx") and Path(voice).is_file():
            return Path(voice)
        candidates = self.candidate_models()
        if not language:
            return candidates[0] if candidates else None
        for model in candidates:
            if model_language(model.name) == language:
                return model
        return None

    def available(self) -> bool:
        return self._binary_ok() and bool(self.candidate_models())

    def supports(self, language: str) -> bool:
        """True if Piper can speak `language` (a matching voice is installed)."""
        return self._binary_ok() and self.model_for(language) is not None

    def voice_key(self, language: str, voice: str | None) -> str:
        """Stable identity of the audio this engine would produce (for caching)."""
        model = self.model_for(language, voice)
        return f"piper:{model.name if model else 'none'}"

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
        model = self.model_for(language, voice)
        if model is None or not self._binary_ok():
            raise RuntimeError(
                f"Piper has no voice for language '{language or 'any'}' "
                f"(voices dir: {self._voices_dir})"
            )

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


def parse_say_voices(listing: str) -> list[tuple[str, str]]:
    """Parse `say -v ?` output into (voice_name, locale) pairs.

    Lines look like: "Linh                vi_VN    # Xin chào ..." — the name may
    contain spaces ("Bad News"), so split on the locale token.
    """
    voices: list[tuple[str, str]] = []
    for line in listing.splitlines():
        m = _SAY_VOICE_RE.match(line)
        if m:
            voices.append((m.group(1).strip(), m.group(2)))
    return voices


_SAY_VOICE_RE = re.compile(
    r"^(.+?)\s+([a-z]{2,3}[_-][A-Za-z]{2,8}(?:[_-][A-Za-z0-9]+)?)\s+#"
)


def parse_sapi_voices(listing: str) -> list[tuple[str, str]]:
    """Parse the Windows voice listing into (voice_name, culture) pairs.

    `_windows_voices` asks PowerShell for one voice per line as
    "Microsoft Zira Desktop\ten-US". A voice name can contain spaces, so the
    separator is a TAB, never whitespace.
    """
    voices: list[tuple[str, str]] = []
    for line in listing.splitlines():
        name, tab, culture = line.partition("\t")
        if not tab:
            continue
        name, culture = name.strip(), culture.strip()
        if name and culture:
            voices.append((name, culture))
    return voices


def sapi_rate(speed: float) -> int:
    """Map a speed multiplier to a SAPI rate (-10..10, 0 = normal).

    SAPI's scale is roughly exponential and not documented as a ratio, so this
    is an approximation in the same spirit as the `say -r` / espeak `-s`
    mappings above: the real fit to the segment window happens downstream in
    the alignment/ffmpeg stage.
    """
    return max(-10, min(10, round((speed - 1.0) * 10)))


def _ps_quote(value: str) -> str:
    """Quote a string as a PowerShell single-quoted literal."""
    return "'" + str(value).replace("'", "''") + "'"


def build_sapi_script(text_path: str, out_path: str, voice: str | None, rate: int) -> str:
    """Build the PowerShell script that speaks a UTF-8 text file into a WAV.

    The text is passed via a FILE read with an explicit UTF-8 encoding rather
    than on the command line or stdin: Vietnamese is the flagship target
    language and the console's default code page mangles its diacritics.
    """
    lines = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Speech",
        "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    ]
    if voice:
        lines.append(f"$synth.SelectVoice({_ps_quote(voice)})")
    lines += [
        f"$synth.Rate = {int(rate)}",
        f"$synth.SetOutputToWaveFile({_ps_quote(out_path)})",
        f"$text = [System.IO.File]::ReadAllText({_ps_quote(text_path)}, "
        "[System.Text.Encoding]::UTF8)",
        "$synth.Speak($text)",
        "$synth.Dispose()",
    ]
    return "\n".join(lines) + "\n"


class SystemEngine:
    """OS built-in TTS.

    * macOS:   `say -o tmp.aiff` then convert to WAV with `afconvert` (or ffmpeg).
    * Linux:   `espeak-ng -w out.wav`.
    * Windows: SAPI (`System.Speech.Synthesis.SpeechSynthesizer`) driven through
      PowerShell — no new dependency, present on every supported Windows build.

    Windows had NO branch here, so a Windows user whose Piper voice was missing
    fell straight through to the silent fallback while macOS and Linux users got
    intelligible speech for the same input: the worst case differed by OS. Note
    what this does and does not buy: Windows ships no Vietnamese SAPI voice by
    default, so for the flagship vi target `supports()` still returns False (by
    design — see below) and the fallback still applies. It is a real safety net
    for the languages Windows does ship, and it removes the asymmetry.

    Language support is checked before use: a system voice matching the target
    language is selected (macOS `say -v ?`; Windows `GetInstalledVoices()`;
    espeak `-v <lang>`). If the OS has no voice for the language, this engine
    reports itself as unsupported so the request never gets read aloud in the
    wrong language.
    """

    name = "system"

    def __init__(self, settings: Settings) -> None:
        self._ffmpeg = settings.ffmpeg_path or shutil.which("ffmpeg")
        self._is_macos = sys.platform == "darwin"
        self._is_linux = sys.platform.startswith("linux")
        self._is_windows = sys.platform == "win32"
        self._say_voices: list[tuple[str, str]] | None = None  # lazy, cached
        self._sapi_voices: list[tuple[str, str]] | None = None  # lazy, cached
        self._sapi_lock = threading.Lock()  # see _windows_voices

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

    @property
    def _powershell(self) -> str | None:
        if not self._is_windows:
            return None
        return shutil.which("powershell") or shutil.which("pwsh")

    def available(self) -> bool:
        if self._is_macos:
            # `say` plus a way to get to WAV (afconvert ships with macOS; ffmpeg ok too).
            return bool(self._say and (self._afconvert or self._ffmpeg))
        if self._is_linux:
            return self._espeak is not None
        if self._is_windows:
            # PowerShell alone is not enough — a Windows install can have the
            # speech assembly present but zero installed voices, and reporting
            # "system: true" there would be a lie in /health. The listing is
            # cached, so this costs one PowerShell run per process.
            return bool(self._powershell) and bool(self._windows_voices())
        return False

    # --- language support -------------------------------------------------------

    def _macos_voices(self) -> list[tuple[str, str]]:
        """Installed `say` voices as (name, locale), cached after first query."""
        if self._say_voices is None:
            self._say_voices = []
            say = self._say
            if say:
                try:
                    proc = _run_subprocess([say, "-v", "?"], timeout=15)
                    self._say_voices = parse_say_voices(proc.stdout.decode("utf-8", "replace"))
                except (OSError, subprocess.SubprocessError) as exc:
                    logger.warning("could not list `say` voices: %s", exc)
        return self._say_voices

    def _windows_voices(self) -> list[tuple[str, str]]:
        """Installed SAPI voices as (name, culture), cached after first query.

        Locked, and published in a SINGLE assignment. Unlike `_macos_voices`
        (whose `say -v ?` costs a millisecond), this enumeration spawns
        PowerShell, and both /health and /voices reach it from FastAPI's
        threadpool — i.e. genuinely in parallel. The "assign [] first, then fill
        it in" shape would let a concurrent probe read the empty placeholder
        while the listing is still running and conclude `system: false` on a
        machine that does have voices, which is enough to push a segment onto
        the silent fallback.
        """
        cached = self._sapi_voices
        if cached is not None:
            return cached
        with self._sapi_lock:
            # Double-checked: another thread may have finished the listing.
            if self._sapi_voices is not None:
                return self._sapi_voices
            voices: list[tuple[str, str]] = []
            shell = self._powershell
            if shell:
                script = (
                    "Add-Type -AssemblyName System.Speech; "
                    "(New-Object System.Speech.Synthesis.SpeechSynthesizer)"
                    ".GetInstalledVoices() | ForEach-Object { "
                    "$i = $_.VoiceInfo; \"$($i.Name)`t$($i.Culture.Name)\" }"
                )
                try:
                    proc = _run_subprocess(
                        [shell, "-NoProfile", "-NonInteractive", "-Command", script],
                        timeout=_SAPI_LIST_TIMEOUT_S,
                    )
                    voices = parse_sapi_voices(proc.stdout.decode("utf-8", "replace"))
                except (OSError, subprocess.SubprocessError) as exc:
                    logger.warning("could not list SAPI voices: %s", exc)
            self._sapi_voices = voices
            return voices

    def _installed_voices(self) -> list[tuple[str, str]]:
        """(name, locale) pairs for whichever OS voice catalog applies."""
        if self._is_macos:
            return self._macos_voices()
        if self._is_windows:
            return self._windows_voices()
        return []

    def voice_for_language(self, language: str) -> str | None:
        """An OS voice name matching the base language subtag, if any.

        macOS reports locales as "vi_VN" and Windows as "vi-VN"; both reduce to
        the same prefix test.
        """
        if not language or not (self._is_macos or self._is_windows):
            return None
        prefix = language.lower()
        for name, locale in self._installed_voices():
            if locale.lower().replace("-", "_").startswith(prefix):
                return name
        return None

    def supports(self, language: str) -> bool:
        """True if the OS can speak `language` with a native voice.

        Without a matching voice the OS default (typically English) would read
        the text in the wrong language — refuse instead so selection moves on.
        """
        if not self.available():
            return False
        if not language:
            return True
        if self._is_macos or self._is_windows:
            # Windows in particular ships no Vietnamese voice: returning False
            # here is what keeps selection moving on instead of reading vi text
            # with an en-US voice.
            return self.voice_for_language(language) is not None
        # espeak-ng covers a very wide language set, including "vi"; trust the
        # `-v <lang>` selection we already pass in _synth_linux.
        return True

    def voice_key(self, language: str, voice: str | None) -> str:
        """Stable identity of the audio this engine would produce (for caching)."""
        chosen = voice or self.voice_for_language(language) or "default"
        if self._is_macos:
            flavor = "say"
        elif self._is_windows:
            flavor = "sapi"
        else:
            flavor = "espeak"
        return f"system:{flavor}:{chosen}:{language or 'any'}"

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
            self._synth_macos(text, out_path, language, voice, speed)
        elif self._is_linux:
            self._synth_linux(text, out_path, language, voice, speed)
        elif self._is_windows:
            self._synth_windows(text, out_path, language, voice, speed)
        else:
            raise RuntimeError(f"SystemEngine unsupported on {platform.system()}")
        logger.info("system(%s) synthesized -> %s", sys.platform, out_path)

    def _synth_macos(
        self, text: str, out_path: str, language: str, voice: str | None, speed: float
    ) -> None:
        say = self._say
        if not say:
            raise RuntimeError("macOS `say` not found")

        # Voice precedence: explicit voice, else a voice matching the language.
        # Never let `say` default to the (English) system voice for another
        # language — that reads e.g. Vietnamese text with English phonetics.
        chosen = voice or self.voice_for_language(language)
        if not chosen and language and language != "en":
            raise RuntimeError(f"macOS has no `say` voice for language '{language}'")

        aiff_path = str(Path(out_path).with_suffix(".aiff"))
        say_argv = [say, "-o", aiff_path]
        if chosen:
            say_argv += ["-v", chosen]
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


    def _synth_windows(
        self, text: str, out_path: str, language: str, voice: str | None, speed: float
    ) -> None:
        shell = self._powershell
        if not shell:
            raise RuntimeError("Windows PowerShell not found")

        # Same rule as macOS: never let SAPI fall back to the (usually en-US)
        # default voice for another language.
        chosen = voice or self.voice_for_language(language)
        if not chosen and language and language != "en":
            raise RuntimeError(f"Windows has no SAPI voice for language '{language}'")

        base = Path(out_path)
        text_path = base.with_suffix(".txt")
        script_path = base.with_suffix(".ps1")
        try:
            text_path.write_text(text, encoding="utf-8")
            # BOM: Windows PowerShell 5.1 reads a -File script as ANSI unless
            # one is present, which would corrupt a non-ASCII voice name.
            script_path.write_text(
                build_sapi_script(str(text_path), out_path, chosen, sapi_rate(speed)),
                encoding="utf-8-sig",
            )
            _run_subprocess(
                [
                    shell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script_path),
                ]
            )
        finally:
            for tmp in (text_path, script_path):
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass


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

    def supports(self, language: str) -> bool:  # noqa: D102 — speaks "silence" fluently
        return True

    def voice_key(self, language: str, voice: str | None) -> str:  # noqa: D102
        return "fallback:sine" if self._use_sine else "fallback:silent"

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

    def best_for(self, language: str) -> Engine:
        """Return the highest-priority engine that can SPEAK `language`.

        Unlike `best_available`, this never picks an engine that would read the
        text in the wrong language (e.g. macOS `say` defaulting to English for
        Vietnamese text). If no real engine has a voice for the language, the
        silent fallback is returned — wrong-language audio is worse than
        silence flagged for review.
        """
        for engine in self._ordered:
            if engine_supports(engine, language):
                return engine
        return self.fallback


def engine_supports(engine: Engine, language: str) -> bool:
    """Duck-typed language support check (test fakes may omit `supports`)."""
    fn = getattr(engine, "supports", None)
    if callable(fn):
        return bool(fn(language))
    return engine.available()


def engine_voice_key(engine: Engine, language: str, voice: str | None) -> str:
    """Duck-typed voice identity for cache keys (test fakes may omit it)."""
    fn = getattr(engine, "voice_key", None)
    if callable(fn):
        return str(fn(language, voice))
    return f"{engine.name}:{voice or 'default'}"


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
