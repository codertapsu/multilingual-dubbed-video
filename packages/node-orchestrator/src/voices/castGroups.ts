/**
 * Who a cast gives voices to: CHARACTERS, not speaker ids. Speaker detection
 * splits one character into several ids, and each id alone ranks low: in
 * NGTYL, Linh Nhi is SPEAKER_15/16/19/27/45, 142 s together (claude-dubber,
 * 2026-11-27). The character sheet ties ids to names (cast[].speakerId, one
 * entry per id), so a character is ranked by its ids' talk time together and
 * given one voice.
 *
 * A narrator or a system voice (its role or name says so: "narrator", "giọng
 * hệ thống báo thưởng", "Hệ thống") is cast too, but never takes a lead voice
 * or one of the user's clones: MD001's system voice, and NGTYL's narrator
 * (SPEAKER_09/10, 227 s), outranked every woman. A lead who also narrates
 * ("nhân vật chính, … kiêm người dẫn truyện") stays a lead.
 */
import type { TranslationDocContext } from '@videodubber/shared';

import type { CastProposal } from './casting.js';

/** One character of a cast: its speaker ids, the most-heard first. */
export interface CastGroup {
  /** Its name in the character sheet; absent for an id the sheet names no character for. */
  name?: string;
  ids: string[];
  /** A narrator or a system voice. */
  voiceOver: boolean;
}

/** Words of a narrator's or a system voice's role, in the languages the sheets are written in. */
const VOICE_OVER_ROLE =
  /(^|[\s,;:(/–-])(narrator|voice-?over|system voice|người dẫn (truyện|chuyện)|thuyết minh|giọng (hệ thống|dẫn truyện|thuyết minh|kể chuyện)|旁白|系统)/i;
/** Names that are a narrator or a system voice on their own. */
const VOICE_OVER_NAME = /^(narrator|system|hệ thống|người dẫn (truyện|chuyện)|thuyết minh|旁白|系统)$/i;
/** A lead who also narrates stays a lead. */
const LEAD_ROLE = /(nhân vật chính|main character|protagonist|主角)/i;

/** Whether a character of the sheet is a narrator or a system voice. Pure. */
export function isVoiceOver(entry: { name: string; role?: string }): boolean {
  const role = entry.role ?? '';
  if (LEAD_ROLE.test(role)) return false;
  return VOICE_OVER_ROLE.test(role) || VOICE_OVER_NAME.test(entry.name.trim());
}

/**
 * The cast's characters: the ids the sheet gives one name (compared without
 * case) as one, every other id alone, each with its ids the most-heard first.
 * `minutes`: each detected id's talk time; ids the sheet names that were not
 * detected are left out, and an id is never in two characters (its first
 * entry wins). Pure.
 */
export function castGroups(sheet: Pick<TranslationDocContext, 'cast'> | undefined, minutes: ReadonlyMap<string, number>): CastGroup[] {
  const byName = new Map<string, CastGroup>();
  const taken = new Set<string>();
  for (const entry of sheet?.cast ?? []) {
    const id = entry.speakerId?.trim();
    const name = entry.name?.trim();
    if (!id || !name || !minutes.has(id) || taken.has(id)) continue;
    const key = name.toLowerCase();
    const group = byName.get(key) ?? { name, ids: [], voiceOver: false };
    group.ids.push(id);
    group.voiceOver = group.voiceOver || isVoiceOver(entry);
    byName.set(key, group);
    taken.add(id);
  }
  const groups = [...byName.values()];
  for (const id of minutes.keys()) if (!taken.has(id)) groups.push({ ids: [id], voiceOver: false });
  const heard = (id: string): number => minutes.get(id) ?? 0;
  for (const g of groups) g.ids.sort((a, b) => heard(b) - heard(a) || a.localeCompare(b));
  return groups;
}

/**
 * A character's gender from its ids' (the user's word or detection's):
 * the one heard longest among those known; undefined when none is. Pure.
 */
export function groupGender(
  ids: readonly string[],
  genderOf: (id: string) => 'male' | 'female' | 'unknown' | undefined,
  minutes: ReadonlyMap<string, number>,
): 'male' | 'female' | undefined {
  let male = 0;
  let female = 0;
  for (const id of ids) {
    const g = genderOf(id);
    if (g === 'male') male += minutes.get(id) ?? 0;
    else if (g === 'female') female += minutes.get(id) ?? 0;
  }
  if (male === 0 && female === 0) {
    // Known only for ids with no talk time measured: the first known one.
    const known = ids.map(genderOf).find((g) => g === 'male' || g === 'female');
    return known === 'male' || known === 'female' ? known : undefined;
  }
  return male >= female ? 'male' : 'female';
}

/**
 * A proposal made for each character's most-heard id (the cast route asks
 * proposeCast for characters), given to all its ids: their assignments, the
 * speakers left to the project voice, and the pools' speakers. Pure.
 */
export function expandCast(proposal: CastProposal, membersOf: ReadonlyMap<string, readonly string[]>): CastProposal {
  const all = (id: string): string[] => [...(membersOf.get(id) ?? [id])];
  const pools: CastProposal['pools'] = {};
  for (const gender of ['male', 'female'] as const) {
    const pool = proposal.pools[gender];
    if (pool) pools[gender] = { ...pool, voices: pool.voices.map((v) => ({ ...v, speakers: v.speakers.flatMap(all) })) };
  }
  return {
    ...proposal,
    assignments: proposal.assignments.flatMap((a) => all(a.speakerId).map((speakerId) => ({ ...a, speakerId }))),
    unassigned: proposal.unassigned.flatMap(all),
    pools,
  };
}

/** Each speaker id the character sheet names, to its character (the name without case; an id's first entry wins). Pure. */
export function characterOfIds(sheet: Pick<TranslationDocContext, 'cast'> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of sheet?.cast ?? []) {
    const id = entry.speakerId?.trim();
    const name = entry.name?.trim().toLowerCase();
    if (id && name && !out.has(id)) out.set(id, name);
  }
  return out;
}
