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
 *  - whisper.cpp publishes prebuilt binaries ONLY for Windows (the CUDA pack).
 *    There is NO upstream macOS/Linux server binary; rather than offer an Install
 *    button that 404s, we DON'T ship a macOS Metal whisper.cpp pack — macOS STT
 *    uses the bundled faster-whisper (CPU). To add a Metal pack, build + host the
 *    binary (recipe in docs/ENGINE_PACKS.md) and add an entry with its URL.
 *  - The Python packs (`tts-neural`, `tts-neural-v2`, `separation-audio`,
 *    `alignment-whisperx`) have NO download URL — they install from PyPI via the
 *    bundled `uv` (`uv-env://` markers; the per-platform requirement sets live in
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
 * TranslateGemma GGUF weights (the `local-llm-model` packs).
 *
 * Google ships TranslateGemma as safetensors ONLY — there is no official Google
 * GGUF and (as of 2026-06) no bartowski/unsloth/ggml-org build — so we pin
 * community requants. File names/sizes/sha256 were read from each repo's LFS
 * pointers on 2026-06-19; the sha256 makes the pin tamper-evident (a re-upload
 * with different bytes fails the install cleanly rather than loading bad weights,
 * exactly like our moved-GitHub-URL story). To bump a quant, edit the URL + the
 * sha256/size below. We pull Q4_K_M (the Ollama default): the best size/quality
 * trade-off for MT; do not go below Q4. The weights are under the GEMMA TERMS OF
 * USE (ai.google.dev/gemma/terms) — NOT MIT/Apache — hence `commercial-restricted`
 * + the licenseNote pass-through (see docs/PROVIDERS.md and NOTICE.md).
 */
const TG_4B_URL = 'https://huggingface.co/mradermacher/translategemma-4b-it-GGUF/resolve/main/translategemma-4b-it.Q4_K_M.gguf';
const TG_12B_URL = 'https://huggingface.co/bullerwins/translategemma-12b-it-GGUF/resolve/main/translategemma-12b-it-Q4_K_M.gguf';
const TG_27B_URL = 'https://huggingface.co/bullerwins/translategemma-27b-it-GGUF/resolve/main/translategemma-27b-it-Q4_K_M.gguf';

/** The Gemma-license note carried by every TranslateGemma model pack. */
const GEMMA_LICENSE_NOTE =
  'TranslateGemma weights are provided under the Gemma Terms of Use ' +
  '(ai.google.dev/gemma/terms) — NOT MIT/Apache. Commercial use IS permitted, ' +
  'subject to Google’s Prohibited Use Policy (ai.google.dev/gemma/prohibited_use_policy), ' +
  'which the app passes through in its notices. Redistributed here as a community ' +
  'GGUF requant of google/translategemma-*-it. Output translations are yours (Gemma Terms §3.3).';

/**
 * The full curated set. `availablePacks()` filters by platform/arch. Every pack
 * here has a reachable artifact (binary URL or uv-env), so its Install works.
 *
 * Engines covered (see docs/TECH_STACK_RESEARCH.md):
 *   STT:         whisper.cpp CUDA (Windows) — accelerated Whisper (macOS/Linux
 *                use the bundled faster-whisper on CPU).
 *   translation: llama.cpp server (Metal/CUDA/Vulkan/CPU) — local LLM MT runtime,
 *                plus the `local-llm-model` GGUF packs (TranslateGemma 4B/12B/27B)
 *                it loads. Runtime + a model pack together make the provider run.
 *   tts:         VieNeu neural TTS python env (v2 + v3-Turbo).
 *   separation:  audio-separator python env (Demucs / MDX / RoFormer).
 *   alignment:   WhisperX python env (forced alignment + diarization).
 */
export const ENGINE_PACKS: readonly EnginePackInfo[] = [
  // --- whisper.cpp (STT acceleration) --------------------------------------
  // whisper.cpp ships prebuilt server binaries for WINDOWS ONLY. There's no
  // upstream macOS Metal / Linux server build, so we don't offer one (a 404
  // Install button is worse than none) — macOS/Linux use the bundled
  // faster-whisper on CPU. To add a Metal pack, build + host the binary (recipe
  // in docs/ENGINE_PACKS.md) and add an entry pointing at its URL.
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
    // No RAM gate on the runtime binary itself (it's tiny); the TranslateGemma
    // model pack carries the real memory requirement, so the 4B model stays
    // reachable on 8 GB Apple Silicon instead of being blanket-gated at 16 GB.
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
    // RAM gate lives on the model pack, not the runtime binary (see metal pack).
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
    // RAM gate lives on the model pack, not the runtime binary (see metal pack).
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

  // --- TranslateGemma GGUF model packs (consumed by the llama.cpp runtime) --
  // `packKind: 'model'` = weights only; they pair with an installed llama.cpp
  // runtime pack above (the provider needs BOTH). One model size per pack so the
  // hardware recommender can offer 4B on CPU/8 GB, 12B on accelerated/16 GB, and
  // 27B on workstation-class machines. `accel: 'cpu'` + no platform filter = runs
  // anywhere the runtime does. The model downloads on install (progress-tracked),
  // then everything is offline — no per-launch network fetch.
  {
    id: 'translategemma-4b',
    kind: 'translation',
    packKind: 'model',
    displayName: 'TranslateGemma 4B (local translation model)',
    description:
      'Google’s open translation model (Gemma 3 based, 55 languages incl. Vietnamese), Q4_K_M GGUF — a large quality jump over Argos for offline MT. The 4B is the CPU-friendly size (~2.5 GB, runs on 8 GB RAM). Needs a llama.cpp runtime pack (installed automatically alongside).',
    providerId: 'local-llm-model',
    accel: 'cpu',
    tier: 'balanced',
    minRamMb: 8192,
    approxSizeMb: 2490,
    artifacts: [
      {
        url: TG_4B_URL,
        sha256: '81200d03e843d2ec1ece6eeafe7d13cb6e5211e1fcd336ade55790b683a08330',
        approxSizeMb: 2490,
        destPath: 'model.gguf',
      },
    ],
    licenseCategory: 'commercial-restricted',
    licenseNote: GEMMA_LICENSE_NOTE,
  },
  {
    id: 'translategemma-12b',
    kind: 'translation',
    packKind: 'model',
    displayName: 'TranslateGemma 12B (local translation model)',
    description:
      'The 12B TranslateGemma (Q4_K_M GGUF, ~7.3 GB) — the quality sweet spot, best on a GPU or Apple Silicon (16 GB+). Usable but slow on CPU-only machines; prefer the 4B there. Needs a llama.cpp runtime pack.',
    providerId: 'local-llm-model',
    accel: 'cpu',
    tier: 'performance',
    minRamMb: 16384,
    approxSizeMb: 7301,
    artifacts: [
      {
        url: TG_12B_URL,
        sha256: '9196d728812afbf5efc10b539298585725edc3a4ecc092c22fdde5bbaf41879e',
        approxSizeMb: 7301,
        destPath: 'model.gguf',
      },
    ],
    licenseCategory: 'commercial-restricted',
    licenseNote: GEMMA_LICENSE_NOTE,
  },
  {
    id: 'translategemma-27b',
    kind: 'translation',
    packKind: 'model',
    displayName: 'TranslateGemma 27B (local translation model)',
    description:
      'The 27B TranslateGemma (Q4_K_M GGUF, ~16.5 GB) — maximum local quality, for workstation-class machines (32 GB+ / strong GPU). Impractical CPU-only. Needs a llama.cpp runtime pack.',
    providerId: 'local-llm-model',
    accel: 'cpu',
    tier: 'workstation',
    minRamMb: 32768,
    approxSizeMb: 16547,
    artifacts: [
      {
        url: TG_27B_URL,
        sha256: '475bb629b999b4a197f5f0165503bc935a28e39a34cbeb32f73fc8b683deb5fa',
        approxSizeMb: 16547,
        destPath: 'model.gguf',
      },
    ],
    licenseCategory: 'commercial-restricted',
    licenseNote: GEMMA_LICENSE_NOTE,
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

  // --- neural TTS: OmniVoice multilingual (uv-managed Python env, MLX) ------
  // Apple-Silicon-ONLY: mlx-audio runs OmniVoice (k2-fsa) via Apple's MLX (Metal),
  // so the pack is gated to darwin/arm64 — offered ONLY where it can actually run.
  // On other platforms the provider isn't even registered (see providers/registry.ts),
  // so it never appears as a permanently-uninstallable option.
  {
    id: 'tts-omnivoice',
    kind: 'tts',
    packKind: 'python-uv',
    displayName: 'OmniVoice Neural TTS (multilingual, Apple Silicon)',
    description:
      'A massively multilingual neural voice — OmniVoice (k2-fsa), 600+ languages — running the full PyTorch model on the Apple Silicon Metal (MPS) backend (the same pipeline as the official demo, for faithful audio quality). Far broader language coverage than Piper, with “designed” voices (gender + age + pitch attributes). 24 kHz; the model (~3 GB) downloads on first use. Generates around real-time (RTF ~1) on an M-series chip. Optional and Apple-Silicon-only — Piper stays the fast default.',
    providerId: 'omnivoice',
    platforms: ['darwin'],
    arch: ['arm64'],
    accel: 'metal',
    tier: 'performance',
    // ~0.8B-param model, ~3 GB resident in fp16. It loads EXCLUSIVELY (evicting
    // other heavy engine packs first), but the bundled STT/TTS workers stay
    // resident and the GPU shares RAM on Apple Silicon — so gate higher than the
    // model alone to avoid mid-run memory pressure (packFitsMachine treats total
    // RAM as VRAM here).
    minRamMb: 16384,
    approxSizeMb: 1500,
    artifacts: [
      {
        // uv venv (torch + omnivoice) per uvRequirements['tts-omnivoice']; the
        // first-party `vd_omnivoice` server is loaded from bundled source via
        // PYTHONPATH (see engineManager). The OmniVoice model downloads on first
        // use into the pack's hf/ dir, like the Whisper/VieNeu models.
        url: 'uv-env://tts-omnivoice',
        approxSizeMb: 1500,
        destPath: 'venv',
      },
    ],
    licenseCategory: 'commercial-restricted',
    licenseNote:
      'OmniVoice code + weights are Apache-2.0 (k2-fsa), but the bundled HiggsAudio tokenizer carries the Boson Higgs Audio 2 Community License (non-OSI; 100k annual-active-users commercial gate). Fine for this open-source, non-commercial app — review before any commercial redistribution. Apple Silicon only (PyTorch/MPS). Reference-audio voice cloning is supported by the model but not wired here (designed voices only).',
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

  // --- LibreTranslate server (uv-managed Python env) -----------------------
  {
    id: 'translation-libretranslate',
    kind: 'translation',
    packKind: 'python-uv',
    displayName: 'LibreTranslate (local server)',
    description:
      "A self-hosted LibreTranslate API server for offline translation. Its engine IS Argos Translate, so quality matches the built-in Argos provider — it reuses the language packs you've already installed (Settings → Translation packs / onboarding), so no extra model download. Optional; Argos stays the default.",
    providerId: 'libretranslate',
    accel: 'cpu',
    // Light: it's Argos + a Flask server (CTranslate2 on CPU), so it runs on
    // essentially any machine that runs the app — not a performance-class engine.
    tier: 'balanced',
    minRamMb: 2048,
    approxSizeMb: 700,
    artifacts: [{ url: 'uv-env://translation-libretranslate', approxSizeMb: 700, destPath: 'venv' }],
    licenseNote:
      'LibreTranslate is AGPL-3.0; its engine Argos Translate is MIT. Installed on demand from PyPI; it serves your already-installed Argos language packs.',
  },
] as const;

/**
 * Packs that are DEFINED but temporarily withheld from availability — their
 * catalog entry + launch spec stay in the tree but are excluded from
 * `availablePacks()`, so they never appear in the engines list, the provider
 * registry, or the wizard/editor. Add an id here to disable that pack.
 *
 * `separation-audio` / `alignment-whisperx`: their Python worker servers
 * (vd_separator / vd_whisperx) are still UNIMPLEMENTED stubs, so the pack would
 * install but never become healthy. Withhold them until the workers exist, so a
 * user can't install a non-functional engine. (Their providers already degrade
 * gracefully to null when absent.)
 *
 * `tts-omnivoice`: the worker was reworked onto the official PyTorch/MPS
 * pipeline (fixing the MLX-codec degradation and the invalid instruct
 * attributes), but output quality is still not stable enough to ship. Held out
 * of releases until it is — status, findings, and the re-enable checklist live
 * in docs/OMNIVOICE.md.
 */
const DISABLED_PACK_IDS: ReadonlySet<string> = new Set<string>([
  'separation-audio',
  'alignment-whisperx',
  'tts-omnivoice',
]);

/** True if a pack can run on the given platform/arch. */
export function packRunsOn(pack: EnginePackInfo, platform: NodeJS.Platform, arch: string): boolean {
  if (pack.platforms && pack.platforms.length > 0 && !pack.platforms.includes(platform)) return false;
  if (pack.arch && pack.arch.length > 0 && !pack.arch.includes(arch)) return false;
  if (pack.excludePlatformArch?.some((e) => e.platform === platform && e.arch === arch)) return false;
  return true;
}

/** Packs runnable on the current (or given) machine (excludes disabled packs). */
export function availablePacks(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackInfo[] {
  return ENGINE_PACKS.filter((p) => !DISABLED_PACK_IDS.has(p.id) && packRunsOn(p, platform, arch));
}

/** Look up a pack by id (across all platforms). */
export function findPack(packId: string): EnginePackInfo | undefined {
  return ENGINE_PACKS.find((p) => p.id === packId);
}
