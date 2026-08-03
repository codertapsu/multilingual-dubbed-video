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
import {
  MIN_GPU_RESIDENT_FRACTION,
  NVIDIA_GPU_RE,
  gpuResidentFraction,
  gpuWeightBudgetMb,
  outdatedNvidiaDriver,
  type EngineAccel,
  type EnginePackInfo,
  type HardwareRecommendation,
  type SystemProfile,
} from '@videodubber/shared';
import { availablePacks, findPack } from './enginePackCatalog.js';

/** One recommended pack with a human reason. */
export interface EnginePackRecommendation {
  packId: string;
  reason: string;
}

/**
 * Is this machine's NVIDIA driver new enough for a pack's CUDA build?
 *
 * Thin wrapper over the shared {@link outdatedNvidiaDriver}, which the desktop
 * UI uses too so the badge and the gate can never disagree. FAILS OPEN: an
 * undetectable driver reads as "don't judge", because wrongly hiding a working
 * CUDA build from the user who most wants it is worse than the one failed start
 * the runtime fallback already survives.
 */
export function nvidiaDriverSupportsPack(pack: EnginePackInfo, profile: SystemProfile): boolean {
  return outdatedNvidiaDriver(pack, profile.gpus) === undefined;
}

/** Whether a pack's RAM/VRAM/driver gates are satisfied by the machine. */
export function packFitsMachine(pack: EnginePackInfo, profile: SystemProfile): boolean {
  if (pack.minRamMb && profile.totalRamMb < pack.minRamMb) return false;
  if (pack.minVramMb) {
    const vram = Math.max(0, ...profile.gpus.map((g) => g.vramMb ?? 0));
    // Apple Silicon shares memory with the GPU — treat total RAM as the budget.
    const effectiveVram = profile.appleSilicon ? profile.totalRamMb : vram;
    if (effectiveVram < pack.minVramMb) return false;
  }
  // A CUDA build on too old a driver runs exactly as far as allocating its
  // buffers and then aborts, so it must not be recommended or badged "✓ can
  // run". It stays VISIBLE (packHardwareSupported is unchanged): unlike a
  // missing GPU this is the user's to fix, and hiding the row would take the
  // explanation away with it.
  if (!nvidiaDriverSupportsPack(pack, profile)) return false;
  return true;
}

/**
 * Tolerance applied when a fit decision CHOOSES a pack rather than badging one.
 *
 * `os.totalmem()` reports physical RAM minus firmware/kernel reservations on
 * Windows (`ullTotalPhys`) and Linux (`MemTotal`), so a genuine 32 GB machine
 * reports ~31.8 GB. Every catalog gate is an exact GiB power of two (8192 /
 * 16384 / 24576 / 32768), so a strict compare makes EVERY tier boundary
 * unreachable on those platforms — a 32 GB workstation would be told its 27B
 * model "needs about 32 GB; this computer has 32 GB".
 *
 * This is the same trap commit f2f765e fixed for pack VISIBILITY ("RAM is a
 * soft badge"); selection must not reintroduce it one layer down. 5% covers the
 * reservation on every machine we've measured while still rejecting a genuinely
 * smaller tier (16 GB vs a 24 GB gate fails by a wide margin).
 */
const SELECTION_RAM_SLACK = 0.95;

/**
 * Fit check for CHOOSING between installed packs of the same function.
 * Like {@link packFitsMachine} but tolerant of the under-reporting above —
 * picking a smaller model than the user installed is a real cost, so the
 * benefit of the doubt goes to the more capable pack.
 */
export function packFitsForSelection(pack: EnginePackInfo, profile: SystemProfile): boolean {
  if (pack.minRamMb && profile.totalRamMb < pack.minRamMb * SELECTION_RAM_SLACK) return false;
  if (pack.minVramMb) {
    const vram = Math.max(0, ...profile.gpus.map((g) => g.vramMb ?? 0));
    const effectiveVram = profile.appleSilicon ? profile.totalRamMb : vram;
    if (effectiveVram < pack.minVramMb * SELECTION_RAM_SLACK) return false;
  }
  // No slack for the driver gate: unlike the memory numbers, a version compare
  // has no under-reporting to forgive — either the driver ships the toolkit or
  // it does not.
  if (!nvidiaDriverSupportsPack(pack, profile)) return false;
  return true;
}

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
      // CUDA builds require an NVIDIA GPU; match the detected GPU name — but
      // only when we actually managed to look. A failed probe reported `gpus:
      // []`, indistinguishable from "no GPU", which HID both CUDA packs from
      // users who own an NVIDIA card: nvidia-smi off PATH, a dGPU asleep under
      // Optimus, or a cold card exceeding the 3s budget were all enough. Hiding
      // a pack on a measurement we failed to take is the one restriction we must
      // never impose; offering one pack too many costs an install that falls
      // back, and the runtime fallback already handles that.
      if (profile.gpuProbe === 'failed') return true;
      return profile.gpus.some((g) => NVIDIA_GPU_RE.test(g.name));
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
 * HARD gate: can this pack's binary even LOAD on this machine's accelerator? False
 * means it physically cannot — the accel targets a GPU vendor the machine doesn't
 * have (a CUDA pack with no NVIDIA GPU; a Metal pack off Apple Silicon) — so the
 * UI must not offer it. RAM/VRAM are deliberately NOT gated here: a memory-heavy
 * pack (e.g. the 27B model) still SHOWS, badged via {@link packFitsMachine} as
 * "may be slow / needs N GB", so the user can choose. (Gating RAM hard also
 * mis-hid packs on machines that nominally qualify — a "32 GB" box reports a bit
 * under 32768 MB.)
 */
export function packHardwareSupported(pack: EnginePackInfo, profile: SystemProfile): boolean {
  return accelSupported(pack.accel, profile);
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
  //
  // The GPU tiers are picked by VRAM, not by "is there a GPU". Treating that as
  // a boolean recommended the SAME 16.5 GB model to a 4 GB GTX 1650, a 12 GB
  // RTX 3060 and a 24 GB RTX 4090 — and made a machine WORSE OFF for having a
  // weak card, since a GPU-less box with the same RAM was offered the 2.5 GB 4B
  // instead. On the 1650 that mismatch is measured: 13.9 GB of a 14.6 GB model
  // sat in CPU_Mapped, so the GPU carried 11% of the work and the backend we
  // fought so hard to fix barely mattered.
  const ramGb = profile.totalRamMb / 1024;
  const gpuTiers = ['translategemma-27b', 'translategemma-12b', 'translategemma-4b'] as const;
  // Largest tier whose weights would be mostly GPU-resident, and whose RAM gate
  // this machine meets.
  //
  // The RAM side uses packFitsForSelection, NOT the `fitting` list: `fitting`
  // is packFitsMachine, which compares strictly, and os.totalmem() reports
  // physical RAM minus firmware reservations — a genuine 32 GB Windows box
  // reports ~31.8 GB. Every catalog gate is an exact power of two, so a strict
  // compare made the top tier unreachable on exactly the machines built for it:
  // a 24 GB RTX 4090 with "32 GB" of RAM was recommended the 12B because
  // 32563 < 32768. packFitsForSelection exists for precisely this ("picking a
  // smaller model than the user could run is a real cost") and is the right
  // abstraction here — this is a CHOICE between tiers, not a badge.
  const gpuPick = gpuTiers.find((id) => {
    const pack = findPack(id);
    return (
      pack &&
      packHardwareSupported(pack, profile) &&
      packFitsForSelection(pack, profile) &&
      gpuResidentFraction(pack.approxSizeMb, profile) >= MIN_GPU_RESIDENT_FRACTION
    );
  });
  const modelPackId = gpuPick ?? (ramGb >= 8 ? 'translategemma-4b' : undefined);
  const runtimePack = fitting.find((p) => p.providerId === 'local-llm');
  const modelPack = modelPackId ? findPack(modelPackId) : undefined;
  if (runtimePack && modelPack) {
    out.push({
      packId: runtimePack.id,
      reason: 'Runs TranslateGemma locally — a big translation-quality jump over the offline Argos default.',
    });
    // Say WHY in hardware terms. The old copy ("your GPU can drive the 12B")
    // was a claim the app never checked, and on a 4 GB card it was false.
    const budget = gpuWeightBudgetMb(profile);
    const pct = Math.round(gpuResidentFraction(modelPack.approxSizeMb, profile) * 100);
    const sizeGb = (modelPack.approxSizeMb / 1024).toFixed(1);
    const why =
      budget <= 0
        ? `The CPU-friendly 4B TranslateGemma (~${sizeGb} GB) — much better than Argos, light enough to run without a GPU.`
        : modelPack.id === 'translategemma-4b'
          ? `The 4B TranslateGemma (~${sizeGb} GB) runs ~${pct}% on your GPU. A larger model would spill into system RAM and translate at CPU speed, so this is the faster choice here — the 12B/27B stay installable if you want the quality instead.`
          : `The ${modelPack.id === 'translategemma-12b' ? '12B' : '27B'} TranslateGemma (~${sizeGb} GB) fits your GPU (~${pct}% resident) — the best quality this machine can run at GPU speed.`;
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
