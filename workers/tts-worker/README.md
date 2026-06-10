# VideoDubber TTS Worker

A small **FastAPI** service (default port **5103**) that turns translated text
segments into per-segment WAV files for the VideoDubber dubbing pipeline.

It is **local / offline-first** and degrades gracefully through a priority of
engines:

```
Piper (binary)  ->  system TTS (macOS `say` / linux `espeak-ng`)  ->  dev fallback
```

The **dev fallback** writes a silent (or soft sine) WAV sized to each segment's
time window and has **zero external dependencies**. This means the entire
dubbing pipeline is testable and runnable even with **no TTS software
installed** — you just get silent placeholder audio.

> ⚠️ **Consent / legal note:** This worker performs **generic text-to-speech
> only**. It does **NOT** perform voice cloning or speaker imitation. Adding
> voice cloning would require **explicit, informed consent** from the person
> whose voice is being cloned, and is intentionally out of scope here.

---

## Setup

Python 3.10+.

```bash
cd workers/tts-worker

# create + activate a virtualenv
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# runtime deps only (fallback path works with just these)
pip install -r requirements.txt

# or, for development + tests:
pip install -r requirements-dev.txt
```

## Run

```bash
uvicorn app.main:app --port 5103
# or, honoring TTS_WORKER_HOST / TTS_WORKER_PORT env vars:
python -m app.main
```

Health check:

```bash
curl http://127.0.0.1:5103/health
# { "status":"ok", "engines":{"piper":false,"system":true,"fallback":true} }
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The suite forces the **fallback** engine, so it passes on any machine with no
Piper / no system TTS installed.

---

## Engines

| Priority | Engine     | How it works                                                                 | Availability |
|---------:|------------|------------------------------------------------------------------------------|--------------|
| 1        | `piper`    | Invokes the **Piper binary** via subprocess (`piper --model … --output_file …`, text on stdin). | If `PIPER_BINARY_PATH` + `PIPER_VOICE_MODEL_PATH` are set and the files exist. |
| 2        | `system`   | macOS `say` → AIFF → WAV (`afconvert`/ffmpeg); Linux `espeak-ng -w out.wav`.  | If the OS command exists. |
| 3        | `fallback` | Silent/sine WAV sized to the segment window (stdlib `wave` only).            | **Always.** |

The highest-priority **available** engine is used automatically. You can force
an engine via the `voiceId` field:

* `"fallback"` — force the dev fallback.
* `"piper:/path/to/voice.onnx"` or `"piper:default"` — force Piper (errors with
  `PIPER_MISSING` if not configured).
* `"system:Alex"` — force system TTS with voice `Alex` (macOS).

### Installing Piper (optional, for real speech)

1. Download a Piper binary release for your OS from
   <https://github.com/rhasspy/piper/releases> and unpack it.
2. Download a voice model (`.onnx` + `.onnx.json`) from
   <https://huggingface.co/rhasspy/piper-voices> (e.g. a Vietnamese or English
   voice).
3. Point the worker at them:

   ```bash
   export PIPER_BINARY_PATH=/opt/piper/piper
   export PIPER_VOICE_MODEL_PATH=/opt/piper/voices/vi_VN-vais1000-medium.onnx
   ```

> The `piper-tts` **Python package is not required** — only the binary + model.
> (`pip install '.[piper]'` is available if you *prefer* the package, but the
> worker drives the binary via subprocess regardless.)

---

## HTTP API

### `GET /health`
```json
{ "status": "ok", "engines": { "piper": false, "system": true, "fallback": true } }
```

### `GET /voices?language=vi-VN`
```json
{ "voices": [ { "id": "system:default", "language": "vi", "displayName": "System TTS (OS built-in)", "engine": "system" },
              { "id": "fallback", "language": "vi", "displayName": "Dev fallback (silent/sine placeholder)", "engine": "fallback" } ] }
```

### `POST /synthesize-segments`
Request:
```json
{
  "language": "vi-VN",
  "voiceId": "fallback",
  "outputDir": "/path/to/project/audio/tts_segments",
  "speed": 1.0,
  "segments": [
    { "id": "seg_0001", "text": "Xin chào", "startMs": 0,    "endMs": 1000 },
    { "id": "seg_0002", "text": "Tạm biệt", "startMs": 1000, "endMs": 2200 }
  ]
}
```
Response:
```json
{
  "segments": [
    { "segmentId": "seg_0001", "audioPath": ".../segment_0001.wav", "durationMs": 1000, "startMs": 0, "endMs": 1000, "speedRatio": 1.0 },
    { "segmentId": "seg_0002", "audioPath": ".../segment_0002.wav", "durationMs": 1200, "startMs": 1000, "endMs": 2200, "speedRatio": 1.0 }
  ]
}
```

One WAV per segment, named `segment_<4-digit>.wav` from the numeric part of the
id. `durationMs` is the **real measured** WAV duration (read from the header).

### Errors

Errors use the shared envelope and an appropriate HTTP status:

```json
{ "error": { "code": "PIPER_MISSING", "message": "…", "remediation": "…", "docsRef": "docs/MODEL_SETUP.md#tts-piper" } }
```

| Code                | When |
|---------------------|------|
| `PIPER_MISSING`     | `voiceId` forced Piper (`piper:…`) but the binary/model is unavailable. |
| `TTS_VOICE_MISSING` | A specific requested voice/engine could not be resolved. |
| `OUTPUT_NOT_WRITABLE` | `outputDir` cannot be created/written. |
| `INVALID_LANGUAGE`  | Empty/invalid language code. |
| `UNKNOWN`           | Unhandled internal error. |

> Default (no/auto `voiceId`) behavior **never** errors on missing engines — it
> falls back gracefully and logs a warning.

---

## Configuration (environment variables)

| Variable                  | Default                          | Purpose |
|---------------------------|----------------------------------|---------|
| `TTS_WORKER_HOST`         | `127.0.0.1`                      | Bind host. |
| `TTS_WORKER_PORT`         | `5103`                           | Bind port. |
| `PIPER_BINARY_PATH`       | *(unset)*                        | Path to the Piper binary. |
| `PIPER_VOICE_MODEL_PATH`  | *(unset)*                        | Path to a `.onnx` voice model. |
| `FFMPEG_PATH`             | PATH lookup                      | Optional ffmpeg for AIFF→WAV on macOS. |
| `VIDEODUBBER_CACHE_DIR`   | `~/VideoDubber/cache`            | Base cache dir (audio cached under `…/tts`). |
| `TTS_DEFAULT_SAMPLE_RATE` | `22050`                          | Sample rate for fallback WAVs. |

### Speed

The requested `speed` is passed through to engines that support it (Piper
`length_scale`, `say`/`espeak` rate) and echoed in `speedRatio`. The precise
time-stretch to **fit the segment window** is applied downstream by the
alignment / ffmpeg stage of the orchestrator.

### Caching

Synthesized audio is content-addressed by
`sha256(segmentId + text + voiceId + speed)`. A cache hit is materialized into
the requested `outputDir` under the expected `segment_NNNN.wav` name (symlink
when possible, otherwise a copy), making project resume / single-segment
re-synth fast and deterministic.
