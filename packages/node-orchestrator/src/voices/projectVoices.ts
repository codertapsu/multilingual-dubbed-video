/**
 * Does every voice a project names belong to the engine that will speak it?
 *
 * A project stores voice ids only (the project voice, and one per speaker), and
 * one TTS provider speaks the whole project. Engines are strict about voices
 * (an id they lack is an error, never the default voice: the voice must not
 * change under a project), so a mismatch would stop the run at the TTS step,
 * possibly 20 minutes in. The run gate asks here first and stops at Start,
 * naming the voice, its engine and what to do.
 *
 * Pure: settings in, problems out.
 */
import {
  isVoiceProfileId,
  voiceEngineOfId,
  voiceEngineOfProvider,
  type ProjectSettings,
  type VoiceEngineId,
} from '@videodubber/shared';
import { findCatalogVoice } from './voiceCatalog.js';

/** Engines whose every voice is in the catalog (Piper also loads local .onnx files). */
const CLOSED_CATALOG: ReadonlySet<VoiceEngineId> = new Set(['vieneu', 'vieneu-classic', 'zerotts', 'kokoro', 'supertonic']);

export interface ProjectVoiceProblem {
  voiceId: string;
  /** Where the project names it. */
  where: 'project' | 'speaker';
  speakerId?: string;
  /** The voice belongs to another engine than the project's TTS provider. */
  kind: 'other-engine' | 'unknown';
  /** The engine the voice belongs to (other-engine). */
  voiceEngine?: VoiceEngineId;
  /** The suggested stand-in, when an engine update removed the voice. */
  replacement?: string;
}

/** The voice ids a project's settings name, with where. */
export function projectVoiceRefs(
  settings: Pick<ProjectSettings, 'ttsVoiceId' | 'speakerVoices'>,
): { voiceId: string; where: 'project' | 'speaker'; speakerId?: string }[] {
  const out: { voiceId: string; where: 'project' | 'speaker'; speakerId?: string }[] = [];
  if (settings.ttsVoiceId) out.push({ voiceId: settings.ttsVoiceId, where: 'project' });
  for (const s of settings.speakerVoices ?? []) {
    if (s.voiceId) out.push({ voiceId: s.voiceId, where: 'speaker', speakerId: s.speakerId });
  }
  return out;
}

/** Engine names for messages. */
export const VOICE_ENGINE_LABEL: Readonly<Record<VoiceEngineId, string>> = {
  piper: 'Piper',
  'vieneu-classic': 'VieNeu v3 (the ten earlier voices)',
  vieneu: 'VieNeu-TTS 3.8',
  zerotts: 'ZeroTTS',
  kokoro: 'Kokoro',
  supertonic: 'Supertonic 3',
  voxcpm: 'VoxCPM2',
  openai: 'OpenAI',
};

/** One sentence per problem, and what to do, for the run gate. */
export function describeVoiceProblem(p: ProjectVoiceProblem, providerEngine: VoiceEngineId): { message: string; remediation: string } {
  const owner = p.where === 'speaker' ? ` (speaker ${p.speakerId})` : '';
  const engine = VOICE_ENGINE_LABEL[providerEngine];
  if (p.kind === 'other-engine' && p.voiceEngine) {
    const theirs = VOICE_ENGINE_LABEL[p.voiceEngine];
    return {
      message: `The voice "${p.voiceId}"${owner} belongs to ${theirs}, but this project's voice engine is ${engine}.`,
      remediation: `Pick a ${engine} voice in the project's voice settings, or switch the project's voice engine to ${theirs}. Voices never change by themselves.`,
    };
  }
  return {
    message: `${engine} has no voice "${p.voiceId}"${owner}.`,
    remediation: p.replacement
      ? `A newer ${engine} removed it; "${p.replacement}" is its suggested replacement. Pick a voice in the project's voice settings.`
      : `Pick one of ${engine}'s voices in the project's voice settings (Voices screen lists them).`,
  };
}

export function checkProjectVoices(
  settings: Pick<ProjectSettings, 'ttsProviderId' | 'ttsVoiceId' | 'speakerVoices'>,
): ProjectVoiceProblem[] {
  // No provider set = the built-in local voice (Piper).
  const providerEngine = voiceEngineOfProvider(settings.ttsProviderId ?? 'piper-local');
  // Providers outside the voice library (OmniVoice, a custom endpoint) keep
  // their own voice rules.
  if (!providerEngine) return [];
  const problems: ProjectVoiceProblem[] = [];
  for (const ref of projectVoiceRefs(settings)) {
    // Cloned voices carry their engine in the profile (checked when enrolling).
    if (isVoiceProfileId(ref.voiceId)) continue;
    // The local worker's own forms ("system:Alex", "fallback") are not catalog ids.
    if (providerEngine === 'piper' && (ref.voiceId.includes(':') || ref.voiceId === 'fallback')) continue;
    const voiceEngine = voiceEngineOfId(ref.voiceId);
    if (voiceEngine && voiceEngine !== providerEngine) {
      problems.push({ ...ref, kind: 'other-engine', voiceEngine });
      continue;
    }
    if (CLOSED_CATALOG.has(providerEngine)) {
      const entry = findCatalogVoice(ref.voiceId);
      if (!entry) problems.push({ ...ref, kind: 'unknown' });
      else if (entry.replacedBy) problems.push({ ...ref, kind: 'unknown', replacement: entry.replacedBy });
    }
  }
  return problems;
}
