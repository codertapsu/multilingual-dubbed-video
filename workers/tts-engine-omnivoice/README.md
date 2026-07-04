# vd_omnivoice — OmniVoice neural-TTS engine (optional `tts-omnivoice` pack)

> **Status: ON HOLD — excluded from releases.** The engine was reworked onto the
> official PyTorch/MPS pipeline and its two root-cause bugs are fixed, but output
> quality is not yet stable enough to ship. The pack is gated out of the catalog
> and its source is not bundled; the code stays here so work can resume. See
> [docs/OMNIVOICE.md](../../docs/OMNIVOICE.md) for status + re-enable checklist.

A massively-multilingual neural TTS engine for VideoDubber, backed by
[OmniVoice](https://github.com/k2-fsa/OmniVoice) (k2-fsa) running the **official
`omnivoice` PyTorch package on Apple Silicon's Metal (MPS) backend** — the same
pipeline as the k2-fsa HF Space. (The earlier MLX port via `mlx-audio` audibly
degraded the HiggsAudio codec and was abandoned.) Optional and **Apple-Silicon
only** — Piper stays the fast default everywhere.

It exposes the SAME HTTP contract as the bundled tts-worker and the VieNeu engine
(`/health`, `/voices`, `/synthesize-segments`), so the orchestrator's
`NeuralTtsProvider` drives it unchanged (provider id `omnivoice`, engine pack
`tts-omnivoice`).

## How it runs

- The pack's uv venv supplies `torch==2.12.1` + `torchaudio==2.11.0` + the
  official `omnivoice` package (torchaudio lags torch by a minor version — there
  is no torchaudio 2.12.x); see
  `packages/node-orchestrator/src/engines/uvRequirements.ts` (`tts-omnivoice`).
- This package is loaded from bundled source via `PYTHONPATH` (not pip-installed)
  — `engineManager.ts` → `omnivoiceEnv()`. (While the pack is on hold it is NOT
  staged into the app bundle; dev mode loads it from the repo path.)
- The model (`k2-fsa/OmniVoice`) loads with `device_map="mps"`, fp16 on Apple
  Silicon (fp32 CPU fallback) and downloads on first use into the pack's `hf/`
  dir (`HF_HOME`), then runs fully offline.
- Hardware gating is free: the `tts-omnivoice` pack is `platforms: ['darwin'],
  arch: ['arm64']`, so it's only ever offered/installable on Apple Silicon, and
  the provider is registered only there.

## Voices

OmniVoice is multilingual with no fixed preset speakers, so we expose a small set
of **designed voices** (`voices.py`) — each an OmniVoice "Voice Design" `instruct`
prompt plus a fixed per-voice torch seed so the speaker stays consistent across
every segment of a dub, with an audibility re-roll guard. IMPORTANT: the instruct
vocabulary is CLOSED (trained tags for gender / age / pitch / whisper / accent
only) — the model rejects unknown attributes (e.g. "bright"), so `voices.py` uses
only valid tags. The target language is mapped from the project's BCP-47 code to
OmniVoice's capitalized language name (`voices.language_name`), or auto-detected
when unmapped.

## Not yet wired

- **Reference-audio voice cloning** (match the original speaker): not enabled;
  only designed voices are offered.
- **Duration control**: `generate(duration=…)` works and could tighten dub
  fitting; for now we synthesize at natural rate and let the orchestrator's
  ffmpeg stage time-stretch to the window (consistent with Piper/VieNeu).
- A **frontend voice picker** for the designed voices (uses the default voice for
  now).

## Standalone dev

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e '.[omnivoice]' fastapi uvicorn
PYTHONPATH=. .venv/bin/python -m vd_omnivoice --port 5105
# then: GET /health, GET /voices?language=en-US, POST /synthesize-segments
```

> Licensing: OmniVoice code + weights are Apache-2.0, but the bundled HiggsAudio
> tokenizer carries the non-OSI Boson Higgs Audio 2 Community License (100k-AAU
> commercial gate). Fine for this open-source, non-commercial app — review before
> any commercial redistribution. Details in NOTICE.md.
