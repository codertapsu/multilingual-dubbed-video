/**
 * Curated catalog of downloadable engine packs.
 *
 * Hand-maintained (not network-fetched) so it renders instantly/offline and the
 * supported set is reviewable in code — same philosophy as the model catalog.
 * Each logical engine may have several packs (one per platform/arch/accel);
 * `availablePacks()` filters to the ones runnable on the current machine.
 *
 * URLs/checksums are pinned per release. They are intentionally easy to update:
 * bump the version constant and the artifact entries. The installer verifies
 * the sha256 when present and discards corrupt downloads.
 *
 * NOTE: checksums are left empty here; the installer logs a warning and still
 * installs when a checksum is absent (so the catalog stays usable before the
 * release-engineering step pins them). Pin them before shipping.
 */
import type { EnginePackInfo } from '@videodubber/shared';

/** Pinned upstream versions (single source of truth for URL templates). */
const WHISPER_CPP = 'v1.8.6';
const LLAMA_CPP = 'b9581';

/**
 * The full curated set. `availablePacks()` filters by platform/arch.
 *
 * Engines covered (see docs/TECH_STACK_RESEARCH.md):
 *   STT:         whisper.cpp (Metal/CUDA/Vulkan/CPU) — fast accelerated Whisper.
 *   translation: llama.cpp server (Metal/CUDA/Vulkan/CPU) — local LLM MT.
 *   tts:         neural TTS python env (Kokoro/VieNeu/Chatterbox/Qwen3-TTS).
 *   separation:  audio-separator python env (Demucs / MDX / RoFormer).
 *   alignment:   WhisperX python env (forced alignment + diarization).
 */
export const ENGINE_PACKS: readonly EnginePackInfo[] = [
  // --- whisper.cpp (STT acceleration) --------------------------------------
  {
    id: 'whisper-cpp-metal',
    kind: 'stt',
    packKind: 'binary',
    displayName: 'whisper.cpp (Apple Metal + CoreML)',
    description:
      'Accelerated Whisper for Apple Silicon (Metal GPU + optional CoreML/ANE encoder). ~10× realtime for large-v3-turbo. The macOS speed fix — CTranslate2 has no Metal backend.',
    providerId: 'whisper-cpp',
    platforms: ['darwin'],
    arch: ['arm64'],
    accel: 'metal',
    tier: 'balanced',
    approxSizeMb: 12,
    artifacts: [
      {
        url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP}/whisper-cpp-${WHISPER_CPP}-darwin-arm64.tar.gz`,
        approxSizeMb: 12,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT (whisper.cpp and ggml model conversions).',
  },
  {
    id: 'whisper-cpp-cuda',
    kind: 'stt',
    packKind: 'binary',
    displayName: 'whisper.cpp (NVIDIA CUDA)',
    description:
      'Accelerated Whisper for NVIDIA GPUs (CUDA). Large speedups over CPU for large models.',
    providerId: 'whisper-cpp',
    platforms: ['win32', 'linux'],
    arch: ['x64'],
    accel: 'cuda',
    tier: 'performance',
    minVramMb: 4096,
    approxSizeMb: 120,
    artifacts: [
      {
        url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP}/whisper-cpp-${WHISPER_CPP}-cuda-x64.tar.gz`,
        approxSizeMb: 120,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT.',
  },
  {
    id: 'whisper-cpp-vulkan',
    kind: 'stt',
    packKind: 'binary',
    displayName: 'whisper.cpp (Vulkan — AMD/Intel GPU)',
    description:
      'Accelerated Whisper via Vulkan for AMD/Intel GPUs on Windows/Linux where CUDA is unavailable.',
    providerId: 'whisper-cpp',
    platforms: ['win32', 'linux'],
    arch: ['x64'],
    accel: 'vulkan',
    tier: 'balanced',
    approxSizeMb: 30,
    artifacts: [
      {
        url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP}/whisper-cpp-${WHISPER_CPP}-vulkan-x64.tar.gz`,
        approxSizeMb: 30,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT.',
  },

  // --- llama.cpp server (local LLM translation) ----------------------------
  {
    id: 'llama-cpp-metal',
    kind: 'translation',
    packKind: 'binary',
    displayName: 'llama.cpp server (Apple Metal)',
    description:
      'Local LLM runtime for high-quality offline translation (TranslateGemma / Qwen3 / Gemma). OpenAI-compatible server; Metal-accelerated on Apple Silicon.',
    providerId: 'local-llm',
    platforms: ['darwin'],
    arch: ['arm64'],
    accel: 'metal',
    tier: 'performance',
    minRamMb: 16384,
    approxSizeMb: 20,
    artifacts: [
      {
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP}/llama-${LLAMA_CPP}-bin-macos-arm64.zip`,
        approxSizeMb: 20,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT (llama.cpp). Models downloaded separately under their own terms.',
  },
  {
    id: 'llama-cpp-cuda',
    kind: 'translation',
    packKind: 'binary',
    displayName: 'llama.cpp server (NVIDIA CUDA)',
    description:
      'Local LLM runtime for offline translation on NVIDIA GPUs. OpenAI-compatible server.',
    providerId: 'local-llm',
    platforms: ['win32', 'linux'],
    arch: ['x64'],
    accel: 'cuda',
    tier: 'performance',
    minVramMb: 8192,
    approxSizeMb: 400,
    artifacts: [
      {
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP}/llama-${LLAMA_CPP}-bin-win-cuda-x64.zip`,
        approxSizeMb: 400,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT.',
  },
  {
    id: 'llama-cpp-vulkan',
    kind: 'translation',
    packKind: 'binary',
    displayName: 'llama.cpp server (Vulkan / CPU)',
    description:
      'Local LLM runtime for offline translation via Vulkan (AMD/Intel GPU) or CPU on Windows/Linux.',
    providerId: 'local-llm',
    platforms: ['win32', 'linux'],
    arch: ['x64'],
    accel: 'vulkan',
    tier: 'balanced',
    minRamMb: 16384,
    approxSizeMb: 30,
    artifacts: [
      {
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP}/llama-${LLAMA_CPP}-bin-win-vulkan-x64.zip`,
        approxSizeMb: 30,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT.',
  },

  // --- neural TTS (uv-managed Python env) ----------------------------------
  {
    id: 'tts-neural',
    kind: 'tts',
    packKind: 'python-uv',
    displayName: 'Neural TTS engines (Kokoro / VieNeu / Chatterbox / Qwen3-TTS)',
    description:
      'Higher-quality multilingual neural voices, including the Vietnamese VieNeu upgrade over Piper. Runs in a self-contained Python environment (GPU/Metal-accelerated where available).',
    providerId: 'neural-tts',
    accel: 'cpu',
    tier: 'performance',
    minRamMb: 8192,
    approxSizeMb: 2500,
    artifacts: [
      {
        // The pack ships a locked requirements set; the installer materializes a
        // uv-managed venv from it (see engineInstaller). Voice weights download
        // on first use, like Whisper models.
        url: 'uv-env://tts-neural',
        approxSizeMb: 2500,
        destPath: 'venv',
      },
    ],
    licenseNote:
      'Engine code MIT/Apache. Individual voices carry their own model licenses; Vietnamese uses VieNeu-TTS (Apache-2.0). Stock voices only (no cloning).',
  },

  // --- vocal separation (uv-managed Python env) ----------------------------
  {
    id: 'separation-audio',
    kind: 'separation',
    packKind: 'python-uv',
    displayName: 'Vocal separation (Demucs / MDX / RoFormer)',
    description:
      'Separates the original into vocals + music/effects so the dub can replace only the voices and keep the original score. Cleaner transcripts on noisy audio, too.',
    providerId: 'audio-separator',
    accel: 'cpu',
    tier: 'performance',
    minRamMb: 8192,
    approxSizeMb: 2000,
    artifacts: [{ url: 'uv-env://separation-audio', approxSizeMb: 2000, destPath: 'venv' }],
    licenseNote: 'python-audio-separator MIT; Demucs MIT. Individual UVR model weights vary.',
  },

  // --- forced alignment + diarization (uv-managed Python env) ---------------
  {
    id: 'alignment-whisperx',
    kind: 'alignment',
    packKind: 'python-uv',
    displayName: 'Forced alignment + diarization (WhisperX)',
    description:
      'Word-accurate timestamps (±50 ms vs ±500 ms) for tighter dub sync, plus speaker diarization to assign a distinct voice per speaker.',
    providerId: 'whisperx',
    accel: 'cpu',
    tier: 'workstation',
    minRamMb: 16384,
    approxSizeMb: 3000,
    artifacts: [{ url: 'uv-env://alignment-whisperx', approxSizeMb: 3000, destPath: 'venv' }],
    licenseNote:
      'WhisperX BSD-2; English/EU aligners permissive; pyannote pipeline CC-BY-4.0 (gated). Vietnamese-source word alignment falls back to DTW.',
  },
] as const;

/** True if a pack can run on the given platform/arch. */
export function packRunsOn(pack: EnginePackInfo, platform: NodeJS.Platform, arch: string): boolean {
  if (pack.platforms && pack.platforms.length > 0 && !pack.platforms.includes(platform)) return false;
  if (pack.arch && pack.arch.length > 0 && !pack.arch.includes(arch)) return false;
  return true;
}

/** Packs runnable on the current (or given) machine. */
export function availablePacks(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackInfo[] {
  return ENGINE_PACKS.filter((p) => packRunsOn(p, platform, arch));
}

/** Look up a pack by id (across all platforms). */
export function findPack(packId: string): EnginePackInfo | undefined {
  return ENGINE_PACKS.find((p) => p.id === packId);
}
