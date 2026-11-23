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
 *
 * The crowd (claude-dubber report, 2026-11-23, F4): the speakers past the
 * distinct voices used to share ONE default voice, the first of their gender,
 * which was always the user's first clone and also a main character's voice:
 * 59 minor men of the 27.8-hour series spoke with the user's own voice. Now
 * the minor speakers of a gender share a POOL of clamp(ceil(minor / 10), 3, 6)
 * voices (settings.minorVoices overrides it), taken from the built-in voices
 * no main speaker has, never a clone unless the user picks one; when the
 * spare built-ins run out, the voices of the least-heard cast speakers are
 * shared too. The rotation is dialogue-aware: speakers who answer each other
 * get different pool voices where the pool allows. Built-ins that sound like
 * one of the user's clones are left out of shared use (and named), and voice
 * a main speaker only when that gives every speaker a voice of their own
 * (otherwise two main characters would sound alike). A speaker of unknown
 * gender keeps the project voice. Pure.
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
  /** How it was chosen: `pool` is a minor speaker on one of the shared voices. */
  by: 'pitch-rank' | 'print' | 'order' | 'default' | 'pool';
}

/** One voice the minor speakers of a gender share. */
export interface CastPoolVoice {
  voiceId: string;
  name: string;
  /**
   * `spare`: a built-in no main speaker has; `reused`: also the voice of a
   * main speaker (one of the least heard); `picked`: the user chose it.
   */
  from: 'spare' | 'reused' | 'picked';
  /** The main speaker whose voice it also is. */
  sharedWith?: string;
  /** The minor speakers on it, and their talk time together. */
  speakers: string[];
  minutes: number;
}

/** The voices the minor speakers of one gender share. */
export interface CastPool {
  /** Speakers past the distinct voices. */
  minorSpeakers: number;
  /** Voices wanted for them: settings.minorVoices, or clamp(ceil(minor / 10), 3, 6). */
  size: number;
  voices: CastPoolVoice[];
}

/** A built-in voice left out of shared use: it sounds like one of the user's clones. */
export interface CastSoundalike {
  voiceId: string;
  name: string;
  cloneId: string;
  cloneName: string;
  /** Cosine of the two voice prints. */
  similarity: number;
}

export interface CastProposal {
  assignments: CastAssignment[];
  /**
   * The voice of a speaker of each gender who has none of their own (one
   * detected later): the first voice of the minor pool, never a clone unless
   * the user picked it.
   */
  defaults: Partial<Record<CastGender, string>>;
  /** Speakers left to the project voice (gender unknown). */
  unassigned: string[];
  /** Profiles not cast because their gender is not confirmed. */
  unconfirmed: { voiceId: string; name: string }[];
  notes: string[];
  /** Per gender, the voices its minor speakers share. */
  pools: Partial<Record<CastGender, CastPool>>;
  /** Built-in voices kept out of shared use. */
  soundalikes: CastSoundalike[];
}

/** How often two speakers' turns follow each other (dialogueAdjacency). */
export type DialogueAdjacency = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface CastOptions {
  /** settings.minorVoices: voices per gender for the minor speakers. */
  minorVoices?: number;
  /** Who answers whom: minor speakers with adjacent turns get different pool voices. */
  adjacency?: DialogueAdjacency;
  /** The pool the user picked per gender (voice ids; clones allowed): replaces the automatic one. */
  minorPool?: Partial<Record<CastGender, readonly string[]>>;
  /** Override of {@link SOUNDALIKE_COSINE} (tests). */
  soundalikeCosine?: number;
}

/**
 * Prints closer than this are the same voice to a listener. Measured on the
 * user's 11 clones and the 25 VieNeu built-ins (512-dim prints of the speaker
 * detection model, 2026-11-23): two different built-in voices of a gender come
 * to 0.42 ± 0.11, at most 0.68 (91 male and 55 female pairs); a clone against
 * a built-in it was not made from at most 0.63; the clones made from a
 * built-in voice against that voice 0.82 to 0.85 ("Thiện Minh" 0.84, "Adam
 * Tốp Tốp"/adam-bua 0.84, two clones near truc-ly 0.82 and 0.85). 0.75 sits in
 * the middle of that gap.
 */
export const SOUNDALIKE_COSINE = 0.75;

/** Most voices a minor pool may have (the setting's ceiling). */
export const MAX_MINOR_VOICES = 12;

/** Two turns this close are an exchange (one speaker answers the other). */
export const DIALOGUE_GAP_MS = 5000;

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

/**
 * Voices for the minor speakers of a gender: the setting when it is a number
 * of voices (1..12), else clamp(ceil(minor / 10), 3, 6): 59 minor men get 6,
 * about 10 each. Three was too few (~20 speakers per voice on the series). Pure.
 */
export function minorPoolSize(minorSpeakers: number, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 1) {
    return Math.min(MAX_MINOR_VOICES, Math.round(override));
  }
  return Math.min(6, Math.max(3, Math.ceil(Math.max(0, minorSpeakers) / 10)));
}

/**
 * How often each pair of speakers takes turns: consecutive lines of two
 * different speakers less than `maxGapMs` apart (lines with no speaker are
 * skipped over). Symmetric. Pure.
 */
export function dialogueAdjacency(
  lines: readonly { speakerId?: string; startMs: number; endMs: number }[],
  maxGapMs = DIALOGUE_GAP_MS,
): Map<string, Map<string, number>> {
  const sorted = lines.filter((l) => l.speakerId).sort((a, b) => a.startMs - b.startMs);
  const out = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string): void => {
    const row = out.get(a) ?? new Map<string, number>();
    row.set(b, (row.get(b) ?? 0) + 1);
    out.set(a, row);
  };
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.speakerId === cur.speakerId || cur.startMs - prev.endMs > maxGapMs) continue;
    bump(prev.speakerId!, cur.speakerId!);
    bump(cur.speakerId!, prev.speakerId!);
  }
  return out;
}

/** Built-in voices whose print is within `threshold` of a clone's (the closest clone named). Pure. */
export function findSoundalikes(voices: readonly CastVoice[], threshold = SOUNDALIKE_COSINE): CastSoundalike[] {
  const clones = voices.filter((v) => v.kind === 'profile' && v.print?.length);
  const out: CastSoundalike[] = [];
  for (const v of voices) {
    if (v.kind !== 'preset' || !v.print?.length) continue;
    let best: { clone: CastVoice; sim: number } | undefined;
    for (const c of clones) {
      const sim = cosine(v.print, c.print);
      if (sim >= threshold && (!best || sim > best.sim)) best = { clone: c, sim };
    }
    if (best) {
      out.push({ voiceId: v.voiceId, name: v.name, cloneId: best.clone.voiceId, cloneName: best.clone.name, similarity: Math.round(best.sim * 100) / 100 });
    }
  }
  return out;
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
 * The minor speakers of one gender on their pool, most-heard first: each
 * takes the pool voice none of whose speakers it answers (dialogueAdjacency),
 * then the one with the fewest speakers, then the least heard: a rotation
 * that spreads the biggest minor parts first. Mutates the pool. Pure otherwise.
 */
function rotate(minors: readonly CastSpeaker[], pool: CastPoolVoice[], adjacency: DialogueAdjacency | undefined): CastAssignment[] {
  const owners = pool.map((p) => new Set<string>(p.sharedWith ? [p.sharedWith] : []));
  const conflicts = (speakerId: string, i: number): number => {
    const row = adjacency?.get(speakerId);
    if (!row) return 0;
    let n = 0;
    for (const o of owners[i]!) n += row.get(o) ?? 0;
    return n;
  };
  const out: CastAssignment[] = [];
  for (const m of minors) {
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const cost = conflicts(m.speakerId, i) * 1e9 + pool[i]!.speakers.length * 1e4 + pool[i]!.minutes;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    const voice = pool[best]!;
    voice.speakers.push(m.speakerId);
    voice.minutes = Math.round((voice.minutes + m.minutes) * 100) / 100;
    owners[best]!.add(m.speakerId);
    out.push({ speakerId: m.speakerId, voiceId: voice.voiceId, voiceName: voice.name, by: 'pool' });
  }
  return out;
}

/**
 * The proposed cast: per gender, the most-heard speakers get the distinct
 * voices (profiles first, then presets, soundalikes of a clone last), the
 * rest rotate over a pool of shared voices (see the module comment). Pure;
 * `apply` is the caller's.
 */
export function proposeCast(speakers: readonly CastSpeaker[], voices: readonly CastVoice[], opts: CastOptions = {}): CastProposal {
  const notes: string[] = [];
  const unconfirmed = voices.filter((v) => v.kind === 'profile' && !v.genderConfirmed).map((v) => ({ voiceId: v.voiceId, name: v.name }));
  const usable = voices.filter((v) => v.gender && (v.kind === 'preset' || v.genderConfirmed));
  const ordered = [...usable].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'profile' ? -1 : 1));
  const soundalikes = findSoundalikes(usable, opts.soundalikeCosine);
  const soundalike = new Set(soundalikes.map((s) => s.voiceId));
  const assignments: CastAssignment[] = [];
  const defaults: Partial<Record<CastGender, string>> = {};
  const pools: Partial<Record<CastGender, CastPool>> = {};
  for (const gender of ['male', 'female'] as const) {
    const mine = speakers.filter((s) => s.gender === gender).sort((a, b) => b.minutes - a.minutes);
    if (mine.length === 0) continue;
    const clones = ordered.filter((v) => v.gender === gender && v.kind === 'profile');
    // A built-in that sounds like a clone goes last (stable sort), and only
    // when it lets every speaker have a voice of their own: with a crowd to
    // share a pool anyway, it would only make a main character sound like the
    // one the clone speaks for.
    const presets = ordered
      .filter((v) => v.gender === gender && v.kind === 'preset')
      .sort((a, b) => Number(soundalike.has(a.voiceId)) - Number(soundalike.has(b.voiceId)));
    if (clones.length + presets.length === 0) {
      notes.push(`No ${gender} voice to cast: ${mine.length} ${gender} speaker(s) keep the project voice.`);
      continue;
    }
    const crowd = mine.length > clones.length + presets.length;
    const mainPresets = crowd ? presets.filter((v) => !soundalike.has(v.voiceId)) : presets;
    // In tiers: the most-heard speakers get the user's clones, the next ones
    // the built-in voices; each tier paired by print or pitch rank.
    const mains: CastAssignment[] = [];
    let next = 0;
    for (const tier of [clones, mainPresets]) {
      const k = Math.min(tier.length, mine.length - next);
      if (k <= 0) continue;
      mains.push(...pair(mine.slice(next, next + k), tier.slice(0, k), notes, gender));
      next += k;
    }
    assignments.push(...mains);
    const minors = mine.slice(next);

    // The pool: the user's pick, else the spare built-ins, then the voices of
    // the least-heard cast speakers. Always at least one voice when there is
    // one to give: it is the default for a speaker detected later.
    const minutesOf = new Map(mine.map((s) => [s.speakerId, s.minutes]));
    const mainOf = new Map(mains.map((a) => [a.voiceId, a.speakerId]));
    const voiceById = new Map([...clones, ...presets].map((v) => [v.voiceId, v]));
    const picked = [...new Set(opts.minorPool?.[gender] ?? [])].map((id) => voiceById.get(id)).filter((v): v is CastVoice => v !== undefined);
    const size = picked.length > 0 ? picked.length : minorPoolSize(minors.length, opts.minorVoices);
    const want = picked.length > 0 ? picked.length : Math.max(1, Math.min(size, minors.length));
    const pool: CastPoolVoice[] = [];
    const sharedWith = (voiceId: string): { sharedWith?: string } => (mainOf.has(voiceId) ? { sharedWith: mainOf.get(voiceId)! } : {});
    if (picked.length > 0) {
      for (const v of picked) pool.push({ voiceId: v.voiceId, name: v.name, from: 'picked', ...sharedWith(v.voiceId), speakers: [], minutes: 0 });
    } else {
      const spare = presets.filter((v) => !mainOf.has(v.voiceId) && !soundalike.has(v.voiceId));
      for (const v of spare.slice(0, want)) pool.push({ voiceId: v.voiceId, name: v.name, from: 'spare', speakers: [], minutes: 0 });
      if (pool.length < want) {
        // Built-ins only, never a clone: a clone on the crowd is what F4 was.
        const reusable = mains
          .filter((a) => voiceById.get(a.voiceId)?.kind === 'preset' && !soundalike.has(a.voiceId))
          .sort((a, b) => (minutesOf.get(a.speakerId) ?? 0) - (minutesOf.get(b.speakerId) ?? 0));
        const spareCount = pool.length;
        for (const a of reusable.slice(0, want - pool.length)) {
          pool.push({ voiceId: a.voiceId, name: a.voiceName, from: 'reused', sharedWith: a.speakerId, speakers: [], minutes: 0 });
        }
        const reused = pool.filter((p) => p.from === 'reused');
        if (minors.length > 0 && reused.length > 0) {
          notes.push(
            `${gender}: ${spareCount === 0 ? 'no spare built-in voice' : `only ${spareCount} spare built-in voice(s)`}, so the voices of the least-heard cast speaker(s) ${reused.map((p) => p.sharedWith).join(', ')} are shared too.`,
          );
        }
      }
    }
    if (pool.length === 0) {
      if (minors.length > 0) {
        notes.push(`${gender}: no built-in voice is free for ${minors.length} minor speaker(s): they keep the project voice (choose voices for them).`);
      }
      continue;
    }
    defaults[gender] = pool[0]!.voiceId;
    if (minors.length === 0) continue;
    assignments.push(...rotate(minors, pool, opts.adjacency));
    pools[gender] = { minorSpeakers: minors.length, size, voices: pool };
    notes.push(
      `${gender}: ${minors.length} minor speaker(s) share ${pool.length} voice(s), about ${Math.round(minors.length / pool.length)} each; speakers who answer each other get different voices where possible.`,
    );
  }
  for (const s of soundalikes) {
    notes.push(`Built-in voice "${s.name}" is left out of shared use: it sounds like your cloned voice "${s.cloneName}" (${s.similarity.toFixed(2)}).`);
  }
  const unassigned = speakers.filter((s) => s.gender !== 'male' && s.gender !== 'female').map((s) => s.speakerId);
  if (unassigned.length > 0) notes.push(`${unassigned.length} speaker(s) of unknown gender keep the project voice (set them in the editor).`);
  return { assignments, defaults, unassigned, unconfirmed, notes, pools, soundalikes };
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
