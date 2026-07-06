/**
 * Hardware-aware engine-pack recommendations.
 *
 * Given the machine's {@link SystemProfile} + tier, suggest which engine packs
 * would most improve results — so the UI can offer "recommended for your
 * machine" installs (e.g. whisper.cpp Metal on Apple Silicon, llama.cpp +
 * TranslateGemma — the 4B from 8 GB, the 12B/27B with a GPU — neural TTS,
 * separation on capable machines).
 *
 * Pure: takes the profile + the available packs, returns ranked pack ids with a
 * reason. RAM/VRAM gates from the catalog are respected.
 */
import type { EngineAccel, EnginePackInfo, HardwareRecommendation, SystemProfile } from '@videodubber/shared';
import { availablePacks } from './enginePackCatalog.js';

/** One recommended pack with a human reason. */
export interface EnginePackRecommendation {
  packId: string;
  reason: string;
}

/** Whether a pack's RAM/VRAM gates are satisfied by the machine. */
export function packFitsMachine(pack: EnginePackInfo, profile: SystemProfile): boolean {
  if (pack.minRamMb && profile.totalRamMb < pack.minRamMb) return false;
  if (pack.minVramMb) {
    const vram = Math.max(0, ...profile.gpus.map((g) => g.vramMb ?? 0));
    // Apple Silicon shares memory with the GPU — treat total RAM as the budget.
    const effectiveVram = profile.appleSilicon ? profile.totalRamMb : vram;
    if (effectiveVram < pack.minVramMb) return false;
  }
  return true;
}

/** GPU marketing names that indicate an NVIDIA (CUDA-capable) GPU. */
const NVIDIA_RE = /nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i;

/** Does the machine physically have the accelerator this pack build targets? */
function accelSupported(accel: EngineAccel, profile: SystemProfile): boolean {
  switch (accel) {
    case 'cpu':
      return true;
    case 'metal':
    case 'coreml':
    case 'mps':
      // Apple GPU frameworks — only on Apple Silicon.
      return profile.appleSilicon;
    case 'cuda':
      // CUDA builds require an NVIDIA GPU; match the detected GPU name.
      return profile.gpus.some((g) => NVIDIA_RE.test(g.name));
    case 'vulkan':
      // Intentionally NOT gated: GPU detection runs `nvidia-smi` only, so the
      // AMD/Intel GPUs a Vulkan build targets report as gpus:[]. Gating on GPU
      // presence would hide the pack from its own audience, and the Vulkan builds
      // fall back to CPU, so a wrong "✓" costs "slow", not "cannot run".
      return true;
    default:
      return true;
  }
}

/**
 * HARD gate: can this pack's binary actually RUN on this machine? False means it
 * physically cannot (wrong/absent GPU for the accel, or the model can't fit in
 * RAM/VRAM), so the UI must not offer it. This is stricter than
 * {@link packFitsMachine} (which is a soft "runs well" hint) — it also enforces
 * the accelerator requirement, so e.g. a CUDA pack never shows on a machine with
 * no NVIDIA GPU.
 */
export function packHardwareSupported(pack: EnginePackInfo, profile: SystemProfile): boolean {
  return accelSupported(pack.accel, profile) && packFitsMachine(pack, profile);
}

/**
 * Rank the engine packs worth installing on this machine. One pack per provider
 * family (the most capable that fits), with a reason tied to the hardware.
 */
export function recommendEnginePacks(
  profile: SystemProfile,
  rec: HardwareRecommendation,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackRecommendation[] {
  const fitting = availablePacks(platform, arch).filter((p) => packFitsMachine(p, profile));
  const out: EnginePackRecommendation[] = [];
  const takeBest = (providerId: string, reason: string): void => {
    const pack = fitting.find((p) => p.providerId === providerId);
    if (pack) out.push({ packId: pack.id, reason });
  };

  // "Workstation-class" is the top of the performance tier: 32 GB+ of memory
  // (unified on Apple Silicon, or system RAM with a strong discrete GPU).
  const workstation = profile.totalRamMb >= 32 * 1024;

  // STT acceleration: always worth it on Apple Silicon (CPU-only otherwise);
  // worth it on machines with a capable GPU too.
  if (profile.appleSilicon) {
    takeBest('whisper-cpp', 'Apple Silicon: Metal-accelerated transcription is far faster than the CPU build.');
  } else if (profile.gpus.length > 0) {
    takeBest('whisper-cpp', 'A GPU was detected: accelerated transcription is much faster than CPU.');
  }

  // Local LLM translation (TranslateGemma): the runtime binary PLUS the largest
  // model the machine can comfortably run. 4B is the CPU-friendly floor (8 GB+,
  // no GPU needed); 12B/27B are only worth it with a GPU/Apple-Silicon to keep
  // them fast — on pure CPU a 12B is ~1–5 tok/s, too slow to recommend.
  const accelerated = profile.appleSilicon || profile.gpus.length > 0;
  const ramGb = profile.totalRamMb / 1024;
  const modelPackId =
    ramGb >= 32 && accelerated
      ? 'translategemma-27b'
      : ramGb >= 16 && accelerated
        ? 'translategemma-12b'
        : ramGb >= 8
          ? 'translategemma-4b'
          : undefined;
  const runtimePack = fitting.find((p) => p.providerId === 'local-llm');
  const modelPack = modelPackId ? fitting.find((p) => p.id === modelPackId) : undefined;
  if (runtimePack && modelPack) {
    out.push({
      packId: runtimePack.id,
      reason: 'Runs TranslateGemma locally — a big translation-quality jump over the offline Argos default.',
    });
    const why =
      modelPack.id === 'translategemma-4b'
        ? 'The CPU-friendly 4B TranslateGemma — much better than Argos, light enough to run without a GPU.'
        : modelPack.id === 'translategemma-12b'
          ? 'Your GPU/Apple-Silicon can drive the 12B TranslateGemma — the translation-quality sweet spot.'
          : 'Workstation-class: the 27B TranslateGemma for the best local translation quality.';
    out.push({ packId: modelPack.id, reason: why });
  }

  // Neural TTS: better voices (incl. the Vietnamese VieNeu upgrade) on capable machines.
  if (rec.tier !== 'constrained') {
    takeBest('neural-tts', 'More natural neural voices, including a better Vietnamese voice than Piper.');
  }

  // Separation + alignment: workstation-class machines can afford the extra passes.
  if (workstation) {
    takeBest('audio-separator', 'Keep the original music & effects under the dub instead of ducking everything.');
    takeBest('alignment-whisperx', 'Word-accurate timing and per-speaker voices for multi-speaker videos.');
  }

  return out;
}
