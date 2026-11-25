/**
 * Voices kept for one main character ("Only for one main character",
 * VoiceProfile.mainOnly). Pure.
 *
 * WHY (claude-dubber, 2026-11-25): the user's own clone ("Giọng của tôi")
 * should speak for the one main character cast_voices pairs it with, never for
 * a crowd of minor speakers, never as the voice of every speaker of a gender
 * who has none. Casting already keeps clones out of the shared pools unless
 * the user picks one; the flag makes that a rule a pick, a swap or a hand-set
 * default cannot break, with the reason said.
 */
import { AppErrorException, type ProjectSettings } from '@videodubber/shared';

/** Why these settings break a one-main-character voice, or undefined. `mainOnly`: id → name. */
export function mainOnlyProblem(
  next: Pick<ProjectSettings, 'speakerVoices' | 'defaultMaleVoiceId' | 'defaultFemaleVoiceId'>,
  changed: { speakerVoices: boolean; defaults: boolean },
  mainOnly: ReadonlyMap<string, string>,
): string | undefined {
  if (mainOnly.size === 0) return undefined;
  if (changed.defaults) {
    for (const [key, who] of [
      ['defaultMaleVoiceId', 'male'],
      ['defaultFemaleVoiceId', 'female'],
    ] as const) {
      const id = next[key];
      if (id && mainOnly.has(id)) {
        return `"${mainOnly.get(id)}" is kept for one main character, so it cannot be the voice of every ${who} speaker who has none of their own.`;
      }
    }
  }
  if (changed.speakerVoices) {
    const holders = new Map<string, string[]>();
    for (const v of next.speakerVoices ?? []) {
      if (!mainOnly.has(v.voiceId)) continue;
      holders.set(v.voiceId, [...(holders.get(v.voiceId) ?? []), v.speakerId]);
    }
    for (const [id, speakers] of holders) {
      if (speakers.length > 1) return `"${mainOnly.get(id)}" is kept for one main character, but ${speakers.length} speakers would speak with it (${speakers.join(', ')}).`;
    }
  }
  return undefined;
}

/** {@link mainOnlyProblem} as the error a settings change is refused with. */
export function assertMainOnly(...args: Parameters<typeof mainOnlyProblem>): void {
  const problem = mainOnlyProblem(...args);
  if (!problem) return;
  throw new AppErrorException('INVALID_EDIT', problem, {
    remediation:
      'Give the other speakers (or the default) another voice, or let cast_voices choose: it gives such a voice to one main character only. To share it after all, turn off "Only for one main character" for it in Voices → My voices.',
  });
}
