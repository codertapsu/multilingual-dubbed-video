/**
 * Casting: which voice speaks for each detected speaker (cast_voices).
 *
 * The rule the user gave the production agent: their own cloned voices first,
 * then the built-in ones, matched by gender. Measured on their real clones
 * (claude-dubber, 2026-11-21), two things shaped it:
 *  - a profile's gender is never taken from pitch (a male clone at 194 Hz sits
 *    above a female one at 174 Hz): profiles whose gender the user has not
 *    confirmed are not cast, and the caller is told which ones;
 *  - pairing speakers to voices by voice print gave noise for the men (the
 *    best pairing 0.73 against 0.65 ± 0.03 over all pairings) and a real signal
 *    for the women (1.01 against 0.78 ± 0.11): prints from a Chinese video
 *    with music against clean Vietnamese clones. So voices are paired by pitch
 *    rank (the higher-pitched speaker gets the higher-pitched voice; sorted
 *    matching minimises the total pitch distance), and by print only when the
 *    best pairing beats the mean of all pairings by two standard deviations.
 * Speakers past the voices of their gender share that gender's default voice;
 * a speaker of unknown gender keeps the project voice. Pure.
 */

export type CastGender = 'female' | 'male';

export interface CastSpeaker {
  speakerId: string;
  /** Talk time: the most-heard speakers get the distinct voices. */
  minutes: number;
  gender?: CastGender | 'unknown';
  f0Hz?: number;
  print?: readonly number[];
}

export interface CastVoice {
  voiceId: string;
  name: string;
  kind: 'profile' | 'preset';
  /** For a profile: only a confirmed gender casts. */
  gender?: CastGender;
  genderConfirmed?: boolean;
  f0Hz?: number;
  print?: readonly number[];
}

export interface CastAssignment {
  speakerId: string;
  voiceId: string;
  voiceName: string;
  /** How it was chosen. */
  by: 'pitch-rank' | 'print' | 'order' | 'default';
}

export interface CastProposal {
  assignments: CastAssignment[];
  /** The voice each gender's remaining speakers share. */
  defaults: Partial<Record<CastGender, string>>;
  /** Speakers left to the project voice (gender unknown). */
  unassigned: string[];
  /** Profiles not cast because their gender is not confirmed. */
  unconfirmed: { voiceId: string; name: string }[];
  notes: string[];
}

/** Cosine similarity of two prints (0 when either is missing or empty). Pure. */
export function cosine(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** All orderings of 0..n-1 (n <= 7), or undefined when there are too many to try. */
function permutations(n: number): number[][] | undefined {
  if (n > 7) return undefined;
  const out: number[][] = [];
  const walk = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) out.push(prefix);
    for (const [i, r] of rest.entries()) walk([...prefix, r], [...rest.slice(0, i), ...rest.slice(i + 1)]);
  };
  walk([], Array.from({ length: n }, (_, i) => i));
  return out;
}

/** Pair speakers to voices of one gender (both lists the same length). */
function pair(speakers: readonly CastSpeaker[], voices: readonly CastVoice[], notes: string[], gender: CastGender): CastAssignment[] {
  const k = speakers.length;
  // By print, when it is clearly better than chance (two standard deviations).
  const perms = permutations(k);
  if (perms && k >= 2 && speakers.every((s) => s.print?.length) && voices.every((v) => v.print?.length)) {
    const sim = speakers.map((s) => voices.map((v) => cosine(s.print, v.print)));
    const totals = perms.map((p) => p.reduce((t, vi, si) => t + sim[si]![vi]!, 0));
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    const std = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length);
    const bestAt = totals.indexOf(Math.max(...totals));
    if (std > 0 && totals[bestAt]! >= mean + 2 * std) {
      notes.push(`${gender}: paired by voice print (best ${totals[bestAt]!.toFixed(2)} against ${mean.toFixed(2)} ± ${std.toFixed(2)}).`);
      return perms[bestAt]!.map((vi, si) => ({ speakerId: speakers[si]!.speakerId, voiceId: voices[vi]!.voiceId, voiceName: voices[vi]!.name, by: 'print' as const }));
    }
  }
  // By pitch rank, when every one of them has a pitch.
  if (speakers.every((s) => s.f0Hz) && voices.every((v) => v.f0Hz)) {
    const s = [...speakers].sort((a, b) => a.f0Hz! - b.f0Hz!);
    const v = [...voices].sort((a, b) => a.f0Hz! - b.f0Hz!);
    return s.map((sp, i) => ({ speakerId: sp.speakerId, voiceId: v[i]!.voiceId, voiceName: v[i]!.name, by: 'pitch-rank' as const }));
  }
  notes.push(`${gender}: no pitch measured for every speaker and voice, so the most-heard speakers got the voices in list order.`);
  return speakers.map((sp, i) => ({ speakerId: sp.speakerId, voiceId: voices[i]!.voiceId, voiceName: voices[i]!.name, by: 'order' as const }));
}

/**
 * The proposed cast: per gender, the most-heard speakers get the distinct
 * voices (profiles first, then presets), the rest share the first voice of
 * their gender. Pure; `apply` is the caller's.
 */
export function proposeCast(speakers: readonly CastSpeaker[], voices: readonly CastVoice[]): CastProposal {
  const notes: string[] = [];
  const unconfirmed = voices.filter((v) => v.kind === 'profile' && !v.genderConfirmed).map((v) => ({ voiceId: v.voiceId, name: v.name }));
  const usable = voices.filter((v) => v.gender && (v.kind === 'preset' || v.genderConfirmed));
  const ordered = [...usable].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'profile' ? -1 : 1));
  const assignments: CastAssignment[] = [];
  const defaults: Partial<Record<CastGender, string>> = {};
  for (const gender of ['male', 'female'] as const) {
    const mine = speakers.filter((s) => s.gender === gender).sort((a, b) => b.minutes - a.minutes);
    const pool = ordered.filter((v) => v.gender === gender);
    if (mine.length === 0) continue;
    if (pool.length === 0) {
      notes.push(`No ${gender} voice to cast: ${mine.length} ${gender} speaker(s) keep the project voice.`);
      continue;
    }
    // In tiers: the most-heard speakers get the user's clones, the next ones
    // the built-in voices; each tier paired by print or pitch rank.
    let next = 0;
    for (const tier of [pool.filter((v) => v.kind === 'profile'), pool.filter((v) => v.kind === 'preset')]) {
      const k = Math.min(tier.length, mine.length - next);
      if (k <= 0) continue;
      assignments.push(...pair(mine.slice(next, next + k), tier.slice(0, k), notes, gender));
      next += k;
    }
    defaults[gender] = pool[0]!.voiceId;
    for (const s of mine.slice(next)) {
      assignments.push({ speakerId: s.speakerId, voiceId: pool[0]!.voiceId, voiceName: pool[0]!.name, by: 'default' });
    }
  }
  const unassigned = speakers.filter((s) => s.gender !== 'male' && s.gender !== 'female').map((s) => s.speakerId);
  if (unassigned.length > 0) notes.push(`${unassigned.length} speaker(s) of unknown gender keep the project voice (set them in the editor).`);
  return { assignments, defaults, unassigned, unconfirmed, notes };
}

/**
 * A cloned voice's likely gender, from its print against built-in voices
 * whose gender is known: the mean of the best two similarities per gender.
 * Undefined when either gender has no reference or the two are too close to
 * call. Only a suggestion: the user confirms it (pitch alone misleads). Pure.
 */
export function suggestGender(
  print: readonly number[],
  refs: readonly { gender: CastGender; print: readonly number[] }[],
): { gender: CastGender; confidence: number } | undefined {
  const score = (g: CastGender): number | undefined => {
    const sims = refs
      .filter((r) => r.gender === g && r.print.length === print.length)
      .map((r) => cosine(print, r.print))
      .sort((a, b) => b - a)
      .slice(0, 2);
    return sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : undefined;
  };
  const m = score('male');
  const f = score('female');
  if (m === undefined || f === undefined) return undefined;
  const margin = Math.abs(m - f);
  if (margin < 0.03) return undefined;
  return { gender: f > m ? 'female' : 'male', confidence: Math.min(1, margin * 5) };
}
