"""Where speech is in an audio file: the "speech map" the orchestrator uses to
anchor transcript lines to the moment they are actually spoken.

Why it exists: both speech-to-text engines can stretch a short line across
seconds of music or fighting. faster-whisper does it when its own VAD restores
timestamps across a removed gap (a line's first word lands in the previous
speech chunk's padding); whisper.cpp does it when a 30-second window opens on
non-speech. On a real 31-minute Chinese video 15.5% of lines started a median
7 s early (max 46 s), so the dub was voiced before the speaker spoke and the
subtitle sat on screen through the music. faster-whisper's word timings fix its
own lines; whisper.cpp returns no usable word timings, so its lines need this.

Uses the Silero model that ships INSIDE faster-whisper, so it needs no download
and works whichever engine transcribed the project. It is finer than the
transcription VAD (300 ms silence / 100 ms pad against 2000 / 400) because the
goal here is boundaries, not chunks to transcribe.
"""

from __future__ import annotations

import logging

from .schemas import SpeechRegion, SpeechRegionsRequest, SpeechRegionsResponse
from .whisper_service import _load_audio_samples

logger = logging.getLogger("videodubber.stt.vad")

SAMPLE_RATE = 16000


def speech_regions(req: SpeechRegionsRequest) -> SpeechRegionsResponse:
    # Heavy import (onnxruntime), loaded on first use like the model itself.
    from faster_whisper.vad import VadOptions, get_speech_timestamps  # noqa: PLC0415

    audio = _load_audio_samples(req.audioPath)
    options = VadOptions(
        threshold=req.threshold,
        min_silence_duration_ms=req.minSilenceMs,
        speech_pad_ms=req.padMs,
    )
    stamps = get_speech_timestamps(audio, options, sampling_rate=SAMPLE_RATE)
    regions = [
        SpeechRegion(
            startMs=round(s["start"] * 1000 / SAMPLE_RATE),
            endMs=round(s["end"] * 1000 / SAMPLE_RATE),
        )
        for s in stamps
    ]
    duration_ms = round(len(audio) * 1000 / SAMPLE_RATE)
    logger.info("Speech map for %s: %d regions over %d ms.", req.audioPath, len(regions), duration_ms)
    return SpeechRegionsResponse(durationMs=duration_ms, regions=regions)
