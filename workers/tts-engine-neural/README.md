# vd_tts_engine — VieNeu neural TTS engine

First-party FastAPI server for VideoDubber's optional **`tts-neural`** engine
pack. It gives Vietnamese dubbing a far more natural voice than Piper using
[VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) — a Vietnamese fine-tune of
Neuphonic's [NeuTTS Air](https://github.com/neuphonic/neutts-air) (a ~0.5B speech
LLM backbone + NeuCodec decoder, Apache‑2.0 code **and** weights).

## How it fits the app

The engine-pack machinery already exists in the orchestrator:

- **Catalog**: `enginePackCatalog.ts` → pack `tts-neural` (`packKind: 'python-uv'`).
- **Install**: `engineInstaller.ts` materializes a uv venv from
  `UV_ENV_REQUIREMENTS['tts-neural']` (llama-cpp-python, neucodec, phonemizer,
  soundfile, numpy, huggingface-hub, neuttsair, fastapi, uvicorn).
- **Launch**: `engineManager.ts` runs `<pack>/venv/bin/python -m vd_tts_engine
  --port <PORT>`. The venv provides the **deps**; **this package** is loaded from
  bundled source via `PYTHONPATH` (`VIDEODUBBER_ENGINE_SRC_DIR`, default
  `<repo>/workers/tts-engine-neural`). `HF_HOME` points model downloads into the
  pack dir so they're removed on uninstall.
- **Provider**: `NeuralTtsProvider` (id `neural-tts`, `requiresEnginePack:
  'neural-tts'`) calls this server's `/synthesize-segments` and `/voices`.
- **Gating**: a project that selects the `neural-tts` provider is blocked at run
  start until the pack is installed (readiness → `install-pack`).

## HTTP contract (mirrors the bundled tts-worker)

- `GET /health` → `{ status, engines: { vieneu, fallback } }`
- `GET /voices?language=vi-VN` → `{ voices: [{ id, language, displayName, engine }] }`
- `POST /synthesize-segments` → `{ segments: [...], engine, fallbackSegments }`

Voice ids are `vieneu-<slug>` (see `voices.py`), mirrored read-only in the
orchestrator's `neuralVoicesCatalog.ts` so the wizard can list them before
install.

## Robustness

- Heavy deps are imported lazily, so `/health` + `/voices` work even before the
  venv exists; `synth()` then raises and the server writes **silent** placeholder
  WAVs (`fallbackSegments` counts them) — a run never hard-fails on TTS.
- Reference codes for a preset voice are encoded once and cached across all
  segments of a video (the model load + reference encode is the main fixed cost).
- Synthesis is at natural rate (`speedRatio: 1.0`); the orchestrator's
  alignment/ffmpeg stage time-stretches each clip to its window.

## Prerequisites

- **uv** — bundled with the packaged app (materializes the venv). Surfaced at
  `GET /engines/prerequisites`.
- **espeak-ng** — required by NeuTTS phonemization. Checked in three places:
  this server's `GET /health` (`prerequisites.espeak_ng`), the orchestrator's
  `GET /engines/prerequisites` (`espeakNg.available`, shown as a warning on the
  pack in Settings → Engines), and at load time — the NeuTTS path **refuses**
  (→ silent fallback with a clear message) when espeak-ng is absent. Install it:
  macOS `brew install espeak-ng`, Debian/Ubuntu `apt install espeak-ng`,
  Windows install eSpeak NG.

The dependency set is **pinned per platform** in the orchestrator's
`uvRequirements.ts` — Linux/Windows pull the CPU `torch` from the PyTorch CPU
wheel index; macOS uses the default wheel.

## ⚠️ Validation status

The HTTP contract, voice catalog, batching, WAV I/O, silent-fallback and the
espeak-ng refusal are unit-tested (`tests/`, no heavy deps). The **neural
inference path** (loading the GGUF backbone + NeuCodec and resolving a preset's
reference clip from the model's `voices.json`) requires the pack venv + model
download (~0.5 GB) and `espeak-ng`, and has **not** been executed in CI. Before
shipping, validate an install on each target OS/arch, confirm every pinned
version resolves (and wheels are accelerated where expected), and replace the
`neuttsair @ git+…@main` ref with a pinned commit/tag.
