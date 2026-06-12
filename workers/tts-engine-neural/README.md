# vd_tts_engine — VieNeu neural TTS engine

First-party FastAPI server for VideoDubber's optional **`tts-neural`** engine
pack. It gives Vietnamese dubbing a far more natural voice than Piper using
[VieNeu-TTS **v3-Turbo**](https://github.com/pnnbao97/VieNeu-TTS) — an original
48 kHz speech model (Apache-2.0 code **and** weights) consumed through the
[`vieneu`](https://pypi.org/project/vieneu/) PyPI package.

## Why v3-Turbo / the `vieneu` package

- **Torch-free on CPU**: v3-Turbo runs entirely via ONNX Runtime — no PyTorch,
  no llama-cpp-python, no GGUF. Installable as `pip install vieneu`.
- **No espeak-ng**: Vietnamese/English G2P is the bundled sea-g2p (Rust). There
  is no system-binary prerequisite.
- **48 kHz**, 10 named preset voices (no reference clip needed), En–Vi
  code-switching, Apache-2.0, ungated.
- **Watermark**: output carries an imperceptible Resemble Perth watermark
  (AI-audio disclosure) — pulled in with the SDK and kept on purpose.

## How it fits the app

- **Catalog**: `enginePackCatalog.ts` → pack `tts-neural` (`packKind: 'python-uv'`).
- **Install**: `engineInstaller.ts` materializes a uv venv from
  `uvRequirements.ts` (`vieneu`, soundfile, numpy, fastapi, uvicorn — all CPU,
  no torch, so no per-platform index juggling and it runs on Intel Macs too).
- **Launch**: `engineManager.ts` runs `<pack>/venv/bin/python -m vd_tts_engine
  --port <PORT>`. The venv provides the deps; **this package** is loaded from
  bundled source via `PYTHONPATH` (`VIDEODUBBER_ENGINE_SRC_DIR`). `HF_HOME`
  points the SDK's model download (the v3 ONNX bundle + MOSS codec, ~0.5–1 GB)
  into the pack dir so it's removed on uninstall.
- **Provider**: `NeuralTtsProvider` (id `neural-tts`) calls `/synthesize-segments`
  and `/voices`; a project that selects it is gated at run start until the pack
  is installed.

## HTTP contract (mirrors the bundled tts-worker)

- `GET /health` → `{ status, engines: { vieneu, fallback } }`
- `GET /voices?language=vi-VN` → `{ voices: [{ id, language, displayName, engine }] }`
- `POST /synthesize-segments` → `{ segments: [...], engine, fallbackSegments }`

Voice ids are `vieneu-<slug>` (see `voices.py`), mirrored read-only in the
orchestrator's `neuralVoicesCatalog.ts`. Each maps to a preset `sdk_name` passed
to `vieneu`'s `infer(voice=…)`.

## Robustness

- The `vieneu` SDK is imported lazily, so `/health` + `/voices` work even before
  the venv exists; `synth()` then raises and the server writes **silent**
  placeholder WAVs (`fallbackSegments` counts them) — a run never hard-fails.
- If a preset name is rejected (the upstream preset set drifts), synth retries
  with the SDK's default voice so one stale name can't silence the whole dub.
- Synthesis is at the model's natural rate (`speedRatio: 1.0`); the
  orchestrator's alignment/ffmpeg stage time-stretches each clip to its window.

## ⚠️ Validation status

The HTTP contract, voice catalog, batching, WAV I/O and silent-fallback are
unit-tested (`tests/`, no heavy deps). The **neural inference path** (the
`vieneu` SDK loading the v3-Turbo ONNX model + MOSS codec on first use) requires
the pack venv + a model download (~0.5–1 GB) and has **not** been executed in CI.
Before relying on it: confirm `vieneu==3.0.5` installs and its bare `Vieneu()`
default is v3-Turbo on each OS/arch, **benchmark CPU latency** for long videos
(v3-Turbo is early-access and publishes no real-time-factor), verify the SDK
preset names match `voices.py`, and confirm the MOSS-Audio-Tokenizer-Nano codec
and sea-g2p licenses alongside VieNeu's Apache-2.0.
