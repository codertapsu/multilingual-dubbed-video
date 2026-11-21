/**
 * What the New project form says about each engine that stops a dub at Start,
 * and the one button that fixes it there.
 *
 * Start used to put the orchestrator's first sentence, in English, into the
 * error banner ("ENGINE_UNAVAILABLE · TranslateGemma needs the llama.cpp
 * runtime engine pack.") and offered a button for an Ollama model only, though
 * the voice hints promise "you'll be prompted to install it when the dub
 * starts" (UX audit, 2026-11-21). Each problem now reads as a sentence in the
 * user's language with its fix beside it: Install for an engine pack, Add key
 * for a cloud service, Download for an Ollama model, Try again for something
 * still starting or downloading, and Change it for a choice only the form can
 * change. The orchestrator's own words stay available as the details.
 *
 * Pure (no Angular): start-problems.spec.ts checks the mapping and that every
 * key it can return exists in both locales.
 */
import type { RunPreflightProvider } from '../../core/models/setup';

/** Where "Change it" takes the user on step 1 (an element id there). */
export type ChangeTarget = 'provStt' | 'provTranslation' | 'provRefine' | 'provTts' | 'ttsVoice';

/** The fix offered beside a problem. */
export type StartFix =
  | { kind: 'install'; packId: string }
  | { kind: 'add-key'; service: string }
  | { kind: 'pull-ollama'; model: string }
  | { kind: 'retry' }
  | { kind: 'change'; target: ChangeTarget };

export interface StartProblem {
  /** Stable row id: phase and provider. */
  id: string;
  /** The phase's name (a translation key). */
  phaseKey: string;
  /** The sentence (a translation key) and its values. */
  key: string;
  params: Record<string, string>;
  fix: StartFix | null;
  /** What the orchestrator said (English), for the "Details" line. */
  detail: string;
}

/**
 * The phases' names. The orchestrator also checks a configured refine pass,
 * which the UI's phase type predates; a phase newer than this table gets the
 * generic name and no "Change it" (there is no field to take the user to).
 */
const PHASE_KEY: Readonly<Record<string, string>> = {
  stt: 'wizard.fix.phase.stt',
  translation: 'wizard.fix.phase.translation',
  refine: 'wizard.fix.phase.refine',
  tts: 'wizard.fix.phase.tts',
};
const OTHER_PHASE_KEY = 'wizard.fix.phase.other';

const ENGINE_FIELD: Readonly<Record<string, ChangeTarget>> = {
  stt: 'provStt',
  translation: 'provTranslation',
  refine: 'provRefine',
  tts: 'provTts',
};

/** Every phase name {@link describeStartProblem} can return (checked by the spec). */
export const START_PROBLEM_PHASE_KEYS: readonly string[] = [...Object.values(PHASE_KEY), OTHER_PHASE_KEY];

/** Every sentence key {@link describeStartProblem} can return (checked by the spec). */
export const START_PROBLEM_KEYS = [
  'wizard.fix.cloud-key',
  'wizard.fix.install',
  'wizard.fix.ollama-off',
  'wizard.fix.ollama-model',
  'wizard.fix.downloading',
  'wizard.fix.starting',
  'wizard.fix.model-choice',
  'wizard.fix.voice',
  'wizard.fix.unavailable',
] as const;

/**
 * One not-ready provider of a run preflight, as the form shows it. `name` is
 * the provider's display name (the id when the catalog does not know it), and
 * `packName` an engine pack's.
 */
export function describeStartProblem(
  problem: Omit<RunPreflightProvider, 'phase'> & { phase: string },
  name: string,
  packName: (packId: string) => string,
): StartProblem {
  const ref = problem.action?.ref;
  const kind = problem.action?.kind;
  const base = {
    id: `${problem.phase}:${problem.providerId}`,
    phaseKey: PHASE_KEY[problem.phase] ?? OTHER_PHASE_KEY,
    detail: [problem.message, problem.remediation].filter(Boolean).join(' '),
  };
  const field = ENGINE_FIELD[problem.phase];
  const change: StartFix | null = field ? { kind: 'change', target: field } : null;
  const say = (key: (typeof START_PROBLEM_KEYS)[number], fix: StartFix | null, extra: Record<string, string> = {}): StartProblem => ({
    ...base,
    key,
    params: { name, ...extra },
    fix,
  });

  switch (problem.status) {
    case 'cloud-key-missing':
      return say('wizard.fix.cloud-key', ref ? { kind: 'add-key', service: ref } : change);
    case 'engine-pack-missing':
      if (kind === 'install-pack' && ref) return say('wizard.fix.install', { kind: 'install', packId: ref }, { pack: packName(ref) });
      return say('wizard.fix.unavailable', change);
    case 'daemon-unreachable':
      return say('wizard.fix.ollama-off', change);
    case 'model-missing':
      if (kind === 'pull-ollama-model' && ref) return say('wizard.fix.ollama-model', { kind: 'pull-ollama', model: ref }, { model: ref });
      if (kind === 'install-pack' && ref) return say('wizard.fix.install', { kind: 'install', packId: ref }, { pack: packName(ref) });
      if (kind === 'guide' && ref === 'downloading-models') return say('wizard.fix.downloading', { kind: 'retry' });
      // whisper.cpp cannot use the project's speech model: no download fixes that.
      return say('wizard.fix.model-choice', change);
    case 'worker-loading':
      return say('wizard.fix.starting', { kind: 'retry' });
    case 'voice-mismatch':
      return say('wizard.fix.voice', { kind: 'change', target: 'ttsVoice' });
    default:
      if (kind === 'install-pack' && ref) return say('wizard.fix.install', { kind: 'install', packId: ref }, { pack: packName(ref) });
      if (kind === 'open-credentials' && ref) return say('wizard.fix.cloud-key', { kind: 'add-key', service: ref });
      return say('wizard.fix.unavailable', change);
  }
}

/** An engine pack's download size for a button ("135 MB", "1.6 GB"); '' when unknown. */
export function packSizeLabel(mb: number | undefined): string {
  if (!mb || !Number.isFinite(mb) || mb <= 0) return '';
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
