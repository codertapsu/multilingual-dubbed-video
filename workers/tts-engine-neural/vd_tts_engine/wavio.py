"""WAV helpers for the neural TTS engine (stdlib-only, no heavy deps).

Mirrors the contract of the bundled tts-worker: 16-bit signed PCM, mono. The
neural engine synthesizes at 24 kHz (NeuCodec's native rate); the orchestrator's
alignment/ffmpeg stage time-stretches each clip to its window downstream, so the
sample rate here only needs to be internally consistent and faithfully reported.
"""

from __future__ import annotations

import wave
from pathlib import Path

# VieNeu v3-Turbo synthesizes at 48 kHz. Used by the silent fallback and the
# PCM writer so placeholder/array output matches the engine's native rate.
NEURAL_SAMPLE_RATE = 48000


def _ms_to_frames(duration_ms: int, sample_rate: int) -> int:
    return int(round(max(0, duration_ms) * sample_rate / 1000.0))


def write_silent_wav(path: str | Path, duration_ms: int, sample_rate: int = NEURAL_SAMPLE_RATE) -> None:
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


def write_pcm16_wav(path: str | Path, samples, sample_rate: int = NEURAL_SAMPLE_RATE) -> None:
    """Write a float/int waveform (numpy array or sequence) as mono 16-bit PCM.

    Accepts floats in [-1, 1] (the usual neural-vocoder output) or int16-range
    values. Uses soundfile when available (handles dtype/clipping cleanly) and
    falls back to a stdlib `wave` writer otherwise.
    """
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore

        arr = np.asarray(samples, dtype=np.float32).reshape(-1)
        np.clip(arr, -1.0, 1.0, out=arr)
        sf.write(str(out), arr, sample_rate, subtype="PCM_16")
        return
    except Exception:
        # Stdlib fallback: best-effort float->int16 without numpy/soundfile.
        import struct

        frames = bytearray()
        for v in samples:
            f = float(v)
            if f > 1.0:
                f = 1.0
            elif f < -1.0:
                f = -1.0
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
