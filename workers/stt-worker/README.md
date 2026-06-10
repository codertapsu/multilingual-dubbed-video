# VideoDubber STT Worker

Local, offline-first **speech-to-text** service for the VideoDubber pipeline.
Built with **FastAPI** + **faster-whisper** (CTranslate2). Runs on **port 5101**.

It turns an audio file into timed transcript segments (with optional per-word
timestamps) that the orchestrator passes downstream to translation → TTS →
alignment → render.

---

## Requirements

- **Python 3.11 or 3.12 is recommended.**
  `faster-whisper` depends on `ctranslate2`, whose prebuilt wheels can lag on
  brand-new Python releases (e.g. 3.14). If `pip install` fails to find a
  `ctranslate2` wheel, switch to Python 3.11/3.12.
- ~1–2 GB free disk for the default `small` model (more for `medium`/`large-*`).
- No GPU required — the worker defaults to CPU with `int8` compute.

## Setup

```bash
# From workers/stt-worker
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# Runtime deps
pip install -r requirements.txt
# (or, editable install incl. the console script)
# pip install -e .

# Dev/test deps (optional)
pip install -r requirements-dev.txt
```

## Run

```bash
uvicorn app.main:app --port 5101
# or, honoring STT_* env vars (host/port/log level):
python -m app.main
```

Health check:

```bash
curl http://127.0.0.1:5101/health
# { "status":"ok", "model":"small", "device":"cpu", "compute_type":"int8", "loaded":false }
```

## Model download / caching

The Whisper model is **lazy-loaded on the first `/transcribe` call** and then
cached in-process. To pre-cache it (so the worker can run fully offline
afterwards):

```bash
python -m app.download_model --model small
python -m app.download_model --list     # show common sizes
```

By default models are cached in the standard HuggingFace cache
(`~/.cache/huggingface`). Override with `STT_MODEL_CACHE_DIR`. To force fully
offline operation (fail fast if a model isn't already cached), set
`STT_LOCAL_FILES_ONLY=1`.

Set `STT_WARMUP=1` to eagerly load the model at startup (warm-up failures are
non-fatal; `/health` stays up and the error surfaces on the first transcribe).

## Configuration (environment variables)

| Variable                | Default     | Notes                                              |
| ----------------------- | ----------- | -------------------------------------------------- |
| `STT_HOST`              | `127.0.0.1` | Bind host for `python -m app.main`.                |
| `STT_PORT`              | `5101`      | Bind port.                                         |
| `FASTER_WHISPER_MODEL`  | `small`     | Model size (`tiny`…`large-v3`).                    |
| `STT_DEVICE`            | `auto`      | `auto`→`cpu`, or `cpu` / `cuda`.                   |
| `STT_COMPUTE_TYPE`      | `int8`(cpu) | Override CTranslate2 compute type.                 |
| `STT_CPU_THREADS`       | `0`         | `0` = auto (CTranslate2 picks).                    |
| `STT_NUM_WORKERS`       | `1`         | Parallel transcription workers.                    |
| `STT_MODEL_CACHE_DIR`   | _(unset)_   | Model weights cache dir.                           |
| `STT_LOCAL_FILES_ONLY`  | `false`     | If true, never download; fail with model-missing.  |
| `STT_WARMUP`            | `false`     | Preload model at startup.                           |
| `STT_LOG_LEVEL`         | `INFO`      | Logging level.                                     |

## HTTP API

### `GET /health`

```json
{ "status": "ok", "model": "small", "device": "cpu", "compute_type": "int8", "loaded": false }
```

### `POST /transcribe`

Request (mirrors shared `SttInput`):

```json
{
  "audioPath": "/abs/path/audio/original_16k_mono.wav",
  "language": "vi-VN",
  "model": "small",
  "wordTimestamps": true
}
```

- `language` is optional; omit/`null` to auto-detect. It is normalized to the
  base subtag for Whisper (`vi-VN` → `vi`, `en-US` → `en`). The special locale
  `vi-VI` is normalized to `vi-VN` to stay consistent with the rest of the app.

Response (mirrors shared `SttResult`):

```json
{
  "segments": [
    {
      "id": "seg_0001",
      "index": 0,
      "startMs": 0,
      "endMs": 1500,
      "sourceText": "Xin chào",
      "confidence": 0.92,
      "words": [{ "word": "Xin", "startMs": 0, "endMs": 500, "confidence": 0.9 }]
    }
  ],
  "detectedLanguage": "vi",
  "durationMs": 3000
}
```

- Segment ids are 1-based, zero-padded width 4 (`seg_0001`).
- All timestamps are **integer milliseconds**.
- Segment `confidence` is `exp(avg_logprob)` clamped to `[0, 1]`; word
  `confidence` is the model's word probability.

### Errors

All errors use the shared structured envelope with an appropriate HTTP status:

```json
{
  "error": {
    "code": "STT_MODEL_MISSING",
    "message": "Whisper model 'small' could not be loaded.",
    "remediation": "Run `python -m app.download_model --model small` ...",
    "docsRef": "docs/TROUBLESHOOTING.md#stt-worker"
  }
}
```

Common codes: `STT_MODEL_MISSING` (model not installed/loadable),
`UNSUPPORTED_MEDIA` / `NO_AUDIO_STREAM` (bad or empty audio path),
`INVALID_LANGUAGE` (bad request body), `UNKNOWN` (unexpected).

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

Tests **monkeypatch** the whisper service, so they run with **no model and no
network**. They cover `/health`, `/transcribe` schema + response shape, the
structured error envelope, and language normalization (`vi-VI`→`vi-VN`,
`en-US`→`en`).
