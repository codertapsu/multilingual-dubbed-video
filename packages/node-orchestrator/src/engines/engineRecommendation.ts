/**
 * Hardware-aware engine-pack recommendations.
 *
 * Given the machine's {@link SystemProfile} + tier, suggest which engine packs
 * would most improve results — so the UI can offer "recommended for your
 * machine" installs (e.g. whisper.cpp Metal on Apple Silicon, llama.cpp +
 * TranslateGemma on 16 GB+, neural TTS, separation on capable machines).
 *
 * Pure: takes the profile + the available packs, returns ranked pack ids with a
 * reason. RAM/VRAM gates from the catalog are respected.
 */
import type { EnginePackInfo, HardwareRecommendation, SystemProfile } from '@videodubber/shared';
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

  // Local LLM translation: a big quality jump over Argos when RAM allows.
  if (rec.tier === 'performance') {
    takeBest('local-llm', 'Enough memory for a local LLM — much better translation quality than the offline default.');
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
