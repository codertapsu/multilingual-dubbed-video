"""WAV helpers for the OmniVoice engine (mono 16-bit PCM, 24 kHz).

Mirrors the bundled tts-worker / VieNeu contract. OmniVoice outputs 24 kHz mono;
the orchestrator's alignment/ffmpeg stage time-stretches each clip to its window
downstream, so the rate here only needs to be internally consistent and reported.
numpy is always present (an mlx-audio dependency); soundfile is not required.
"""

from __future__ import annotations

import wave
from pathlib import Path

# OmniVoice synthesizes at 24 kHz. Used by the silent fallback and the PCM writer.
OMNIVOICE_SAMPLE_RATE = 24000


def _ms_to_frames(duration_ms: int, sample_rate: int) -> int:
    return int(round(max(0, duration_ms) * sample_rate / 1000.0))


def write_silent_wav(path: str | Path, duration_ms: int, sample_rate: int = OMNIVOICE_SAMPLE_RATE) -> None:
    """Write a mono 16-bit PCM WAV of pure silence (the graceful-fallback clip)."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    n_frames = _ms_to_frames(duration_ms, sample_rate)
    silence = b"\x00\x00" * n_frames
    with wave.open(str(out), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(silence)


def write_pcm16_wav(path: str | Path, samples, sample_rate: int = OMNIVOICE_SAMPLE_RATE) -> None:
    """Write a float waveform (numpy array, floats in [-1, 1]) as mono 16-bit PCM."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        import numpy as np  # type: ignore

        arr = np.asarray(samples, dtype=np.float32).reshape(-1)
        np.clip(arr, -1.0, 1.0, out=arr)
        pcm16 = (arr * 32767.0).astype("<i2")
        with wave.open(str(out), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm16.tobytes())
        return
    except Exception:
        # Stdlib fallback (no numpy): best-effort float->int16.
        import struct

        frames = bytearray()
        for v in samples:
            f = float(v)
            f = 1.0 if f > 1.0 else (-1.0 if f < -1.0 else f)
            frames += struct.pack("<h", int(f * 32767.0))
        with wave.open(str(out), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(bytes(frames))


def read_wav_duration_ms(path: str | Path) -> int:
    """Return a WAV's duration in integer milliseconds (from its header)."""
    with wave.open(str(path), "rb") as wav:
        n_frames = wav.getnframes()
        framerate = wav.getframerate()
    if framerate <= 0:
        return 0
    return int(round(n_frames * 1000.0 / framerate))
