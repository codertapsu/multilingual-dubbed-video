"""WAV utility tests: silent/sine writers and duration measurement."""

from __future__ import annotations

import wave

import pytest

from app.wavutil import read_wav_duration_ms, write_silent_wav, write_sine_wav


def _read_header(path):
    with wave.open(str(path), "rb") as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()


def test_write_silent_wav_duration_and_header(tmp_path):
    out = tmp_path / "silent.wav"
    write_silent_wav(out, 1000, sample_rate=22050)

    nch, width, rate, nframes = _read_header(out)
    assert nch == 1
    assert width == 2  # 16-bit
    assert rate == 22050
    assert nframes == 22050  # 1000ms @ 22050Hz

    assert abs(read_wav_duration_ms(out) - 1000) <= 1


def test_write_silent_wav_is_actually_silent(tmp_path):
    out = tmp_path / "silent.wav"
    write_silent_wav(out, 200, sample_rate=8000)
    with wave.open(str(out), "rb") as w:
        frames = w.readframes(w.getnframes())
    assert set(frames) == {0}  # all zero bytes


def test_write_sine_wav_duration(tmp_path):
    out = tmp_path / "sine.wav"
    write_sine_wav(out, 500, sample_rate=16000, frequency_hz=200.0, amplitude=0.05)
    assert abs(read_wav_duration_ms(out) - 500) <= 1
    # sine must contain non-zero samples
    with wave.open(str(out), "rb") as w:
        frames = w.readframes(w.getnframes())
    assert any(b != 0 for b in frames)


@pytest.mark.parametrize(
    ("duration_ms", "rate"),
    [(0, 22050), (1, 8000), (1234, 44100), (60000, 22050)],
)
def test_duration_roundtrip(tmp_path, duration_ms, rate):
    out = tmp_path / "x.wav"
    write_silent_wav(out, duration_ms, sample_rate=rate)
    measured = read_wav_duration_ms(out)
    # within one frame of tolerance
    assert abs(measured - duration_ms) <= 1


def test_zero_duration_yields_empty_audio(tmp_path):
    out = tmp_path / "zero.wav"
    write_silent_wav(out, 0)
    _, _, _, nframes = _read_header(out)
    assert nframes == 0
    assert read_wav_duration_ms(out) == 0
