/**
 * Locked, per-platform Python requirement sets for the uv-managed engine packs.
 *
 * `tts-neural` is VieNeu-TTS v3-Turbo via the `vieneu` SDK, which runs torch-free
 * on CPU through ONNX Runtime — so there is NO torch / llama-cpp-python / GGUF
 * and no per-platform wheel juggling (it installs the same on every OS/arch,
 * Intel Macs included). The resolver still supports a per-platform overlay + extra
 * index URLs for other packs.
 *
 * The `tts-neural` set was verified end to end on macOS arm64 on 2026-11-05 (a
 * fresh uv venv, the real model download, and a 48 kHz synthesis through our
 * own VieNeuEngine). Windows/Linux are exercised by the opt-in
 * `vieneu-smoke.yml` workflow — run it before a release that changes these
 * pins. See `workers/tts-engine-neural/README.md`.
 */

/** A resolved, install-ready requirement set for one pack on this machine. */
export interface ResolvedUvRequirements {
  /** Pinned requirement specifiers, written verbatim to requirements.txt. */
  requirements: string[];
  /** Extra pip index URLs (passed as `--extra-index-url`), de-duplicated. */
  extraIndexUrls: string[];
}

/** A pack's requirement spec: a common base plus per-platform overlays. */
interface UvRequirementSpec {
  /** Pinned requirements common to all platforms. */
  base: string[];
  /** Extra index URLs applied on all platforms. */
  extraIndexUrls?: string[];
  /** Platform-specific additions (merged onto `base`). */
  perPlatform?: Partial<Record<NodeJS.Platform, { requirements?: string[]; extraIndexUrls?: string[] }>>;
}

const UV_REQUIREMENTS: Record<string, UvRequirementSpec> = {
  // VieNeu-TTS v3-Turbo via the `vieneu` SDK: torch-free, ONNX on CPU, same on
  // every platform. `vieneu` pulls onnxruntime, soxr, tokenizers and sea-g2p
  // transitively, plus a PyPI package named `perth` that is NOT Resemble's
  // watermarker (that is `resemble-perth`, which needs torch) — so 3.0.5's
  // watermarker silently never initializes and output is unwatermarked; see
  // workers/tts-engine-neural/README.md. We pin soundfile/numpy for our WAV I/O
  // and fastapi/uvicorn for the server.
  'tts-neural': {
    base: [
      // 3.0.5 is deliberately NOT bumped to 3.8.x: 3.8 removed four of our ten
      // preset voices (including the default "Ngọc Lan"), swapped the default
      // checkpoint, and made librosa + kaldi-native-fbank hard deps. Migrate
      // as its own change, with voices.py, after an A/B on real dubs.
      'vieneu==3.0.5',
      'soundfile==0.14.0',
      'numpy==2.5.4',
      'fastapi==0.162.0',
      'uvicorn==0.54.0',
      // Pinned EXPLICITLY although both arrive through vieneu, because leaving
      // them floating is what broke this pack: huggingface_hub >= 1.33 began
      // symlinking blobs into a cache-wide store sharded by hash, and
      // onnxruntime refuses an .onnx whose external .data resolves into a
      // different directory — every fresh install from 2026-09-24 downloaded
      // the model and then failed to load it. The engine now opts out
      // (HF_HUB_DISABLE_SHARED_BLOBS) and repairs old caches (hfcache.py);
      // this exact pair was validated with a real download + synthesis on
      // 2026-11-05 (workers/tts-engine-neural/scripts/smoke_test.py).
      'onnxruntime==1.31.1',
      'huggingface_hub==2.4.0',
    ],
  },
  // VieNeu-TTS v2 (24 kHz): pin vieneu 2.7.0, the last release where v2 is the
  // native default and llama-cpp-python + the ONNX NeuCodec decoder are CORE deps
  // (so preset-voice synthesis is CPU + torch-free). The extra index serves CPU
  // wheels for llama-cpp-python==0.3.16 (avoids a from-source build, esp. Windows).
  'tts-neural-v2': {
    base: [
      'vieneu==2.7.0',
      // Pin the exact version the CPU extra-index below provides a prebuilt wheel
      // for, so uv installs that wheel instead of attempting a from-source build
      // (which needs a C++ toolchain — a guaranteed failure on a clean Windows box).
      'llama-cpp-python==0.3.16',
      'soundfile==0.13.1',
      'numpy==2.1.3',
      'fastapi==0.115.6',
      'uvicorn==0.34.0',
    ],
    extraIndexUrls: ['https://pnnbao97.github.io/llama-cpp-python-v0.3.16/cpu/'],
  },
  // OmniVoice (k2-fsa) via the official PyTorch package on Apple Silicon
  // Metal/MPS — the MLX ports (mlx-audio) bf16-quantize the HiggsAudio codec and
  // audibly degrade the voice, so we run the full PyTorch model (the HF Space
  // pipeline). Apple-Silicon-only (we ship the arm64 MPS torch wheels, ~0.45 GB,
  // no CUDA); the pack is gated to darwin/arm64 in enginePackCatalog. `omnivoice`
  // pulls transformers + accelerate + numpy transitively; we add fastapi/uvicorn
  // for the server (it writes WAV with numpy + stdlib, so no soundfile needed).
  'tts-omnivoice': {
    base: [
      // NOTE: torchaudio's version LAGS torch by a minor (torch 2.12.x pairs with
      // torchaudio 2.11.x — there is no torchaudio 2.12). Keep this pair in sync.
      'torch==2.12.1',
      'torchaudio==2.11.0',
      'omnivoice==0.1.5',
      'fastapi==0.115.6',
      'uvicorn==0.34.0',
    ],
  },
  // Other uv packs — kept at their existing (loose) sets.
  'separation-audio': {
    base: ['audio-separator>=0.18', 'onnxruntime>=1.20', 'fastapi>=0.110', 'uvicorn>=0.29'],
  },
  'alignment-whisperx': {
    base: ['whisperx>=3.8', 'fastapi>=0.110', 'uvicorn>=0.29'],
  },
  // LibreTranslate: a self-hosted HTTP server whose engine IS Argos Translate.
  // It reuses the argostranslate packages already installed on the machine
  // (shared default data dir), so it serves the same pairs as the built-in
  // Argos provider — no separate model index here.
  'translation-libretranslate': {
    base: ['libretranslate>=1.6.0'],
  },
};

/**
 * Resolve the install-ready requirement set for a pack on a given platform/arch.
 * Returns undefined for packs with no uv requirement spec.
 */
export function resolveUvRequirements(
  packId: string,
  platform: NodeJS.Platform = process.platform,
  _arch: string = process.arch,
): ResolvedUvRequirements | undefined {
  const spec = UV_REQUIREMENTS[packId];
  if (!spec) return undefined;
  const overlay = spec.perPlatform?.[platform];
  const extraIndexUrls = [...new Set([...(spec.extraIndexUrls ?? []), ...(overlay?.extraIndexUrls ?? [])])];
  return {
    requirements: [...spec.base, ...(overlay?.requirements ?? [])],
    extraIndexUrls,
  };
}
