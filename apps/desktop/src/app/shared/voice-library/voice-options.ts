/**
 * The voice pickers (wizard, editor) for engines that live in the voice
 * library: their voices come from GET /voices, shaped like the older
 * per-engine lists the pickers already render.
 */
import { voiceEngineOfProvider } from '@videodubber/shared';
import type { VoiceEngineId, VoiceLibraryItem } from '../../core/models';
import type { PiperVoiceInfo } from '../../core/models/setup';
import { EMPTY_FILTER, filterVoices } from './voice-filter';

/**
 * Engines whose voices only the library lists (no /setup/voices catalog).
 * OpenAI was missing, so choosing OpenAI's voices showed no picker at all and
 * kept whatever voice the previous engine had chosen: a Vietnamese project
 * switched to OpenAI still named a VieNeu voice and stopped at Start.
 */
const LIBRARY_ONLY: ReadonlySet<VoiceEngineId> = new Set(['vieneu', 'zerotts', 'kokoro', 'supertonic', 'voxcpm', 'openai']);

/** The library engine a TTS provider speaks with, when its voices come from the library. */
export function libraryEngineFor(providerId: string | undefined): VoiceEngineId | null {
  const engine = voiceEngineOfProvider(providerId);
  return engine && LIBRARY_ONLY.has(engine) ? engine : null;
}

/** One picker option per voice of `engine` that speaks `language`, best first. */
export function voiceOptions(
  items: readonly VoiceLibraryItem[],
  engine: VoiceEngineId,
  language: string,
  describe: (item: VoiceLibraryItem) => string,
): PiperVoiceInfo[] {
  return filterVoices(items, { ...EMPTY_FILTER, engine, language: language.split(/[-_]/)[0] ?? '' }).map((v) => ({
    id: v.id,
    language: v.languages[0] ?? language,
    label: describe(v),
    approxSizeMb: v.sizeMb,
    url: '',
    configUrl: '',
    ...(v.recommended ? { recommended: true } : {}),
  }));
}

/**
 * The voice a picker keeps once its options change (another engine, another
 * language): the chosen one while it is still offered, else the recommended
 * one, else the first, else none. Never a voice the options do not list: that
 * is how a VieNeu v3 voice stayed chosen under VieNeu-TTS 3.8 and stopped the
 * dub at Start.
 */
export function keptVoice(current: string | undefined, offered: readonly Pick<PiperVoiceInfo, 'id' | 'recommended'>[]): string | undefined {
  if (current && offered.some((v) => v.id === current)) return current;
  return (offered.find((v) => v.recommended) ?? offered[0])?.id;
}
