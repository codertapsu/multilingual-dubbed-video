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
- **No watermark** (this used to claim otherwise — see below).

## The AI-audio watermark: NOT applied

This README used to state that "output carries an imperceptible Resemble Perth
watermark (AI-audio disclosure)". It does not, and never did.

`vieneu` 3.0.5 initializes its watermarker as `import perth;
perth.PerthImplicitWatermarker()` inside a `try/except (ImportError,
AttributeError)` that silently sets `self.watermarker = None`. Its metadata
declares `perth>=0.2.0` — but on PyPI `perth` is an unrelated project with a
single 2015 release ("Wrapper for `threading.local` with enhanced value
accessor", 1.7 KB sdist). Resemble AI's watermarker is a DIFFERENT distribution,
`resemble-perth`, which happens to install the same top-level `perth` module.
So the resolver installs the 2015 package, the attribute lookup raises, the
exception is swallowed, and nothing is ever watermarked. Upstream fixed this in
vieneu 3.8.1 by moving to `resemble-perth` under an optional `watermark` extra.

Making it real is not a one-line change: `resemble-perth` imports `torch`,
`pydub`, `pyrubberband` and `audioread`, and this pack's whole premise is that
it is torch-free on CPU. Adding torch would multiply the pack download for a
disclosure feature. So the claim is removed rather than the code changed, and
the pack ships unwatermarked until someone decides otherwise. The pinned
requirement set lives in the orchestrator (`uvRequirements.ts`), and the same
claim appears in `enginePackCatalog.ts` — both need the matching correction.

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
