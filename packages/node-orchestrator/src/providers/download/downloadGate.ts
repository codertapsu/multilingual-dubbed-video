/**
 * Whether downloads may run while dubs do, and how many (the user's rule,
 * 2026-11-21, refined with the 10-hour production run's numbers):
 *
 * - A powerful machine downloads alongside dubbing, dubbing first: downloads
 *   pause while a dub is in a heavy step (a GPU engine, or a step that writes
 *   gigabytes: extract-audio, audio-mix, render), while the editor or a voice
 *   preview holds the GPU, and while the app is short of memory or
 *   responsiveness. "Powerful" is a graphics card with 12 GB or more (8 GB
 *   held the GPU lane 95 % of step time and swapped engines 45 times in ten
 *   parts) or an Apple Silicon Mac with 32 GB, and room for two dubs.
 * - Any other machine does one thing at a time: no download while a dub runs,
 *   and one download at a time otherwise.
 *
 * A paused download keeps its bytes and resumes with Range, after asking the
 * site for fresh links (they are signed and expire). Pure.
 */
import type { DownloadsWhileDubbing, PipelineStepId, SystemProfile } from '@videodubber/shared';

/** Steps that write or read gigabytes: a download competing with them slows the dub. */
export const DISK_HEAVY_STEPS: ReadonlySet<PipelineStepId> = new Set(['extract-audio', 'audio-mix', 'render']);

/** A graphics card this big (or an Apple Silicon Mac with this much memory) counts as powerful. */
export const POWERFUL_VRAM_MB = 12 * 1024;
export const POWERFUL_UNIFIED_MB = 32 * 1024;

/** Whether this machine downloads alongside dubbing (`auto`). */
export function powerfulForParallel(profile: Pick<SystemProfile, 'gpus' | 'appleSilicon' | 'totalRamMb'>, maxProjects: number): boolean {
  const bigCard = (profile.gpus ?? []).some((g) => (g.vramMb ?? 0) >= POWERFUL_VRAM_MB);
  const bigMac = profile.appleSilicon && profile.totalRamMb >= POWERFUL_UNIFIED_MB;
  return (bigCard || bigMac) && maxProjects >= 2;
}

export type DownloadPolicy = Exclude<DownloadsWhileDubbing, 'auto'>;

/** The policy in force: the user's choice, or `auto` decided by the hardware. */
export function effectiveDownloadPolicy(choice: DownloadsWhileDubbing | undefined, powerful: boolean): DownloadPolicy {
  if (!choice || choice === 'auto') return powerful ? 'pause-heavy' : 'one-task';
  return choice;
}

export interface DownloadGateInput {
  policy: DownloadPolicy;
  /** Running dubs: the step each is in, and whether that step uses a heavy engine for it. */
  runs: readonly { projectId: string; step: PipelineStepId; heavy: boolean }[];
  /** The heavy lane is held outside a run (an editor action, a voice preview). */
  externalHeavy: boolean;
  /** The app is short of memory or responsiveness right now. */
  pressure: boolean;
  /** Downloads at once when nothing holds them back. */
  concurrency: number;
}

export interface DownloadGate {
  /** How many downloads may run now (0: hold them all). */
  limit: number;
  /** Why they are held, when they are. */
  reason?: 'gpu-heavy' | 'dubbing' | 'pressure';
}

export function downloadGate(input: DownloadGateInput): DownloadGate {
  if (input.policy === 'no-limit') return { limit: input.concurrency };
  if (input.policy === 'one-task') {
    return input.runs.length > 0 || input.externalHeavy ? { limit: 0, reason: 'dubbing' } : { limit: 1 };
  }
  if (input.externalHeavy || input.runs.some((r) => r.heavy || DISK_HEAVY_STEPS.has(r.step))) {
    return { limit: 0, reason: 'gpu-heavy' };
  }
  if (input.pressure) return { limit: 0, reason: 'pressure' };
  return { limit: input.concurrency };
}
