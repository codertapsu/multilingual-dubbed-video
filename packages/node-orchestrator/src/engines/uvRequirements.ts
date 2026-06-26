/**
 * Locked, per-platform Python requirement sets for the uv-managed engine packs.
 *
 * `tts-neural` is VieNeu-TTS v3-Turbo via the `vieneu` SDK, which runs torch-free
 * on CPU through ONNX Runtime — so there is NO torch / llama-cpp-python / GGUF
 * and no per-platform wheel juggling (it installs the same on every OS/arch,
 * Intel Macs included). The resolver still supports a per-platform overlay + extra
 * index URLs for other packs.
 *
 * ⚠️ The exact pins below are validated CANDIDATES, not yet verified on a real
 * install on every OS/arch. Before shipping VieNeu, confirm `vieneu==3.0.5`
 * installs and its default engine is v3-Turbo per platform. See
 * `workers/tts-engine-neural/README.md`.
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
  // every platform. `vieneu` pulls onnxruntime, soxr, tokenizers, sea-g2p and the
  // Perth watermarker transitively; we pin soundfile/numpy for our WAV I/O and
  // fastapi/uvicorn for the server.
  'tts-neural': {
    base: [
      'vieneu==3.0.5',
      'soundfile==0.13.1',
      'numpy==2.1.3',
      'fastapi==0.115.6',
      'uvicorn==0.34.0',
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
  // OmniVoice (k2-fsa) via mlx-audio — Apple Silicon ONLY (the `mlx`/`mlx-audio`
  // wheels are macOS/arm64). The pack is gated to darwin/arm64 in
  // enginePackCatalog, so this only ever installs there. mlx-audio pulls mlx +
  // transformers + numpy + scipy + tokenizers transitively; we add fastapi/uvicorn
  // for the server (it writes WAV with numpy + stdlib, so no soundfile needed).
  'tts-omnivoice': {
    base: [
      'mlx-audio==0.4.4',
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
