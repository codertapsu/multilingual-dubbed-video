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

## "External data path escapes model directory" (fixed 2026-11)

Every fresh pack install from 2026-09-24 downloaded the model and then failed to
load it. `huggingface_hub` 1.33/2.0 started storing Xet files in a cache-wide
shared store (`<hub>/blobs/<2-hex>/<hash>`) and symlinking each repo's blobs into
it, so VieNeu's `.onnx` graphs and their external `.data` weights resolve into
different directories — and onnxruntime refuses external data outside the
model's own directory. Neither package was pinned; both arrived through
`vieneu`. The fix has three parts:

- the orchestrator launches the engine with `HF_HUB_DISABLE_SHARED_BLOBS=1`
  (and `engine.py` sets it before anything imports the SDK);
- `hfcache.unshare_repo_blobs()` converts an existing shared-store cache back to
  real per-repo files (hard links, no download) before the model loads;
- `onnxruntime` and `huggingface_hub` are now pinned in `uvRequirements.ts`.

Verified both ways on macOS: a broken cache healed offline, and a fresh install
on `huggingface_hub` 2.4.0 + onnxruntime 1.31.1.

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

- `GET /health` → `{ status, engines: { vieneu, fallback }, device, deviceName, deviceNote }`
- `POST /warmup` → starts loading the model in the background; answers like `/health`
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
- **Retries resume.** Every clip is also kept under a hash of what decides its
  audio (variant, voice, text, SDK version) in `<outputDir>/.vieneu-cache/`; a
  request for an unchanged line is answered by copying that clip into place
  (`reusedSegments` counts them). Clips are written to `*.partial.wav` and
  renamed, so a killed engine never leaves a truncated clip behind. See
  `clipcache.py`.
- The orchestrator sends at most 6 utterances per request
  (`NEURAL_TTS_UNITS_PER_REQUEST`), so no request comes near the worker timeout
  and the progress bar moves during a long dub.

## Speed on CPU (measured 2026-11-07)

The SDK never sets ONNX Runtime's thread count, and its default was the slowest
setting measured. The engine now uses **2 intra-op threads**
(`engine.py`, override with `VIENEU_ONNX_THREADS=<n>`). Real-time factor (seconds
of compute per second of speech, lower is faster) on an i5-13400F (6P + 4E):

| ONNX threads | default | 16 | 10 | 8 | 6 | 4 | 3 | **2** | 1 |
|---|---|---|---|---|---|---|---|---|---|
| RTF | 5.29 | 8.55 | 5.43 | 4.37 | 3.15 | 2.02 | 1.35 | **0.97** | 1.28 |

The decoder makes thousands of tiny ONNX calls per line, so extra threads only
add synchronisation, and the pool's idle threads spin between calls. On a real
21-minute dub (120 utterances, 9 min of speech) that is 12 utterances/min instead
of 2.4: about 10 minutes instead of 48. Several engines side by side top out at a
combined RTF of 0.63 (1.4 GB RAM each, a shared memory-bandwidth limit), so there
is no process pool. Going substantially faster needs the GPU, which on this SDK
means its PyTorch backend: the separate `tts-neural-cuda` pack below.

## On an NVIDIA GPU (`tts-neural-cuda`, measured 2026-11-07)

The same server, started with `VIENEU_DEVICE=cuda` (the engine manager sets it
from the pack's `accel`). `_load_v3_cuda` checks that this PyTorch build has
kernels for the card (`cuda_build_supports`: same-major binary compatibility, or
PTX), loads the PyTorch backbone + codec from **pinned revisions**
(`pinned.py`), and wraps the SDK's batched serving engine
(`vieneu.v3_turbo_serve.V3TurboBatchEngine`). Any failure there leaves
`deviceNote` in `/health` and falls back to the CPU path in the same process, so
the dub still finishes.

**Batching is the whole speed-up.** One line at a time, the GPU is *slower* than
the tuned CPU. RTF on an RTX 3050 8 GB (i5-13400F host):

| Path | RTF |
|---|---|
| CPU, ONNX, 2 threads | 0.66–0.97 |
| GPU, one line at a time (cu126) | 1.36 |
| GPU, batch 8 / 16 / 24 (cu126) | 0.48 / 0.40 / 0.34 |
| GPU, batch 24 (cu130) | **0.18–0.20** |

So the orchestrator sends up to 24 lines per request when `/health` reports
`device: "cuda"` (`NEURAL_TTS_GPU_UNITS_PER_REQUEST`), and `synth_many`
generates them in one `generate_batch` call, sorted by phoneme length so a batch
does not pad short lines to the longest. A 24-line batch peaked at 571 MB of
tensors. On the real 21-minute project the app-installed pack voiced 192
utterances (593 s of speech) in 143.9 s, RTF 0.243, against about 9½ minutes on
the CPU.

Sampling matches the SDK's own defaults (`_V3_SAMPLING`). The CUDA-graph mode
was rejected: it requires `repetition_penalty=1.0`, which produced runaway audio.
Quality was compared on the same 24 lines (CPU vs GPU): total speech 66.7 vs
67.8 s, 15.4 vs 15.2 characters/s, longest pause 0.74 vs 0.72 s.

**`POST /warmup`.** Loading the GPU model takes about 8 s once it is cached, and
about 40 s the first time, including the pinned download. So the lifespan does
not warm it on every engine start. The provider calls `/warmup`, then polls `/health` until it is ready,
before the first request. The CPU path still warms at start as before. The clip
cache key leaves the device out on purpose: a clip voiced on the CPU is reused on
the GPU and the other way round, because the voices are the same.

## Validation status

Unit-tested without the SDK (`tests/`): the HTTP contract, voice catalog, WAV I/O,
silent fallback, clip reuse and atomic writes, the thread limit, the model pins,
the CUDA kernel check, and the GPU batching route with a fake batcher. The neural
path itself has run real dubs on Windows 11 (i5-13400F, the numbers above) with
`vieneu==3.0.5`, on the CPU and on an RTX 3050 with both PyTorch builds. Still
unverified: other OS/arch combinations' speed, Blackwell (RTX 50) cards on real
hardware, and the MOSS-Audio-Tokenizer-Nano codec and sea-g2p licenses alongside
VieNeu's Apache-2.0.
