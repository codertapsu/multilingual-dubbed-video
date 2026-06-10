"""Synthesis orchestration: turn segments into WAV files and measure durations.

This layer ties together engine selection, the content-addressed cache, and the
on-disk naming convention (`segment_0001.wav`). It is deliberately framework-
agnostic so it can be unit-tested without HTTP.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import NamedTuple

from app.cache import AudioCache, cache_key
from app.config import Settings
from app.engines import (
    Engine,
    EngineRegistry,
    engine_voice_key,
    parse_voice,
)
from app.errors import output_not_writable, piper_missing, tts_voice_missing
from app.lang import to_tts_language
from app.schemas import SegmentIn, SegmentOut
from app.wavutil import read_wav_duration_ms


class SynthesisBatch(NamedTuple):
    """A batch synthesis outcome: which engine spoke + the per-segment results.

    `fallback_segments` counts segments that were SILENTLY replaced by the
    fallback engine after the selected engine errored at runtime — callers use
    it (together with `engine == "fallback"`) to warn that the output contains
    placeholder audio rather than real speech.
    """

    engine: str
    fallback_segments: int
    segments: list[SegmentOut]

logger = logging.getLogger("tts.service")

# Pull the TRAILING digits out of an id like "seg_0001" -> 1. Falls back to the
# ordinal if the id has no number. This MUST match the orchestrator's
# segmentIdToIndex() (/(\d+)\s*$/) so both sides derive the same filename for
# ids with multiple digit groups (e.g. "seg_001_v2" -> 2 on both sides).
_DIGITS_RE = re.compile(r"(\d+)\s*$")


def segment_filename(segment_id: str, ordinal: int) -> str:
    """Map a segment id to its WAV filename `segment_<4-digit>.wav`.

    Uses the trailing numeric part of the id (e.g. "seg_0007" ->
    "segment_0007.wav"). If the id has no digits, falls back to the 1-based
    ordinal.
    """
    match = _DIGITS_RE.search(segment_id or "")
    number = int(match.group(1)) if match else ordinal
    return f"segment_{number:04d}.wav"


class TtsService:
    """Stateless-ish synthesizer; holds engine registry + cache."""

    def __init__(self, settings: Settings, registry: EngineRegistry | None = None) -> None:
        self.settings = settings
        self.registry = registry or EngineRegistry(settings)
        self.cache = AudioCache(settings.cache_dir)

    # -- engine resolution -----------------------------------------------------

    def _resolve_engine(self, voice_id: str | None, language: str) -> tuple[Engine, str | None]:
        """Pick the engine for a request, honoring a forced-engine voice prefix.

        Selection is LANGUAGE-AWARE: an engine is only auto-picked if it can
        actually speak `language` (Piper needs a matching voice model, macOS
        `say` needs a matching system voice). Returns (engine, voice).

        Raises:
            TtsError(PIPER_MISSING)   if "piper:" forced but Piper unavailable.
            TtsError(TTS_VOICE_MISSING) if "system:" forced but unavailable.
        """
        forced_name, voice = parse_voice(voice_id)

        if forced_name is None:
            engine = self.registry.best_for(language)
            if engine.name == "fallback" and self.registry.best_available().name != "fallback":
                logger.warning(
                    "no TTS voice can speak '%s' — writing SILENT placeholders. "
                    "Install a Piper voice for this language (e.g. via first-run "
                    "setup) or set PIPER_VOICES_DIR.",
                    language or "(unknown)",
                )
            return engine, voice

        engine = self.registry.by_name(forced_name)
        if engine is None:  # defensive — parse_voice only returns known names
            raise tts_voice_missing(voice_id or forced_name)

        if not engine.available():
            if forced_name == "piper":
                raise piper_missing("PIPER_BINARY_PATH/PIPER_VOICES_DIR not set or files missing")
            if forced_name == "system":
                raise tts_voice_missing(voice_id or "system")
            # "fallback" is always available; anything else falls through.
        return engine, voice

    # -- output dir ------------------------------------------------------------

    def _ensure_output_dir(self, output_dir: str) -> Path:
        out = Path(output_dir).expanduser()
        try:
            out.mkdir(parents=True, exist_ok=True)
            # Verify writability with a throwaway probe file.
            probe = out / ".write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
        except OSError as exc:
            raise output_not_writable(str(out), str(exc)) from exc
        return out

    # -- single segment --------------------------------------------------------

    def _synth_one(
        self,
        engine: Engine,
        seg: SegmentIn,
        out_path: Path,
        language: str,
        voice: str | None,
        speed: float,
        voice_token: str,
    ) -> bool:
        """Synthesize a single segment, using the cache when possible.

        Falls back to the always-available FallbackEngine if the selected engine
        raises during synthesis (e.g. an external binary errors at runtime) —
        unless the engine *is* the fallback, in which case the error propagates.

        Returns True if the SILENT fallback replaced the selected engine.
        """
        window_ms = max(0, seg.endMs - seg.startMs)
        # `voice_token` identifies the engine + concrete voice/model, so audio
        # synthesized by one engine can never be served from the cache to a
        # request that would resolve to another (e.g. English `say` clips must
        # not satisfy a Piper Vietnamese request for the same text).
        key = cache_key(seg.id, seg.text, voice_token, speed)

        cached = self.cache.get(key)
        if cached is not None:
            self.cache.materialize(cached, out_path)
            logger.info("cache hit for %s (engine=%s)", seg.id, engine.name)
            return False

        used_fallback = False
        try:
            engine.synth(
                seg.text,
                str(out_path),
                language,
                voice,
                speed,
                window_ms=window_ms,
            )
        except Exception as exc:  # noqa: BLE001 — graceful degradation by design
            if engine.name == "fallback":
                raise
            logger.warning(
                "engine %s failed for %s (%s); falling back to silent WAV",
                engine.name,
                seg.id,
                exc,
            )
            used_fallback = True
            self.registry.fallback.synth(
                seg.text,
                str(out_path),
                language,
                None,
                speed,
                window_ms=window_ms,
            )

        # Populate the cache from the freshly written file — but never cache a
        # runtime-fallback (silent) clip under the real engine's key, or the
        # silence would keep being served after the engine is fixed.
        if not used_fallback and out_path.is_file():
            self.cache.put(key, out_path)
        return used_fallback

    # -- public API ------------------------------------------------------------

    def synthesize_segments(
        self,
        *,
        language: str,
        voice_id: str | None,
        segments: list[SegmentIn],
        output_dir: str,
        speed: float = 1.0,
    ) -> SynthesisBatch:
        """Synthesize every segment, returning the engine used + SegmentOuts.

        Notes on `speed`: the requested speed is passed through to engines that
        support it (Piper length_scale, say/espeak rate). The *effective fit* to
        the segment window is applied downstream by the alignment/ffmpeg stage,
        so `speedRatio` here echoes the requested speed.
        """
        out_dir = self._ensure_output_dir(output_dir)
        lang = to_tts_language(language)
        engine, voice = self._resolve_engine(voice_id, lang)
        voice_token = f"{engine_voice_key(engine, lang, voice)}|{voice_id or ''}"

        logger.info(
            "synthesize %d segment(s) lang=%s engine=%s voice=%s speed=%s",
            len(segments),
            lang or language,
            engine.name,
            voice or "(auto)",
            speed,
        )

        fallback_count = 0
        results: list[SegmentOut] = []
        for ordinal, seg in enumerate(segments, start=1):
            fname = segment_filename(seg.id, ordinal)
            out_path = out_dir / fname

            if self._synth_one(engine, seg, out_path, lang, voice, speed, voice_token):
                fallback_count += 1

            duration_ms = read_wav_duration_ms(out_path)
            results.append(
                SegmentOut(
                    segmentId=seg.id,
                    audioPath=str(out_path),
                    durationMs=duration_ms,
                    startMs=seg.startMs,
                    endMs=seg.endMs,
                    speedRatio=speed,
                )
            )

        return SynthesisBatch(engine.name, fallback_count, results)

    def resynth_single(
        self,
        *,
        language: str,
        voice_id: str | None,
        segment: SegmentIn,
        output_dir: str,
        speed: float = 1.0,
    ) -> SegmentOut:
        """Re-synthesize one segment (used by the single-segment endpoint).

        Reuses the same cache + naming logic as the batch path so a regenerated
        clip lands at the expected `segment_NNNN.wav`.
        """
        batch = self.synthesize_segments(
            language=language,
            voice_id=voice_id,
            segments=[segment],
            output_dir=output_dir,
            speed=speed,
        )
        return batch.segments[0]
