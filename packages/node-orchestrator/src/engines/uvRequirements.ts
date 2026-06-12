/**
 * Locked, per-platform Python requirement sets for the uv-managed engine packs.
 *
 * Pinning matters most for `tts-neural` (VieNeu): `llama-cpp-python` ships
 * platform-specific wheels, and `neucodec` pulls a large `torch` — on Linux and
 * Windows the default torch wheel bundles CUDA (huge), so we install the CPU
 * build from the PyTorch CPU index instead. macOS uses the default wheel
 * (CPU/MPS). The resolver merges a common `base` set with a per-platform overlay
 * and the union of extra pip index URLs.
 *
 * ⚠️ The exact pins below are validated CANDIDATES, not yet verified on a real
 * install on every OS/arch. Before shipping VieNeu, confirm each version resolves
 * (and the wheels are accelerated where expected) per platform, and replace the
 * `neuttsair` git ref with a pinned commit/tag. See
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

/** The PyTorch CPU wheel index — avoids the multi-GB CUDA default on Linux/Win. */
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

const UV_REQUIREMENTS: Record<string, UvRequirementSpec> = {
  // VieNeu neural TTS (GGUF CPU stack). torch is pulled by neucodec; pin it +
  // route Linux/Windows to the CPU index so we don't drag in CUDA.
  'tts-neural': {
    base: [
      'llama-cpp-python==0.3.16',
      'neucodec==0.0.4',
      'phonemizer==3.3.0',
      'soundfile==0.13.1',
      'numpy==2.1.3',
      'huggingface-hub==0.27.1',
      'fastapi==0.115.6',
      'uvicorn==0.34.0',
      // NeuTTS Air inference code (Apache-2.0; not on PyPI). Replace @main with a
      // pinned commit/tag before release for reproducibility.
      'neuttsair @ git+https://github.com/neuphonic/neutts-air.git@main',
    ],
    perPlatform: {
      linux: { requirements: ['torch==2.5.1'], extraIndexUrls: [TORCH_CPU_INDEX] },
      win32: { requirements: ['torch==2.5.1'], extraIndexUrls: [TORCH_CPU_INDEX] },
      darwin: { requirements: ['torch==2.5.1'] },
    },
  },
  // Out of the VieNeu hardening scope — kept at their existing (loose) sets.
  'separation-audio': {
    base: ['audio-separator>=0.18', 'onnxruntime>=1.20', 'fastapi>=0.110', 'uvicorn>=0.29'],
  },
  'alignment-whisperx': {
    base: ['whisperx>=3.8', 'fastapi>=0.110', 'uvicorn>=0.29'],
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
