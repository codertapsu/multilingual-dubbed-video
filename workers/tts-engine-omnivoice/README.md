# vd_omnivoice — OmniVoice neural-TTS engine (optional `tts-omnivoice` pack)

A massively-multilingual neural TTS engine for VideoDubber, backed by
[OmniVoice](https://github.com/k2-fsa/OmniVoice) (k2-fsa) running on **Apple
Silicon via [MLX](https://github.com/ml-explore/mlx)** through
[`mlx-audio`](https://github.com/Blaizzy/mlx-audio). Optional and **Apple-Silicon
only** — Piper stays the fast default everywhere.

It exposes the SAME HTTP contract as the bundled tts-worker and the VieNeu engine
(`/health`, `/voices`, `/synthesize-segments`), so the orchestrator's
`NeuralTtsProvider` drives it unchanged (provider id `omnivoice`, engine pack
`tts-omnivoice`).

## How it runs

- The pack's uv venv supplies `mlx-audio` (+ `fastapi`/`uvicorn`); see
  `packages/node-orchestrator/src/engines/uvRequirements.ts` (`tts-omnivoice`).
- This package is loaded from bundled source via `PYTHONPATH` (not pip-installed)
  — `engineManager.ts` → `omnivoiceEnv()`.
- The model (`mlx-community/OmniVoice-bf16`, ~3 GB) downloads on first use into the
  pack's `hf/` dir (`HF_HOME`), then runs fully offline.
- Hardware gating is free: the `tts-omnivoice` pack is `platforms: ['darwin'],
  arch: ['arm64']`, so it's only ever offered/installable on Apple Silicon, and
  the provider is registered only there.

## Voices

OmniVoice is multilingual with no fixed preset speakers, so we expose a small set
of **designed voices** (`voices.py`) — each an OmniVoice "Voice Design" `instruct`
prompt plus a fixed seed so the speaker stays consistent across every segment of a
dub. The target language is mapped from the project's BCP-47 code to OmniVoice's
language name (`voices.language_name`).

## Not yet wired

- **Reference-audio voice cloning** (match the original speaker): the current MLX
  checkpoint ships without the HiggsAudio audio-tokenizer (`generate(ref_audio=…)`
  raises *"tokenizer (HiggsAudioTokenizer) is required for voice cloning"*). The
  engine is structured so cloning slots in once an MLX checkpoint includes it.
- **Duration control**: `generate(duration_s=…)` works and could tighten dub
  fitting; for now we synthesize at natural rate and let the orchestrator's
  ffmpeg stage time-stretch to the window (consistent with Piper/VieNeu).
- A **frontend voice picker** for the designed voices (uses the default voice for
  now).

## Standalone dev

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python mlx-audio fastapi uvicorn
PYTHONPATH=. .venv/bin/python -m vd_omnivoice --port 5105
# then: GET /health, GET /voices?language=en-US, POST /synthesize-segments
```

> Licensing: OmniVoice code + weights are Apache-2.0, but the bundled HiggsAudio
> tokenizer carries the non-OSI Boson Higgs Audio 2 Community License (100k-AAU
> commercial gate). Fine for this open-source, non-commercial app — review before
> any commercial redistribution.
