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
import type { ProjectSettings } from '@videodubber/shared';
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

/**
 * Classify a project's run from its SETTINGS (no I/O, no probing) — so the
 * decision is available the instant the user clicks Start.
 */
export function classifyWorkload(settings: ProjectSettings, registry: ProviderRegistry): RunWorkload {
  const providers: Traits[] = [
    registry.getStt(settings.sttProviderId),
    registry.getTranslation(settings.translationProviderId),
    registry.getTts(settings.ttsProviderId),
  ];
  // The refine step only runs when configured; an unset id must NOT resolve to
  // the default translation provider (registry.get* falls back), or every
  // project would inherit its cost.
  if (settings.refineProviderId && settings.refineProviderId !== 'none') {
    providers.push(registry.getTranslation(settings.refineProviderId));
  }

  let heavyFamily = providers.find((p) => isHeavyEngineFamily(p.requiresEnginePack))?.requiresEnginePack;
  // Two pipeline options pull in heavy engine packs without going through a
  // provider id: vocal separation and forced alignment/diarization.
  if (!heavyFamily && settings.originalAudioMode === 'replace-vocals') heavyFamily = 'audio-separator';
  if (!heavyFamily && (settings.forcedAlignment === true || settings.diarize === true)) heavyFamily = 'whisperx';

  const needsHeavyEngine = heavyFamily !== undefined;
  // Cloud-only means every phase provider is remote AND no local engine pack is
  // pulled in by the mix/alignment options.
  const cloudOnly = !needsHeavyEngine && providers.every((p) => p.isLocal === false);

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
