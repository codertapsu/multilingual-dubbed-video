/**
 * Classify what a run will COST before starting it.
 *
 * Two facts decide admission:
 *  - does it need the exclusive heavy-engine lane (llama.cpp / whisper.cpp /
 *    LibreTranslate / separation / alignment)? Those engines unload each other,
 *    so at most one such run may execute at a time — a correctness rule, not a
 *    performance preference.
 *  - is it cloud-only? A run whose every phase is a cloud API is network-bound
 *    and barely touches this machine until the final render, so pricing it the
 *    same as a local run would make cloud users queue for resources they are
 *    not consuming.
 *
 * Heaviness is read from the SAME table the launcher uses
 * ({@link isHeavyEngineFamily} over ENGINE_LAUNCH_SPECS), via each provider's
 * `requiresEnginePack` family id — so the classification cannot drift from the
 * eviction behaviour it is protecting against.
 */
import { pipelineStepIndex, type PipelineStepId, type ProjectSettings } from '@videodubber/shared';
import { isHeavyEngineFamily } from '../engines/engineManager.js';
import { POINTS_PER_CLOUD_RUN, POINTS_PER_LOCAL_RUN } from '../system/capacity.js';
import type { ProviderRegistry } from '../providers/registry.js';

/** What a run will demand of this machine. */
export interface RunWorkload {
  /** Needs the single exclusive heavy-engine lane. */
  needsHeavyEngine: boolean;
  /** Every phase runs in the cloud (cheap locally until render). */
  cloudOnly: boolean;
  /** Admission cost in budget points. */
  points: number;
  /** Engine family that forces the heavy lane (for the UI's explanation). */
  heavyFamily?: string;
}

/** The provider traits the classifier reads (registry instances satisfy this). */
interface Traits {
  isLocal?: boolean;
  requiresEnginePack?: string;
}

/** Optional context that narrows the classification. */
export interface ClassifyOptions {
  /**
   * Retry origin. Steps BEFORE it are skipped by the runner, so their engines
   * are never started — a retry from `render` must not occupy the heavy lane
   * for a transcription engine it will never touch.
   */
  fromStep?: PipelineStepId;
  /** A separation engine is actually wired (else replace-vocals falls back to ducking). */
  separationAvailable?: boolean;
  /** An alignment engine is actually wired (else forced alignment is skipped). */
  alignmentAvailable?: boolean;
}

/** The pipeline step each heavy-capable phase runs in. */
const PHASE_STEP = {
  stt: 'stt',
  translation: 'translation',
  refine: 'refine',
  tts: 'tts',
  separation: 'audio-mix',
} as const satisfies Record<string, PipelineStepId>;

/**
 * Classify a project's run from its SETTINGS (no I/O, no probing) — so the
 * decision is available the instant the user clicks Start.
 */
export function classifyWorkload(
  settings: ProjectSettings,
  registry: ProviderRegistry,
  opts: ClassifyOptions = {},
): RunWorkload {
  // Which steps will actually execute on this run.
  const fromIndex = opts.fromStep ? pipelineStepIndex(opts.fromStep) : 0;
  const willRun = (step: PipelineStepId): boolean => pipelineStepIndex(step) >= fromIndex;

  const providers: Traits[] = [];
  if (willRun(PHASE_STEP.stt)) providers.push(registry.getStt(settings.sttProviderId));
  if (willRun(PHASE_STEP.translation)) providers.push(registry.getTranslation(settings.translationProviderId));
  if (willRun(PHASE_STEP.tts)) providers.push(registry.getTts(settings.ttsProviderId));
  // The refine step only runs when configured; an unset id must NOT resolve to
  // the default translation provider (registry.get* falls back), or every
  // project would inherit its cost.
  if (settings.refineProviderId && settings.refineProviderId !== 'none' && willRun(PHASE_STEP.refine)) {
    providers.push(registry.getTranslation(settings.refineProviderId));
  }

  let heavyFamily = providers.find((p) => isHeavyEngineFamily(p.requiresEnginePack))?.requiresEnginePack;
  // Two pipeline options pull in heavy engine packs without going through a
  // provider id: vocal separation (audio-mix) and forced alignment/diarization
  // (inside the STT step). Both degrade gracefully when their engine isn't
  // installed — the runner falls back to ducking / the original timestamps —
  // so they only claim the heavy lane when the engine is actually wired.
  if (
    !heavyFamily &&
    settings.originalAudioMode === 'replace-vocals' &&
    opts.separationAvailable !== false &&
    willRun(PHASE_STEP.separation)
  ) {
    heavyFamily = 'audio-separator';
  }
  if (
    !heavyFamily &&
    (settings.forcedAlignment === true || settings.diarize === true) &&
    opts.alignmentAvailable !== false &&
    willRun(PHASE_STEP.stt)
  ) {
    heavyFamily = 'whisperx';
  }

  const needsHeavyEngine = heavyFamily !== undefined;
  // Cloud-only means every phase that will run is remote AND no local engine
  // pack is pulled in by the mix/alignment options. A run with NO remaining
  // provider phases (e.g. retry-from-render) is local work (ffmpeg).
  const cloudOnly =
    !needsHeavyEngine && providers.length > 0 && providers.every((p) => p.isLocal === false);

  return {
    needsHeavyEngine,
    cloudOnly,
    points: cloudOnly ? POINTS_PER_CLOUD_RUN : POINTS_PER_LOCAL_RUN,
    ...(heavyFamily ? { heavyFamily } : {}),
  };
}

/** Friendly name for the engine family that forces the heavy lane. */
export function heavyFamilyLabel(family: string | undefined): string {
  switch (family) {
    case 'local-llm':
      return 'the local translation model (TranslateGemma / Gemma)';
    case 'whisper-cpp':
      return 'accelerated whisper.cpp transcription';
    case 'libretranslate':
      return 'the LibreTranslate server';
    case 'audio-separator':
      return 'vocal separation';
    case 'whisperx':
      return 'forced alignment / diarization';
    case 'omnivoice':
      return 'OmniVoice speech synthesis';
    default:
      return 'a downloadable local engine';
  }
}
