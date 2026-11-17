"""The speech map (POST /speech-regions): where speech is, in ms, for the
orchestrator to anchor transcript lines to (pipeline/segmentTiming.ts there).

The VAD itself is faster-whisper's bundled Silero model; these tests pin the
contract around it: sample offsets become milliseconds, the options are the
fine-grained ones (boundaries, not transcription chunks), and the endpoint
shape is what the orchestrator parses.
"""

from __future__ import annotations

import faster_whisper.vad as fw_vad
from fastapi.testclient import TestClient

import app.vad_service as vad_service
from app.main import app

RATE = 16000


def test_speech_regions_reports_milliseconds_with_fine_boundaries(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(vad_service, "_load_audio_samples", lambda path: [0.0] * (RATE * 60))

    def fake_stamps(audio, options, sampling_rate):
        seen["options"] = options
        seen["rate"] = sampling_rate
        return [
            {"start": RATE * 2, "end": RATE * 3 + RATE // 2},
            {"start": RATE * 44, "end": RATE * 46},
        ]

    monkeypatch.setattr(fw_vad, "get_speech_timestamps", fake_stamps)

    res = TestClient(app).post("/speech-regions", json={"audioPath": "/tmp/original_16k_mono.wav"})

    assert res.status_code == 200
    body = res.json()
    assert body["durationMs"] == 60_000
    assert body["regions"] == [
        {"startMs": 2000, "endMs": 3500},
        {"startMs": 44000, "endMs": 46000},
    ]
    # Finer than the transcription VAD (2000 ms silence / 400 ms pad): the
    # point is where speech starts and stops, not chunks to transcribe.
    assert seen["options"].min_silence_duration_ms == 300
    assert seen["options"].speech_pad_ms == 100
    assert seen["options"].threshold == 0.5
    assert seen["rate"] == RATE


def test_speech_regions_honours_requested_options(monkeypatch):
    seen: dict = {}
    monkeypatch.setattr(vad_service, "_load_audio_samples", lambda path: [0.0] * RATE)

    def fake_stamps(audio, options, sampling_rate):
        seen["options"] = options
        return []

    monkeypatch.setattr(fw_vad, "get_speech_timestamps", fake_stamps)

    res = TestClient(app).post(
        "/speech-regions",
        json={"audioPath": "/tmp/a.wav", "minSilenceMs": 500, "padMs": 50, "threshold": 0.35},
    )

    assert res.status_code == 200
    assert res.json() == {"durationMs": 1000, "regions": []}
    assert seen["options"].min_silence_duration_ms == 500
    assert seen["options"].speech_pad_ms == 50
    assert seen["options"].threshold == 0.35
