"""A request can turn the VAD filter off (the loop check's second opinion).

Where the speech map (Silero VAD) heard no speech, the orchestrator decodes the
range again to decide what stays. With the worker's VAD filter on, that second
decode drops the same stretches the speech map missed, so it could only agree.
No model, no weights, no network: a fake WhisperModel records its arguments.
"""

from __future__ import annotations

import pytest

import app.whisper_service as whisper_service
from app.config import get_settings
from app.schemas import TranscribeRequest


class _FakeSegment:
    text = "hello"
    start = 0.0
    end = 1.0
    avg_logprob = -0.2
    words = None


class _FakeInfo:
    duration = 60.0
    language = "zh"


class _FakeModel:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, _audio, **kwargs):
        self.calls.append(kwargs)
        return iter([_FakeSegment()]), _FakeInfo()

    def detect_language(self, _audio, **_kwargs):
        return "zh", 0.99, [("zh", 0.99)]


@pytest.fixture()
def wired(monkeypatch, tmp_path):
    audio_file = tmp_path / "audio.wav"
    audio_file.write_bytes(b"RIFFfake")
    model = _FakeModel()
    monkeypatch.setattr(whisper_service, "_load_model", lambda name, settings: model)
    monkeypatch.setattr(whisper_service, "_load_audio_samples", lambda path: [0.0] * 16000)
    return model, str(audio_file)


def test_the_worker_setting_applies_by_default(wired):
    model, audio_path = wired
    whisper_service.transcribe(TranscribeRequest(audioPath=audio_path, language="zh"))
    assert model.calls[-1]["vad_filter"] is get_settings().vad_filter


def test_a_request_can_listen_to_every_second(wired):
    model, audio_path = wired
    whisper_service.transcribe(TranscribeRequest(audioPath=audio_path, language="zh", noContext=True, vadFilter=False))
    assert model.calls[-1]["vad_filter"] is False
    assert model.calls[-1]["condition_on_previous_text"] is False
    # Sequential, never the batched pipeline: it raises without VAD over 30 s.
    assert "batch_size" not in model.calls[-1]
