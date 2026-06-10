# Tech-stack deep research — best possible offline/on-device pipeline (June 2026)

> Goal: if the user's machine is powerful enough, offer the **best available local
> solution per phase**, even when it is very resource-intensive — while keeping the
> current stack as the universal CPU baseline.
>
> Method: six research domains (STT, translation, TTS, separation/audio-post,
> acceleration/packaging, competitive landscape), five of them produced by
> web-verified research agents on 2026-06-10/11; the separation/audio-post domain
> was completed from stable engineering references. License and version claims
> below were verified against primary sources at research time — re-verify before
> shipping anything.
>
> Baseline at research time: faster-whisper 1.2.1 (CTranslate2 4.8, CPU int8),
> Argos Translate 1.11, piper-tts 1.4.2, ffmpeg 8.1.1, cloud providers
> (OpenAI/Claude/Gemini) via fetch.

---

## Executive summary

1. **Our engine bets are validated** — faster-whisper is the de-facto standard in
   every successful OSS dubbing tool (pyVideoTrans, KrillinAI, Subtitle Edit/Purfview),
   and the per-phase provider architecture matches where the whole field went.
   The base stack stays; the upgrades are *additive tiers on top of it*.
2. **The two biggest competitive gaps are not models** but pipeline stages:
   **(a) forced alignment** (±50 ms word timestamps vs our ±500 ms — directly better
   dub sync) and **(b) vocal separation** (keep the original music/effects bed under
   the dub instead of ducking the whole track). Every leading tool ships both.
3. **macOS is leaving performance on the table**: CTranslate2 has **no Metal
   backend** (and won't get one — upstream issue #515), so Apple Silicon runs STT
   on CPU today. A `whisper.cpp` sidecar (MIT, Metal+CoreML, ~10× realtime for
   large-v3-turbo on M2 Pro) is the single highest-leverage engine addition and fits
   our ffmpeg-style sidecar pattern with **zero Python**.
4. **Translation has decisively moved from classic NMT to LLMs.**
   **TranslateGemma** (Google, Jan 2026; 4B/12B/27B; 55 languages incl. Vietnamese;
   in the official Ollama library) is the best license-clean local option — a
   generational jump over Argos for EN→VI. Our existing OpenAI-dialect translation
   provider already speaks Ollama's API (`http://127.0.0.1:11434/v1`), so a
   **local-LLM provider is nearly free to add**.
5. **Vietnamese TTS has a clear winner**: **VieNeu-TTS** (Apache-2.0, NeuTTS Air
   fine-tune, real-time on CPU via GGUF/ONNX, preset voices) — the biggest audible
   upgrade over Piper `vais1000` for the flagship pair. Nearly every other top
   Vietnamese option is license-blocked (details below).
6. **Packaging strategy converged industry-wide** on downloadable engine packs:
   C++ sidecar binaries (whisper.cpp/llama.cpp) where possible; uv-managed Python
   environments (the ComfyUI Desktop model) only where Python is unavoidable
   (MLX on macOS, torch-CUDA for Demucs/heavy TTS). PyInstaller one-file workers
   remain the always-present CPU baseline.
7. **Memory forces orchestration**: the "best" pipeline does not fit resident on
   32 GB — the orchestrator must load → run phase → unload (the dubbing pipeline is
   naturally sequential, so this costs little). Only 64 GB-class machines keep
   everything resident.

---

## Recommended stack per hardware tier

| Concern | Constrained (<8 GB) | Balanced (8–16 GB) | Performance (16–32 GB / Apple Silicon / GPU) | Workstation (32 GB+ / 16–24 GB VRAM) |
|---|---|---|---|---|
| **STT engine** | faster-whisper int8 (keep); Parakeet-TDT-v3 ONNX for EN/EU sources (~2 GB RAM, ~30× realtime CPU) | macOS: **whisper.cpp** (Metal); Win/Linux: faster-whisper (CUDA pack if NVIDIA, Vulkan whisper.cpp for AMD/Intel iGPU) | whisper.cpp Metal+CoreML / faster-whisper CUDA **batched** | NVIDIA: **WhisperX** batched large-v3 (~70× realtime); Mac: whisper.cpp large-v3; option: Qwen3-ASR-1.7B CUDA (incl. vi) |
| **STT model** | tiny/base; distil-large-v3.5 (EN-only); PhoWhisper-small (vi source) | **large-v3-turbo** (new default) | large-v3-turbo / large-v3 | large-v3; PhoWhisper-large (vi source) |
| **Word timing** | Whisper DTW + Silero VAD v6 chunking | same | **WhisperX forced alignment** (±50 ms; EN + major EU source langs) | WhisperX + **pyannote community-1 diarization** (multi-voice dubbing) |
| **Translation** | Argos (keep) + envit5 pack (EN↔VI); TranslateGemma-4B if Ollama present | **TranslateGemma-4B/12B** via Ollama/llama.cpp; MADLAD-400-3B CT2 as the no-LLM fallback | TranslateGemma-12B Q4 | **TranslateGemma-27B** Q4 + refine pass with Qwen3.5-35B-A3B / Gemma 4 (length-fit, terminology) |
| **TTS — Vietnamese** | Piper vais1000 (keep) | **VieNeu-TTS 0.3B** (CPU realtime, preset voices) | VieNeu-TTS 0.5B / v2 | VieNeu-TTS v3 Turbo (48 kHz) |
| **TTS — other languages** | Piper | **Kokoro-82M** ONNX (its 8 langs) + Piper | **Chatterbox Multilingual** (MIT, 23 langs, GPU/MPS) | **Qwen3-TTS-1.7B** (Apache-2.0, VoiceDesign synthetic voices) + Chatterbox |
| **Vocal separation** | off | optional MDX-Net (CPU, via audio-separator) | **BS/Mel-RoFormer** (GPU/MPS) or htdemucs; M&E mix mode | htdemucs_ft / Mel-RoFormer ensemble |
| **Time-stretch** | ffmpeg atempo (keep) | atempo + native TTS speed params first | **Rubber Band R3** CLI (formant-preserving) for ratios >1.3× | Rubber Band R3 + two-sided alignment (à la pyVideoTrans SpeedRate) |
| **Render encode** | libx264 CRF (keep) | + hardware **decode** for preview (free win) | + opt-in NVENC/VideoToolbox "fast export" | x264 slow for final; HW for previews |

---

## The "best possible" workstation pipeline (EN→VI)

### (a) Apple Silicon, 32–64 GB unified memory

1. **Separate** vocals from M&E: Demucs (demucs-mlx port — PyTorch-MPS is broken for
   Demucs; MLX runs ~34–73× realtime on M4 Max, bit-identical output). Unload.
2. **Transcribe**: whisper.cpp sidecar, large-v3 (Metal + CoreML/ANE encoder), fed the
   clean vocal stem; Silero VAD v6 chunking. WhisperX alignment pass (CPU is fine)
   for ±50 ms word timestamps. Unload.
3. **Translate**: TranslateGemma-27B Q4 (~16 GB) via llama.cpp Metal (llama-server,
   OpenAI-compatible → existing provider code), duration-aware prompts; optional
   refine pass with Qwen3.5-35B-A3B (MoE, ~3B active — fast). On 32 GB: unload before
   TTS; on 64 GB it can stay resident.
4. **Synthesize**: VieNeu-TTS v3 Turbo (48 kHz) for Vietnamese; Qwen3-TTS/Chatterbox
   for other targets (MPS).
5. **Fit & mix**: native TTS speed first, Rubber Band R3 (formant-preserved) for
   residual stretch; mix dub over the **original M&E bed** (no ducking artifacts);
   two-pass loudnorm, dialogue anchored ≈ −16 LUFS.
6. **Render**: libx264 CRF (final) / VideoToolbox (preview).

32 GB budget check: phases 1–4 each fit alone (3 + 17 + 5 GB peaks); the sequential
load→unload protocol is mandatory. 64 GB: everything resident, fastest iteration.

### (b) NVIDIA 12–24 GB VRAM (Windows/Linux)

Same shape: Demucs htdemucs_ft (CUDA) → WhisperX batched large-v3 (~70× realtime,
torch pack) → TranslateGemma-27B Q4 on 24 GB (12B on 12 GB) via llama.cpp CUDA →
Chatterbox/Qwen3-TTS CUDA → Rubber Band → x264. On 12 GB **everything must be
sequenced**; 12B-q4 MT + KV cache alone is ~8–9 GB.

---

## Domain highlights

### STT
- **No "Whisper v4" exists**; large-v3 (+turbo) is still the best open multilingual
  model. New default everywhere: **large-v3-turbo** (~1.5 GB int8, ≈large-v2 quality).
- **whisper.cpp** v1.8.x is the mandatory macOS fix (Metal/CoreML; MIT; sidecar like
  ffmpeg). **faster-whisper 1.2 batched** (+CUDA pack) is the NVIDIA path.
- **WhisperX** (BSD-2) forced alignment is the biggest dub-sync upgrade (±50 ms).
  ⚠ Its default *Vietnamese* alignment model is CC-BY-NC — EN-source alignment is
  permissive (torchaudio); for vi-source keep DTW timestamps.
- **Parakeet-TDT-0.6B-v3** (CC-BY-4.0): absurdly fast (int8 ONNX on plain CPUs,
  native word timestamps) but **European languages only** — the fast-EN engine, not
  a Whisper replacement. **PhoWhisper** (BSD-3) is SOTA for Vietnamese-source audio.
- **Qwen3-ASR 0.6B/1.7B** (Apache-2.0, Jan 2026, 52 langs **incl. vi**, beats
  large-v3) is the accuracy ceiling but CUDA-only today — workstation pack; watch
  for GGUF/MLX ports.
- Diarization for multi-voice dubbing: **pyannote community-1** (CC-BY-4.0, gated
  HF download — needs token flow or attributed mirror).

### Translation
- **TranslateGemma 4B/12B/27B** = best license-clean local MT (Gemma terms,
  commercial OK; distilled from Gemini, which won WMT25 14/16 pairs). In the official
  Ollama library. Specialized MT prompt = **one segment per request** (our provider
  needs a "raw per-segment" mode beside the JSON-batch mode).
- **Ollama provider ≈ free**: confirmed OpenAI-compatible `/v1/chat/completions`
  (JSON mode, streaming) — our LlmTranslationProvider dialect works as-is; only
  `requireCredential` needs a keyless-local exemption + daemon preflight.
- No-Ollama fallback: **MADLAD-400-3B** int8 runs on **CTranslate2 — already frozen
  in our STT worker** (~3 GB pack; 400+ languages; better than Argos, below LLMs).
- Worth trialing on our own EN→VI dub-line eval: **Seed-X-7B** (OpenMDW, claims
  GPT-4o-class at ~4.5 GB Q4), **Sailor2** (Apache-2.0, strongest per-param
  Vietnamese), **envit5** (~275M, EN↔VI only, constrained tier).
- Prompt-only free wins (cloud + local): **duration-aware translation** ("fit the
  time window" — the HeyGen trick) and VideoLingo-style translate-reflect-adapt.

### TTS
- **VieNeu-TTS** (Apache-2.0, 0.3B/0.5B/v3-48kHz, ONNX/GGUF, real-time CPU, preset
  Vietnamese voices, Perth-watermarked) is *the* answer to "what beats vais1000
  commercially-safely". Verify preset-voice consent/provenance with the maintainer;
  lock the UI away from its cloning API.
- **Kokoro-82M** (Apache-2.0 weights; Elo ~1056 — best quality-per-MB anywhere) for
  its 8 languages; **no Vietnamese** (frozen at v1.0).
- **Chatterbox Multilingual** (MIT incl. weights, 23 langs, watermarked) = best
  permissive multilingual engine; **no Vietnamese** (verified against the repo —
  third-party sites claiming vi are wrong).
- **Qwen3-TTS** (Apache-2.0, Jan 2026) = best workstation engine; **VoiceDesign**
  generates fully synthetic stock voices — a perfect fit for the no-cloning policy.
  No vi yet (community request open; the architecture demonstrably fine-tunes to vi).
- **Supertonic 3** (Apr 2026, 99M ONNX, 31 langs **incl. vi**, RTF 0.3 on a
  Raspberry Pi; MIT code + OpenRAIL-M weights) — plausible one-engine Piper
  successor for low tiers *if* Vietnamese tone quality passes an A/B.
- ⚠ License shifts to track: Piper is now **GPL-3** (piper1-gpl — fine as the
  subprocess it already is); Spark-TTS went NC; Fish/OpenAudio NC; Voxtral TTS NC;
  F5-TTS Vietnamese fine-tunes inherit **CC-BY-NC** (blocked); Gwen-TTS voices appear
  cloned from real Vietnamese artists (policy fail).

### Vocal separation, time-stretch, loudness *(domain completed from stable references)*
- **Separation**: `python-audio-separator` (MIT) wraps the UVR model zoo —
  **BS/Mel-RoFormer** checkpoints lead SDR (~12.6–12.9 vocals vs htdemucs ≈9);
  MDX-Net ONNX runs acceptably on CPU; RoFormer wants GPU/MPS; **Demucs** (MIT)
  via torch-CUDA or demucs-mlx. Pipeline change: new optional phase before STT
  (cleaner transcripts on noisy audio) + a third original-audio mode in the mixer —
  **"replace voices, keep music & effects"** (drop the vocal stem, mix the dub over
  the M&E bed). This is the single most audible mix upgrade and joins our existing
  keep-ducked/remove modes.
- **Time-stretch**: keep ffmpeg `atempo` as the universal fitter, but prefer
  *native TTS speed controls first* (Piper `length_scale`, Kokoro/Supertonic speed)
  so less post-stretch is needed. For ratios >~1.3×, **Rubber Band R3** with formant
  preservation sounds clearly more natural for speech; it is **GPL (commercial
  licenses available)** → subprocess CLI only, exactly like ffmpeg/piper. Phase-vocoder
  options (librosa) smear speech — avoid. The pyVideoTrans "SpeedRate" idea (split
  the error between slight video retime and audio speed-up, fill silence gaps) is the
  high-end refinement of our gap-aware alignment.
- **Loudness**: upgrade single-pass `loudnorm` to **two-pass** (measure → apply with
  measured values — transparent/linear instead of dynamic); anchor dialogue around
  −16 LUFS (streaming) with the M&E bed sitting 6–10 dB under dialogue during speech,
  in the spirit of EBU R128 / ATSC A-85 dialogue-anchored mixing.

### Acceleration & packaging
- The portable big-model story is **ggml-family C++ sidecars** (whisper.cpp,
  llama.cpp — MIT, prebuilt Metal/CUDA/Vulkan/HIP binaries, OpenAI-compatible
  servers), *not* ONNX Runtime EPs (CoreML EP partitions Whisper to CPU; DirectML in
  sustained engineering; ROCm EP removed). ORT stays for small static models
  (Kokoro, Silero VAD) inside existing workers.
- **Engine packs**: C++ sidecar binaries where possible; **uv + python-build-standalone**
  managed envs (ComfyUI Desktop model) for torch-CUDA (Demucs, Chatterbox, WhisperX)
  and MLX (macOS) — *not* PyInstaller for multi-GB stacks. Downloaded packs are
  spawned by the Node orchestrator directly (no Tauri externalBin needed at runtime);
  installer must verify checksums/signatures.
- **ffmpeg HW**: decode for previews = free win; encode (NVENC/VideoToolbox) opt-in
  only — x264 CRF stays the final-render default (VideoToolbox artifacts below ~q50).
- **Memory sequencing** is an orchestrator feature: load→phase→unload; co-residency
  only on 64 GB-class machines.

### Competitive landscape
- The recurring "safe-bet five" across successful tools: Whisper-family ASR ✓ (have),
  wav2vec2 forced alignment ✗ (gap), LLM translation incl. local ✓/partial,
  three-lane TTS menu ✓/partial, UVR/Demucs separation ✗ (gap).
- **Edge-TTS is everywhere and must be avoided** (reverse-engineered Microsoft
  endpoint, ToS-violating commercially, chronic vi-VN failures). Its popularity just
  proves demand for free quality voices — VieNeu/Kokoro/Chatterbox satisfy it legally.
- No surveyed OSS tool ships a fully-legal, fully-offline EN→VI stack.
  **faster-whisper/whisper.cpp → TranslateGemma → VieNeu-TTS is a leapfrog
  opportunity** — first in the field.

---

## Adoption roadmap (ordered; S/M/L effort)

| # | Upgrade | Effort | Touches | Notes / risk |
|---|---|---|---|---|
| 1 | faster-whisper 1.2 batched + Silero VAD v6; add **large-v3-turbo** (new default), distil-large-v3.5, **PhoWhisper** to the model catalog + recommendation engine | S | STT worker, catalog | Pure wins, zero new deps |
| 2 | **Duration-aware + reflect prompts** in the LLM translation provider | S | llmTranslationProvider | Free quality on cloud today, local tomorrow |
| 3 | **Ollama local provider** (keyless, baseUrl `127.0.0.1:11434/v1`, daemon preflight) + per-segment raw-MT mode → unlocks **TranslateGemma** | S–M | provider registry, preflight, wizard/Settings | The single biggest quality-per-effort move |
| 4 | **whisper.cpp sidecar pack** (mac Metal+CoreML first; Vulkan/CUDA later) wired to the hardware profile | M | engine packs, sidecar mgmt, STT provider | Fixes the Apple Silicon CPU-only gap |
| 5 | **Engine-pack infrastructure** (catalog/installer entries, checksums, uv bootstrap, spawn/lifecycle) | M | setup/installer, orchestrator | Prerequisite for 6–10 |
| 6 | **VieNeu-TTS Vietnamese pack** (A/B vs vais1000; provenance check; preset voices only) + **Kokoro-82M** for its 8 languages | M | TTS worker/packs, voice resolution | espeak-ng G2P stays out-of-process (GPL) |
| 7 | **Vocal separation phase** (audio-separator; MDX-Net CPU default, RoFormer GPU/MPS) + **"replace voices, keep music & effects"** mix mode + two-pass loudnorm | M–L | pipeline (new step), media-worker mix graph, wizard | Biggest audible mix upgrade |
| 8 | **llama.cpp llama-server pack** (managed alternative to user-installed Ollama; same OpenAI client code) | M | engine packs | We control lifecycle/load-unload |
| 9 | **WhisperX "Pro" pack** (torch via uv env): forced alignment + pyannote diarization → multi-voice dubbing | L | engine packs, STT pipeline, per-speaker voices | vi alignment model is NC — EN-source only at first |
| 10 | **Premium TTS packs**: Chatterbox Multilingual (23 langs), Qwen3-TTS (VoiceDesign stock voices) | L | engine packs, TTS providers | Lock away cloning inputs; keep watermarks |
| 11 | **Rubber Band R3 sidecar** for stretch >1.3× + (later) two-sided alignment | M | media-worker fit/mix | GPL-as-subprocess, like ffmpeg |
| 12 | HW **decode** for previews now; opt-in HW **encode** export toggle | S | media-worker, export UI | x264 stays the final default |
| 13 | Orchestrator **load/unload sequencing** + RAM/VRAM-aware engine scheduling | M | runner, hardware profile | Unlocks the workstation stack on 32 GB |

## What NOT to adopt

| Option | Reason |
|---|---|
| NLLB-200, Aya Expanse, Tower/TowerInstruct | CC-BY-NC (and Tower lacks Vietnamese) |
| F5-TTS (+ all Vietnamese fine-tunes), Fish/OpenAudio, Voxtral TTS, Spark-TTS, dangvansam VietTTS, XTTS | Non-commercial weights/licenses |
| Edge-TTS | Reverse-engineered MS endpoint; ToS-violating; unreliable vi-VN |
| Hunyuan-MT / HY-MT1.5 | License excludes EU/UK/KR by territory — not for a worldwide default (opt-in pack at most) |
| Gwen-TTS | Preset voices appear cloned from real Vietnamese artists — policy fail |
| CrisperWhisper; Moonshine (vi) | CC-BY-NC |
| Canary / Canary-Qwen | No word timestamps — unusable for dub sync despite leaderboard WER |
| IndexTTS-2 | Commercial use requires written authorization |
| DirectML / ROCm EPs as the acceleration story | Sustained-engineering / removed; use Vulkan builds for AMD/Intel |
| Bundling Ollama silently | Heavy runtime we don't control; prefer detect-and-use, or our own llama.cpp pack |
| MeloTTS | Superseded by Kokoro at the same tier |

## Open questions

1. VieNeu-TTS preset-voice speaker consent/provenance — confirm with the maintainer
   before bundling (and document the Perth watermark).
2. Supertonic 3 Vietnamese tonal quality — needs an A/B vs vais1000/VieNeu; OpenRAIL-M
   pass-through needs a legal once-over.
3. Qwen3-ASR GGUF/MLX ports — re-evaluate the moment one lands (would give best-in-class
   vi STT on Apple Silicon).
4. Piper `vais1000` voice/dataset provenance — re-check the MODEL_CARD before continued
   redistribution.
5. Build an internal **EN→VI dub-line eval set** (~200 lines) to A/B TranslateGemma vs
   Seed-X vs Sailor2 and VieNeu vs Piper before flipping defaults.
