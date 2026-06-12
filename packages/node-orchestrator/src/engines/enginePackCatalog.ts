/**
 * Curated catalog of downloadable engine packs.
 *
 * Hand-maintained (not network-fetched) so it renders instantly/offline and the
 * supported set is reviewable in code — same philosophy as the model catalog.
 * Each logical engine may have several packs (one per platform/arch/accel);
 * `availablePacks()` filters to the ones runnable on the current machine.
 *
 * ── EDITING URLs ──────────────────────────────────────────────────────────
 * To change what gets downloaded, edit:
 *   1. the version constants below (LLAMA_CPP / WHISPER_CPP), and
 *   2. each pack's `artifacts[].url` + `artifacts[].sha256`.
 * The installer verifies the sha256 when present (and discards corrupt
 * downloads); when sha256 is empty it logs a warning and installs unverified.
 * See docs/ENGINE_PACKS.md for the full "where to host / how to pin" guide.
 *
 * ── WHAT IS UPSTREAM vs SELF-HOSTED ──────────────────────────────────────
 *  - llama.cpp publishes prebuilt server binaries for every platform we ship,
 *    so the `llama-cpp-*` packs point straight at ggml-org's GitHub releases.
 *  - whisper.cpp publishes prebuilt binaries ONLY for Windows. The macOS Metal
 *    server has NO upstream binary, so `whisper-cpp-metal` points at
 *    SELF_HOSTED_BASE — YOU build it once and upload it to your own GitHub
 *    Release (recipe in docs/ENGINE_PACKS.md), then set codertapsu/multilingual-dubbed-video + the tag.
 *  - The Python packs (`tts-neural`, `separation-audio`, `alignment-whisperx`)
 *    have NO download URL — they install from PyPI via the bundled `uv`
 *    (`uv-env://` markers; the per-platform requirement sets live in
 *    engines/uvRequirements.ts).
 */
import type { EnginePackInfo } from '@videodubber/shared';

// Pinned upstream releases (single source of truth for the URL templates).
// Verified against the GitHub releases on 2026-06-11.
const LLAMA_CPP = 'b9592'; // github.com/ggml-org/llama.cpp/releases
const WHISPER_CPP = 'v1.8.6'; // github.com/ggml-org/whisper.cpp/releases

/** Upstream release-asset download bases. */
const LLAMA_DL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP}`;
const WHISPER_DL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP}`;

/**
 * Base URL for binaries with NO upstream prebuilt (currently: the macOS Metal
 * whisper.cpp server). Replace codertapsu/multilingual-dubbed-video and the tag with your own GitHub
 * Release once you've built + uploaded the asset (see docs/ENGINE_PACKS.md).
 * Until then, installing `whisper-cpp-metal` fails with a clear network error
 * — every OTHER engine (llama.cpp, neural TTS, separation, alignment) works.
 */
const SELF_HOSTED_BASE =
  process.env.VIDEODUBBER_ENGINE_BASE?.trim() ||
  'https://github.com/codertapsu/multilingual-dubbed-video/releases/download/engine-packs-v1';

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
  // whisper.cpp ships prebuilt binaries for WINDOWS ONLY. macOS Metal has no
  // upstream server build, so that pack is self-hosted (build recipe in
  // docs/ENGINE_PACKS.md). Everywhere else, the bundled faster-whisper already
  // covers CPU, and Windows NVIDIA is covered by the cuBLAS pack below.
  {
    id: 'whisper-cpp-metal',
    kind: 'stt',
    packKind: 'binary',
    displayName: 'whisper.cpp (Apple Metal)',
    description:
      'Accelerated Whisper for Apple Silicon (Metal GPU). ~10× realtime for large-v3-turbo — the macOS speed fix, since CTranslate2 has no Metal backend. Self-hosted binary (see docs/ENGINE_PACKS.md).',
    providerId: 'whisper-cpp',
    platforms: ['darwin'],
    arch: ['arm64'],
    accel: 'metal',
    tier: 'balanced',
    approxSizeMb: 14,
    artifacts: [
      {
        // No upstream macOS server binary — built + uploaded to your own release.
        url: `${SELF_HOSTED_BASE}/whisper-cpp-${WHISPER_CPP}-macos-arm64.tar.gz`,
        sha256: '',
        approxSizeMb: 14,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT (whisper.cpp + ggml).',
  },
  {
    id: 'whisper-cpp-cuda',
    kind: 'stt',
    packKind: 'binary',
    displayName: 'whisper.cpp (NVIDIA CUDA, Windows)',
    description:
      'Accelerated Whisper for NVIDIA GPUs on Windows (cuBLAS). Large speedups over CPU for big models.',
    providerId: 'whisper-cpp',
    platforms: ['win32'],
    arch: ['x64'],
    accel: 'cuda',
    tier: 'performance',
    minVramMb: 4096,
    approxSizeMb: 90,
    artifacts: [
      {
        // Upstream prebuilt (contains whisper-cli.exe / whisper-server.exe).
        url: `${WHISPER_DL}/whisper-cublas-12.4.0-bin-x64.zip`,
        sha256: '63b70c91fe2fd7449865c45f6422ab628439eacc6985d8309c77bfb65cc68a19',
        approxSizeMb: 90,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT. Requires an NVIDIA GPU + driver.',
  },

  // --- llama.cpp server (local LLM translation) ----------------------------
  // All upstream: ggml-org publishes prebuilt llama-server binaries per platform.
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
    approxSizeMb: 30,
    artifacts: [
      {
        url: `${LLAMA_DL}/llama-${LLAMA_CPP}-bin-macos-arm64.tar.gz`,
        sha256: 'e395d9f746bc1b04e3e019295e76a5158de3ecc837a2f08b7fe6e76ec5b42729',
        approxSizeMb: 30,
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
    displayName: 'llama.cpp server (NVIDIA CUDA, Windows)',
    description:
      'Local LLM runtime for offline translation on NVIDIA GPUs (Windows). OpenAI-compatible server.',
    providerId: 'local-llm',
    platforms: ['win32'],
    arch: ['x64'],
    accel: 'cuda',
    tier: 'performance',
    minVramMb: 8192,
    approxSizeMb: 420,
    artifacts: [
      {
        url: `${LLAMA_DL}/llama-${LLAMA_CPP}-bin-win-cuda-12.4-x64.zip`,
        sha256: 'd00b3e988f0fbd03d055904eb361b1065cfa014e1860366d42eb599af4016260',
        approxSizeMb: 30,
        destPath: '.',
        archive: true,
      },
      {
        // The CUDA build needs the CUDA 12 runtime DLLs (separate upstream zip),
        // extracted alongside llama-server.exe.
        url: `${LLAMA_DL}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
        approxSizeMb: 390,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT. Requires an NVIDIA GPU + driver.',
  },
  {
    id: 'llama-cpp-vulkan',
    kind: 'translation',
    packKind: 'binary',
    displayName: 'llama.cpp server (Vulkan, Windows)',
    description:
      'Local LLM runtime for offline translation via Vulkan (AMD/Intel GPU) on Windows. OpenAI-compatible server.',
    providerId: 'local-llm',
    platforms: ['win32'],
    arch: ['x64'],
    accel: 'vulkan',
    tier: 'balanced',
    minRamMb: 16384,
    approxSizeMb: 40,
    artifacts: [
      {
        url: `${LLAMA_DL}/llama-${LLAMA_CPP}-bin-win-vulkan-x64.zip`,
        sha256: '126667a2b89892fdc0c3b0b95cba0783bbdfaa69d8fd13e3d8da5c4c1307c8f4',
        approxSizeMb: 40,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT.',
  },
  {
    id: 'llama-cpp-linux',
    kind: 'translation',
    packKind: 'binary',
    displayName: 'llama.cpp server (Linux, Vulkan/CPU)',
    description:
      'Local LLM runtime for offline translation on Linux (Vulkan GPU, CPU fallback). OpenAI-compatible server.',
    providerId: 'local-llm',
    platforms: ['linux'],
    arch: ['x64'],
    accel: 'vulkan',
    tier: 'balanced',
    minRamMb: 16384,
    approxSizeMb: 50,
    artifacts: [
      {
        url: `${LLAMA_DL}/llama-${LLAMA_CPP}-bin-ubuntu-vulkan-x64.tar.gz`,
        sha256: '414cf74f8e9e185c2903b4e7520b0479b723f60ae501fb16ed3a3cf89fd59719',
        approxSizeMb: 50,
        destPath: '.',
        archive: true,
      },
    ],
    licenseNote: 'MIT.',
  },

  // --- neural TTS: VieNeu v2 (uv-managed Python env) -----------------------
  {
    id: 'tts-neural-v2',
    kind: 'tts',
    packKind: 'python-uv',
    displayName: 'VieNeu Neural TTS v2 (Vietnamese)',
    description:
      'A far more natural Vietnamese voice than Piper, via VieNeu-TTS v2 (24 kHz): a GGUF speech model + NeuCodec run on CPU through the `vieneu` SDK. Ships 7 reference voices (North/South, male/female); the model (~0.3–0.7 GB) downloads on first use. Optional and CPU-only — Piper stays the fast default. Output carries an imperceptible AI-audio watermark.',
    providerId: 'neural-tts-v2',
    accel: 'cpu',
    tier: 'performance',
    minRamMb: 4096,
    approxSizeMb: 1200,
    artifacts: [
      {
        url: 'uv-env://tts-neural-v2',
        approxSizeMb: 1200,
        destPath: 'venv',
      },
    ],
    licenseNote:
      'Engine code + backbone weights Apache-2.0, BUT the 7 bundled reference voices are CC BY-NC 4.0 — NON-COMMERCIAL use only, attribution to pnnbao-ump. For commercial dubbing use your own voices or VieNeu v3. Output is watermarked.',
  },

  // --- neural TTS: VieNeu v3-Turbo (uv-managed Python env) -----------------
  {
    id: 'tts-neural',
    kind: 'tts',
    packKind: 'python-uv',
    displayName: 'VieNeu Neural TTS v3 (Vietnamese)',
    description:
      'A far more natural Vietnamese voice than Piper, via VieNeu-TTS v3-Turbo: a 48 kHz speech model that runs torch-free on CPU through ONNX (the `vieneu` SDK). Ships 10 preset Vietnamese voices; the model (~0.5–1 GB) downloads on first use. Optional and CPU-only — Piper stays the fast default. Output carries an imperceptible AI-audio watermark.',
    providerId: 'neural-tts',
    accel: 'cpu',
    tier: 'performance',
    // CPU-feasible at ~1.5–2 GB working RAM. No torch/GGUF, so it runs on every
    // platform — including Intel macOS.
    minRamMb: 4096,
    approxSizeMb: 1500,
    artifacts: [
      {
        // The pack ships a locked requirements set; the installer materializes a
        // uv-managed venv from it (see engineInstaller). The first-party
        // `vd_tts_engine` server is loaded from bundled source via PYTHONPATH
        // (see engineManager). The VieNeu v3 model downloads on first use, like
        // Whisper models.
        url: 'uv-env://tts-neural',
        approxSizeMb: 1500,
        destPath: 'venv',
      },
    ],
    licenseNote:
      'Apache-2.0 — VieNeu-TTS v3 code + weights. Uses the MOSS-Audio-Tokenizer-Nano codec and sea-g2p (verify their licenses). Preset voices only; output is watermarked.',
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
  if (pack.excludePlatformArch?.some((e) => e.platform === platform && e.arch === arch)) return false;
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
