/**
 * The presets every computer has (GET /presets/builtin): Highest quality,
 * Balanced and Lowest cost, worked out for THIS machine from what New project
 * recommends here. Pure.
 *
 * LOCAL ONLY, by the user's rule (2026-11-25): "Prioritize keeping local-only,
 * and use AI only when the user chooses to engage it." A built-in preset never
 * picks a cloud AI: the recommendation is made with the user's saved cloud
 * choices left out, every phase's engine is named (so a saved cloud default
 * cannot show through when a job is made from it), and a replaced choice is
 * said, with how to choose it in the form. "Cost" is therefore time and the
 * computer's work, never money.
 *
 * claude-dubber asked for them (2026-11-25) as starting points with their
 * trade-offs said; each line is an i18n key (the app's words) with its
 * English text (an agent's).
 */
import { BUILTIN_PRESET_PREFIX, type BuiltinPresetKind, type DubPreset, type PresetNote, type ProjectSettings, type ProviderDefaults } from '@videodubber/shared';

/** What the built-in presets are worked out from. */
export interface BuiltinPresetFacts {
  /** What New project recommends here with the saved cloud choices left out (local engines only). */
  local: ProjectSettings;
  /** The saved cloud choices left out: the phase, and the engine's name. */
  replacedCloud: { phase: 'stt' | 'translation' | 'tts'; name: string }[];
  /** The speaker detection engine is installed. */
  speakerDetection: boolean;
}

/** The settings a built-in preset sets: engines and how much work each step does, never subtitles, voices or looks. */
export const BUILTIN_PRESET_KEYS = [
  'processingMode',
  'sttProviderId',
  'sttModel',
  'translationProviderId',
  'refineProviderId',
  'ttsProviderId',
  'autoFitOverflow',
  'diarize',
  'renderQuality',
  'autoSelectedPhases',
] as const satisfies readonly (keyof ProjectSettings)[];

/** Whisper sizes a quality preset may raise to large-v3 (a language's own model, PhoWhisper say, is kept). */
const STANDARD_SIZES = new Set(['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3-turbo', 'turbo']);

/** The saved defaults without the cloud engines (they are left to the user to choose). */
export function localProviderDefaults(
  saved: ProviderDefaults | undefined,
  isLocal: (phase: 'stt' | 'translation' | 'tts', providerId: string) => boolean,
): ProviderDefaults {
  const out: ProviderDefaults = { ...(saved ?? {}) };
  if (out.sttProviderId && !isLocal('stt', out.sttProviderId)) delete out.sttProviderId;
  if (out.translationProviderId && !isLocal('translation', out.translationProviderId)) delete out.translationProviderId;
  if (out.ttsProviderId && !isLocal('tts', out.ttsProviderId)) delete out.ttsProviderId;
  return out;
}

const note = (key: string, text: string, params?: PresetNote['params']): PresetNote => ({
  key: `wizard.builtin.${key}`,
  text,
  ...(params ? { params } : {}),
});

const PHASE_WORD: Record<BuiltinPresetFacts['replacedCloud'][number]['phase'], string> = {
  stt: 'speech-to-text',
  translation: 'translation',
  tts: 'the voice',
};

/** The three built-in presets for these facts, best quality first. */
export function builtinPresets(facts: BuiltinPresetFacts, at: string): DubPreset[] {
  const { local } = facts;
  // The Gemma chat model can run here: the recommendation gives it the review
  // pass, or it translates itself (projectDefaults.ts).
  const chatModel = local.refineProviderId === 'llama-cpp-chat' || local.translationProviderId === 'llama-cpp-chat';
  const common: PresetNote[] = [
    note('local', 'Everything runs on this computer: no cloud AI is used, and nothing is sent anywhere.'),
    ...facts.replacedCloud.map((r) =>
      note(
        'kept-local',
        `Your Settings choose ${r.name} for ${PHASE_WORD[r.phase]}; built-in presets stay on this computer. Choose it in the form to use it.`,
        { name: r.name, phaseKey: `wizard.builtin.phase-${r.phase}` },
      ),
    ),
  ];

  const base = (over: Partial<ProjectSettings>): Partial<ProjectSettings> => {
    const s: Partial<ProjectSettings> = { processingMode: 'local', refineProviderId: 'none' };
    for (const key of BUILTIN_PRESET_KEYS) {
      if (local[key] !== undefined) (s as Record<string, unknown>)[key] = local[key];
    }
    return { ...s, ...over };
  };

  // --- Highest quality
  const quality: PresetNote[] = [];
  let qualityModel = local.sttModel;
  if (local.sttModel && STANDARD_SIZES.has(local.sttModel)) {
    qualityModel = 'large-v3';
    quality.push(
      note(
        'quality-stt',
        'The largest speech model (large-v3): the fewest recognition mistakes, the slowest, and a download of about 3 GB the first time.',
      ),
    );
  } else if (local.sttModel === 'large-v3') {
    quality.push(note('quality-stt-kept', 'The largest speech model (large-v3), as recommended for this computer.'));
  } else if (local.sttModel) {
    quality.push(note('quality-stt-special', `The speech model made for this language (${local.sttModel}) is kept.`, { model: local.sttModel }));
  }
  const reviews = chatModel && local.translationProviderId !== 'llama-cpp-chat';
  if (reviews) {
    quality.push(
      note(
        'quality-review',
        'The Gemma chat model on this computer re-reads the whole translation for names, forms of address and consistency: better lines, slower.',
      ),
    );
  } else if (!chatModel) {
    quality.push(
      note('quality-review-missing', 'Re-reading the translation needs the Gemma chat model (Settings → Engines): until it is installed, the translation is not re-read.'),
    );
  }
  if (chatModel) quality.push(note('quality-fit', 'Lines too long for their time are rewritten shorter on this computer before anything is sped up.'));
  quality.push(
    facts.speakerDetection
      ? note('quality-speakers', 'Speakers are detected: each character keeps a voice, and the translation uses the right forms of address.')
      : note('quality-speakers-missing', 'Detecting speakers needs its engine (Settings → Engines): until it is installed, everyone speaks with one voice.'),
  );
  quality.push(note('quality-render', 'Rendered at the highest picture quality: slower to render, bigger files.'));

  // --- Lowest cost: the least time and work for the computer
  const economy: PresetNote[] = [];
  let economyModel = local.sttModel;
  if (local.sttModel === 'large-v3') {
    economyModel = 'large-v3-turbo';
    economy.push(note('economy-stt', 'A faster speech model (large-v3-turbo) instead of large-v3: several times faster, a little less accurate.'));
  }
  const ratio = local.maxSpeedRatio ?? 1.6;
  economy.push(
    note(
      'economy-text',
      `The translation is not re-read and long lines are not rewritten: lines that do not fit are sped up instead (up to ${ratio}×).`,
      { ratio },
    ),
  );
  economy.push(note('economy-speakers', 'No speaker detection: every line is spoken with the project voice.'));
  economy.push(note('economy-render', 'A fast render: quicker, with a slightly lower picture quality.'));

  const preset = (kind: BuiltinPresetKind, name: string, settings: Partial<ProjectSettings>, tradeoffs: PresetNote[]): DubPreset => ({
    id: `${BUILTIN_PRESET_PREFIX}${kind}`,
    name,
    targetLanguage: local.targetLanguage,
    ...(local.sourceLanguage ? { sourceLanguage: local.sourceLanguage } : {}),
    settings,
    builtin: { kind, tradeoffs: [...tradeoffs, ...common] },
    createdAt: at,
    updatedAt: at,
  });
  return [
    preset(
      'quality',
      'Highest quality',
      base({
        ...(qualityModel ? { sttModel: qualityModel } : {}),
        ...(reviews ? { refineProviderId: 'llama-cpp-chat' } : {}),
        autoFitOverflow: true,
        diarize: true,
        renderQuality: 'quality',
      }),
      quality,
    ),
    preset('balanced', 'Balanced', base({}), [note('balanced', 'What New project picks for this computer: the best engines installed here, with their usual passes.')]),
    preset(
      'economy',
      'Lowest cost',
      base({ ...(economyModel ? { sttModel: economyModel } : {}), refineProviderId: 'none', autoFitOverflow: false, diarize: false, renderQuality: 'fast' }),
      economy,
    ),
  ];
}
