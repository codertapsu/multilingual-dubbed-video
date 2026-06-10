"""WAV helpers built on the Python standard library `wave` module.

No numpy / no third-party audio libs — this keeps the dev fallback engine
dependency-free so the whole pipeline is testable out of the box.

All audio written here is 16-bit signed PCM, mono.
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

# 16-bit signed PCM bounds.
_SAMPLE_WIDTH_BYTES = 2  # 16-bit
_MAX_AMPLITUDE = 32767
_CHANNELS = 1  # mono


def _ms_to_frames(duration_ms: int, sample_rate: int) -> int:
    """Convert a duration in milliseconds to a whole number of audio frames."""
    if duration_ms <= 0:
        return 0
    # Round to nearest frame to avoid systematically truncating durations.
    return int(round(sample_rate * duration_ms / 1000.0))


def write_silent_wav(
    path: str | Path,
    duration_ms: int,
    sample_rate: int = 22050,
) -> None:
    """Write a mono 16-bit PCM WAV of pure silence.

    Args:
        path: Destination .wav path. Parent dirs are created.
        duration_ms: Desired length in milliseconds (clamped to >= 0).
        sample_rate: Sample rate in Hz.
    """
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    n_frames = _ms_to_frames(max(0, duration_ms), sample_rate)
    silence = b"\x00\x00" * n_frames  # 16-bit zero samples

    with wave.open(str(out), "wb") as wav:
        wav.setnchannels(_CHANNELS)
        wav.setsampwidth(_SAMPLE_WIDTH_BYTES)
        wav.setframerate(sample_rate)
        wav.writeframes(silence)


def write_sine_wav(
    path: str | Path,
    duration_ms: int,
    sample_rate: int = 22050,
    frequency_hz: float = 220.0,
    amplitude: float = 0.06,
) -> None:
    """Write a mono 16-bit PCM WAV containing a low-volume sine tone.

    Useful as an audible dev placeholder (so you can hear that a segment was
    "spoken" even without a real TTS engine). Volume is intentionally low.

    Args:
        path: Destination .wav path. Parent dirs are created.
        duration_ms: Desired length in milliseconds (clamped to >= 0).
        sample_rate: Sample rate in Hz.
        frequency_hz: Tone frequency.
        amplitude: 0.0..1.0 fraction of full scale (kept low by default).
    """
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    n_frames = _ms_to_frames(max(0, duration_ms), sample_rate)
    amp = max(0.0, min(1.0, amplitude)) * _MAX_AMPLITUDE
    two_pi_f = 2.0 * math.pi * frequency_hz

    # Build the sample buffer. struct.pack with a format string is fast enough
    # for the short clips this worker produces and avoids a numpy dependency.
    frames = bytearray()
    if n_frames > 0:
        # Apply a short linear fade in/out (~5ms) to avoid click artifacts.
        fade = min(n_frames // 2, _ms_to_frames(5, sample_rate)) or 0
        for i in range(n_frames):
            sample = amp * math.sin(two_pi_f * (i / sample_rate))
            if fade:
                if i < fade:
                    sample *= i / fade
                elif i >= n_frames - fade:
                    sample *= (n_frames - 1 - i) / fade
            frames += struct.pack("<h", int(sample))

    with wave.open(str(out), "wb") as wav:
        wav.setnchannels(_CHANNELS)
        wav.setsampwidth(_SAMPLE_WIDTH_BYTES)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(frames))


def read_wav_duration_ms(path: str | Path) -> int:
    """Return the duration of a WAV file in integer milliseconds.

    Reads the header via the `wave` module: duration = nframes / framerate.

    Raises:
        wave.Error / FileNotFoundError if the file is missing or not a WAV.
    """
    with wave.open(str(path), "rb") as wav:
        n_frames = wav.getnframes()
        framerate = wav.getframerate()

    if framerate <= 0:
        return 0
    return int(round(n_frames * 1000.0 / framerate))
