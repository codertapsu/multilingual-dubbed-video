"""Forced-language decoding must be able to disagree with the audio.

The pipeline always forces a source language, and faster-whisper's
``info.language`` echoes that forced value back — so the only "detected
language" the app had could never contradict the setting. A Chinese video
dubbed with the wizard's default (en-US) therefore produces confident, fluent,
entirely fabricated English, fluent entirely wrong Vietnamese, and a run that
reports success. These tests cover the worker half of the fix: an independent
probe of what the audio really sounds like, reported on the response.

No model, no weights, no network: a fake WhisperModel is injected.
"""

from __future__ import annotations

import pytest

import app.whisper_service as whisper_service
from app.schemas import TranscribeRequest


# --- the predicate ----------------------------------------------------------
def test_mismatch_requires_a_confident_disagreement() -> None:
    assert whisper_service.language_mismatch("en", "zh", 0.99) is True
    # Same language: never a mismatch, whatever the probability.
    assert whisper_service.language_mismatch("en", "en", 0.99) is False
    # Low confidence: whisper's language head is noisy on music/silence.
    assert whisper_service.language_mismatch("en", "zh", 0.2) is False
    # Nothing to compare against.
    assert whisper_service.language_mismatch(None, "zh", 0.99) is False
    assert whisper_service.language_mismatch("en", None, 0.99) is False
    assert whisper_service.language_mismatch("en", "zh", None) is False


def test_mismatch_is_case_insensitive() -> None:
    assert whisper_service.language_mismatch("EN", "en", 0.9) is False


# --- the probe, end to end through transcribe() -----------------------------
class _FakeSegment:
    def __init__(self, text: str) -> None:
        self.text = text
        self.start = 0.0
        self.end = 1.0
        self.avg_logprob = -0.2
        self.words = None


class _FakeInfo:
    duration = 1.0

    def __init__(self, language: str) -> None:
        # Mirrors faster-whisper: with a forced language this is that language.
        self.language = language


class _FakeModel:
    """Minimal WhisperModel stand-in that records how it was called."""

    def __init__(self, probe: tuple[str, float] | None = ("zh", 0.97)) -> None:
        self._probe = probe
        self.detect_calls = 0

    def transcribe(self, _audio, **kwargs):
        return iter([_FakeSegment("hello")]), _FakeInfo(kwargs.get("language") or "en")

    def detect_language(self, _audio, **_kwargs):
        self.detect_calls += 1
        if self._probe is None:
            raise RuntimeError("probe exploded")
        language, probability = self._probe
        return language, probability, [(language, probability)]


@pytest.fixture()
def wired(monkeypatch, tmp_path):
    """Wire transcribe() to a fake model and a fake decoder; returns the model."""
    audio_file = tmp_path / "audio.wav"
    audio_file.write_bytes(b"RIFFfake")

    model = _FakeModel()
    monkeypatch.setattr(whisper_service, "_load_model", lambda name, settings: model)
    monkeypatch.setattr(whisper_service, "_load_audio_samples", lambda path: [0.0] * 16000)
    return model, str(audio_file)


def test_forced_language_reports_what_the_audio_sounds_like(wired, caplog):
    model, audio_path = wired

    with caplog.at_level("WARNING"):
        result = whisper_service.transcribe(
            TranscribeRequest(audioPath=audio_path, language="en-US")
        )

    # detectedLanguage still echoes the forced value (unchanged contract)...
    assert result.detectedLanguage == "en"
    # ...but the probe now contradicts it, which is the whole point.
    assert result.probedLanguage == "zh"
    assert result.probedLanguageProbability == pytest.approx(0.97)
    assert model.detect_calls == 1
    assert "LANGUAGE MISMATCH" in caplog.text


def test_auto_detect_does_not_pay_for_a_second_probe(wired):
    model, audio_path = wired

    result = whisper_service.transcribe(TranscribeRequest(audioPath=audio_path))

    # With no forced language, info.language IS the honest answer already.
    assert model.detect_calls == 0
    assert result.probedLanguage is None
    assert result.probedLanguageProbability is None


def test_a_failing_probe_never_fails_the_transcription(monkeypatch, wired):
    model, audio_path = wired
    model._probe = None  # detect_language raises

    result = whisper_service.transcribe(
        TranscribeRequest(audioPath=audio_path, language="en-US")
    )

    assert [s.sourceText for s in result.segments] == ["hello"]
    assert result.probedLanguage is None
