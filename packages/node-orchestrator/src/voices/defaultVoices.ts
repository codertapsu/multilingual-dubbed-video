/**
 * The user's DEFAULT VOICES (Preferences.defaultVoices, the Voices screen):
 * "The default male voice is Đăng Quân, the default female voice is Duyên Hà
 * My... please prioritize these two voices when dubbing videos" (2026-11-27).
 * A new project takes them for the men and women with no voice of their own
 * when its preset or job names none; a cast gives them first to the most-heard
 * man and woman (casting.ts `preferred`).
 */
import type { DefaultVoices, ProjectSettings, VoiceLibraryItem } from '@videodubber/shared';

type VoiceDefaults = Pick<ProjectSettings, 'defaultMaleVoiceId' | 'defaultFemaleVoiceId'>;

/**
 * The default voices a new project with `settings` takes: for each gender its
 * settings leave without one, the user's voice when the project can speak with
 * it (`usable`: its engine's, installed, in its language) and it is not kept
 * for one main character (that one is never a default: mainOnly.ts). Pure.
 */
export function defaultVoicesFor(
  wanted: DefaultVoices | undefined,
  settings: Partial<VoiceDefaults>,
  usable: readonly Pick<VoiceLibraryItem, 'id' | 'gender' | 'mainOnly'>[],
): VoiceDefaults {
  const ok = (id: string | undefined, gender: 'male' | 'female'): id is string =>
    id !== undefined && usable.some((v) => v.id === id && !v.mainOnly && (v.gender === undefined || v.gender === gender));
  return {
    ...(!settings.defaultMaleVoiceId && ok(wanted?.male, 'male') ? { defaultMaleVoiceId: wanted!.male! } : {}),
    ...(!settings.defaultFemaleVoiceId && ok(wanted?.female, 'female') ? { defaultFemaleVoiceId: wanted!.female! } : {}),
  };
}
