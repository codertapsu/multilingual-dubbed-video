/**
 * Settings for a NEW project, decided in one place for every caller: the new-
 * project wizard, Settings → "Apply recommended", and the MCP server Claude
 * uses. (They used to live in the wizard alone, which is how the hardware audit
 * of 2026-11-17 found that new projects never used the GPU engines the user
 * had installed: the wizard always started from faster-whisper on the CPU,
 * Argos and Piper, and only a saved preference could change that. A 31-minute
 * dub on an RTX 3050 transcribed in 235 s on the CPU next to an installed
 * whisper.cpp that does it in 67 s.)
 *
 * Rule per phase: the user's saved choice wins while it is usable; otherwise
 * the best INSTALLED engine for this machine; otherwise the built-in default.
 * Recommending is all this does: every engine stays selectable, and nothing is
 * downloaded here (ensure-resources and the run gate do that, with the user
 * watching).
 */
import type { ProjectSettings, ProviderDefaults } from '@videodubber/shared';
import { whisperCppModelPackFor } from './engines/packSelection.js';

export type Phase = 'stt' | 'translation' | 'tts';

export interface ProjectDefaultsDeps {
  /** Settings → Processing defaults. */
  providerDefaults(): Promise<ProviderDefaults | undefined>;
  /**
   * Could this provider run a new project now? Engine pack installed and
   * runnable, cloud key present, daemon up… (the readiness contract, generic
   * form). A local worker that is still booting counts as usable.
   */
  usable(phase: Phase | 'refine', providerId: string): Promise<boolean>;
  /** The speech model the hardware recommendation picks (systemProfile.recommendSetup). */
  recommendedSttModel(): Promise<string | undefined>;
}

export interface ProjectDefaults {
  settings: ProjectSettings;
  /** One line per phase the app chose, for the user (and Claude) to see why. */
  notes: string[];
}

/** Translators that see one line at a time: a context-aware review pass helps them. */
const CONTEXT_FREE_TRANSLATORS = new Set(['argos', 'libretranslate', 'llama-cpp', 'ollama']);

/** The defaults every new project starts from (formerly the wizard's defaultSettings()). */
export function baseProjectSettings(sourceLanguage: string, targetLanguage: string): ProjectSettings {
  return {
    sourceLanguage,
    targetLanguage,
    subtitleExportMode: 'srt-file',
    processingMode: 'local',
    sttProviderId: 'faster-whisper',
    translationProviderId: 'argos',
    ttsProviderId: 'piper-local',
    sttModel: 'small',
    includeOriginalBackgroundAudio: true,
    duckOriginalAudio: true,
    duckingLevelDb: -12,
    originalAudioMode: 'keep',
    // The hardware encoder when one works here, else x264 (media-worker
    // encoder.ts). Measured on a 120 s burned-in render: NVENC VMAF 97.1 at
    // 4.1 s against x264's 96.4 at 19.4 s.
    renderQuality: 'auto',
    timeStretchEngine: 'auto',
    ttsGainDb: 0,
    // Translations (esp. EN->VI) are usually longer than the source. Combined
    // with gap-aware alignment these tolerances keep most segments fitting.
    maxSpeedRatio: 1.6,
    allowedOverflowMs: 1500,
    autoFitOverflow: true,
  };
}

export async function recommendProjectSettings(
  deps: ProjectDefaultsDeps,
  input: { sourceLanguage?: string; targetLanguage: string },
): Promise<ProjectDefaults> {
  const settings = baseProjectSettings(input.sourceLanguage ?? '', input.targetLanguage);
  const saved = (await deps.providerDefaults()) ?? {};
  const notes: string[] = [];
  const autoPicked: Phase[] = [];

  settings.sttModel = saved.sttModel ?? (await deps.recommendedSttModel()) ?? settings.sttModel;

  // --- speech-to-text
  if (saved.sttProviderId && (await deps.usable('stt', saved.sttProviderId))) {
    settings.sttProviderId = saved.sttProviderId;
  } else if (whisperCppModelPackFor(settings.sttModel ?? '') && (await deps.usable('stt', 'whisper-cpp'))) {
    // whisper.cpp only runs the standard Whisper sizes; a PhoWhisper/distil
    // choice keeps faster-whisper rather than silently swapping the model.
    settings.sttProviderId = 'whisper-cpp';
    autoPicked.push('stt');
    notes.push(`Speech-to-text: whisper.cpp on the graphics card (installed), model ${settings.sttModel}.`);
  }

  // --- translation (+ a context-aware review when the translator has none)
  if (saved.translationProviderId && (await deps.usable('translation', saved.translationProviderId))) {
    settings.translationProviderId = saved.translationProviderId;
  } else {
    const [gemma, chat] = await Promise.all([deps.usable('translation', 'llama-cpp'), deps.usable('translation', 'llama-cpp-chat')]);
    if (gemma) {
      settings.translationProviderId = 'llama-cpp';
      autoPicked.push('translation');
      notes.push('Translation: TranslateGemma on this computer (installed).');
    } else if (chat) {
      settings.translationProviderId = 'llama-cpp-chat';
      autoPicked.push('translation');
      notes.push('Translation: the context-aware Gemma chat model on this computer (installed).');
    }
  }
  if (CONTEXT_FREE_TRANSLATORS.has(settings.translationProviderId) && (await deps.usable('refine', 'llama-cpp-chat'))) {
    // The translation audit: TranslateGemma alone left ~4 of 20 sampled lines
    // acceptable; with the Gemma review pass ~15 of 20.
    settings.refineProviderId = 'llama-cpp-chat';
    notes.push('Review: the Gemma chat model re-reads the whole translation for names, pronouns and consistency.');
  }

  // --- voice
  if (saved.ttsProviderId && (await deps.usable('tts', saved.ttsProviderId))) {
    settings.ttsProviderId = saved.ttsProviderId;
  } else if (baseLanguage(input.targetLanguage) === 'vi' && (await deps.usable('tts', 'neural-tts'))) {
    settings.ttsProviderId = 'neural-tts';
    autoPicked.push('tts');
    notes.push('Voice: VieNeu natural Vietnamese voices (installed).');
  }

  if (autoPicked.length > 0) settings.autoSelectedPhases = autoPicked;
  return { settings, notes };
}

function baseLanguage(code: string): string {
  return code.split('-')[0]!.toLowerCase();
}
