/**
 * The speakers of a project and the voices cast for them: GET
 * /projects/:id/speakers (get_speakers, the editor) and POST
 * /projects/:id/speakers/cast (cast_voices).
 *
 * The rows join what the lines say (who says how much, a few sample lines,
 * the voice each speaker has now) with what detection measured (pitch, gender
 * and how sure it is, the voice print: audio/diarization.json). Casting is
 * voices/casting.ts; this module gathers its inputs: the voices the project's
 * engine can speak, each measured once (pitch and print, from a clone's
 * preview, or from a sentence a built-in voice speaks) and cached.
 */
import fsp from 'node:fs/promises';

import {
  isSpeakerId,
  voiceForLine,
  type ProjectSettings,
  type SpeakerVoiceAssignment,
  type TranscriptSegment,
  type VoiceLibraryItem,
} from '@videodubber/shared';

import type { DetectedSpeaker } from '../pipeline/diarization.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';
import { proposeCast, type CastGender, type CastProposal, type CastSpeaker, type CastVoice } from './casting.js';

/** One speaker of a project, for get_speakers and the editor. */
export interface SpeakerRow {
  speakerId: string;
  minutes: number;
  lines: number;
  f0Hz?: number;
  gender?: 'female' | 'male' | 'unknown';
  genderConfidence?: number;
  /** The longest lines, so a person can tell who it is (and find them). */
  samples: { id: string; text: string; startMs: number; endMs: number }[];
  /** The voice that speaks them now (their own, their gender's default, or the project's). */
  voiceId?: string;
}

/**
 * Every speaker the lines carry, most-heard first, with what detection knows
 * of them. Talk time is the detected one when known, else the lines' length. Pure.
 */
export function speakerRows(
  lines: readonly TranscriptSegment[],
  detected: readonly DetectedSpeaker[],
  settings: ProjectSettings,
  samples = 3,
): SpeakerRow[] {
  const byId = new Map<string, TranscriptSegment[]>();
  for (const l of lines) {
    if (!isSpeakerId(l.speakerId)) continue;
    const list = byId.get(l.speakerId) ?? [];
    list.push(l);
    byId.set(l.speakerId, list);
  }
  const found = new Map(detected.map((d) => [d.speakerId, d]));
  return [...byId.entries()]
    .map(([speakerId, own]) => {
      const d = found.get(speakerId);
      const linesMs = own.reduce((t, l) => t + Math.max(0, l.endMs - l.startMs), 0);
      const longest = [...own].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs)).slice(0, samples);
      const voiceId = voiceForLine({ speakerId }, settings);
      return {
        speakerId,
        minutes: (d?.sec ? d.sec * 1000 : linesMs) / 60_000,
        lines: own.length,
        ...(d?.f0Hz ? { f0Hz: d.f0Hz } : {}),
        ...(d?.gender ? { gender: d.gender } : settings.speakerGenders?.[speakerId] ? { gender: settings.speakerGenders[speakerId] } : {}),
        ...(d && d.gender !== 'unknown' ? { genderConfidence: d.genderConfidence } : {}),
        samples: longest.map((l) => ({ id: l.id, text: (l.sourceText ?? '').trim().slice(0, 120), startMs: l.startMs, endMs: l.endMs })),
        ...(voiceId ? { voiceId } : {}),
      };
    })
    .sort((a, b) => b.minutes - a.minutes || a.speakerId.localeCompare(b.speakerId));
}

/** A voice's measured pitch and print (embedding model of speaker detection). */
export interface VoiceMeasure {
  f0Hz?: number;
  print?: number[];
}

/** Measures of built-in voices, kept in one JSON file (they never change). */
export class VoiceMeasureCache {
  private loaded: Record<string, VoiceMeasure> | undefined;

  constructor(private readonly file: string) {}

  private async all(): Promise<Record<string, VoiceMeasure>> {
    if (!this.loaded) {
      this.loaded = await fsp
        .readFile(this.file, 'utf8')
        .then((t) => JSON.parse(t) as Record<string, VoiceMeasure>)
        .catch(() => ({}));
    }
    return this.loaded;
  }

  async get(voiceId: string): Promise<VoiceMeasure | undefined> {
    return (await this.all())[voiceId];
  }

  async set(voiceId: string, m: VoiceMeasure): Promise<void> {
    const all = await this.all();
    all[voiceId] = m;
    await writeJsonAtomic(this.file, all);
  }
}

export interface CastInputsDeps {
  /** Pitch and print of a voice (cached by the caller); undefined when it cannot be measured here. */
  measure(voice: VoiceLibraryItem): Promise<VoiceMeasure | undefined>;
}

/**
 * The voices a cast can use, measured where it matters: per gender, as many
 * as there are speakers of that gender, clones first (the user's rule), then
 * built-ins. Only voices of the project's engine that are installed and speak
 * its language (clones speak whatever their engine speaks).
 */
export async function castCandidates(
  items: readonly VoiceLibraryItem[],
  speakers: readonly CastSpeaker[],
  deps: CastInputsDeps,
): Promise<CastVoice[]> {
  const out: CastVoice[] = [];
  for (const gender of ['male', 'female'] as const) {
    const wanted = speakers.filter((s) => s.gender === gender).length;
    const pool = items
      .filter((v) => v.gender === gender)
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'profile' ? -1 : 1));
    let measured = 0;
    for (const v of pool) {
      const usable = v.kind === 'preset' || v.genderConfirmed === true;
      // Measure the voices the cast can actually give out (one per speaker).
      const m = usable && measured < wanted ? await deps.measure(v).catch(() => undefined) : undefined;
      if (usable && measured < wanted) measured++;
      out.push({
        voiceId: v.id,
        name: v.name,
        kind: v.kind,
        gender,
        ...(v.kind === 'profile' ? { genderConfirmed: v.genderConfirmed === true } : {}),
        ...(m?.f0Hz ? { f0Hz: m.f0Hz } : {}),
        ...(m?.print?.length ? { print: m.print } : {}),
        ...(v.mainOnly ? { mainOnly: true } : {}),
      });
    }
  }
  // A clone with no gender at all is "unconfirmed" too: it must be named.
  for (const v of items) {
    if (v.kind === 'profile' && !v.gender) out.push({ voiceId: v.id, name: v.name, kind: 'profile', genderConfirmed: false });
  }
  return out;
}

/** A speaker of unknown gender, as the cast lists them: who it is, how much they say. */
export interface UnknownSpeaker {
  speakerId: string;
  minutes: number;
  lines: number;
  /** Their three longest lines. */
  samples: SpeakerRow['samples'];
}

/** What POST /projects/:id/speakers/cast answers. */
export interface CastResult extends CastProposal {
  /** The speakers of unknown gender with their longest lines and talk time (set them by hand). */
  unknown?: UnknownSpeaker[];
  /** The voices a pool or a swap may use, per gender (the editor's choices). */
  candidates?: Partial<Record<CastGender, { voiceId: string; name: string; kind: 'profile' | 'preset' }[]>>;
  /** The pool size the proposal was asked for (the request's, else the project's setting); absent: automatic. */
  minorVoices?: number;
  applied?: boolean;
  refused?: boolean;
  message?: string;
}

/**
 * The speakers the cast leaves to the project voice (gender unknown), with
 * their three longest lines and talk time, so a person can tell who each one
 * is: the cast used to list them by id only (claude-dubber report F4). Pure.
 */
export function unknownSpeakers(rows: readonly SpeakerRow[], proposal: Pick<CastProposal, 'unassigned'>): UnknownSpeaker[] {
  const wanted = new Set(proposal.unassigned);
  return rows
    .filter((r) => wanted.has(r.speakerId))
    .map((r) => ({ speakerId: r.speakerId, minutes: Math.round(r.minutes * 100) / 100, lines: r.lines, samples: r.samples.slice(0, 3) }));
}

/** The castable voices per gender, for the editor's pool and swap choices. Pure. */
export function castChoices(voices: readonly CastVoice[]): NonNullable<CastResult['candidates']> {
  const out: NonNullable<CastResult['candidates']> = {};
  for (const gender of ['male', 'female'] as const) {
    const list = voices
      .filter((v) => v.gender === gender && (v.kind === 'preset' || v.genderConfirmed))
      .map((v) => ({ voiceId: v.voiceId, name: v.name, kind: v.kind }));
    if (list.length > 0) out[gender] = list;
  }
  return out;
}

/**
 * The cast with the user's swaps applied (a swap must name a speaker of the
 * project and a voice the cast could use). A swapped minor speaker leaves its
 * pool voice's list. A voice kept for one main character (mainOnly) goes to
 * one speaker: a swap that would give it to a second one, while the first
 * keeps it, is left out and said (move the first speaker off it in the same
 * call). Pure.
 */
export function withSwaps(
  proposal: CastProposal,
  swaps: readonly { speakerId: string; voiceId: string }[] | undefined,
  voices: readonly CastVoice[],
): CastProposal {
  if (!swaps?.length) return proposal;
  const known = new Map(voices.map((v) => [v.voiceId, v]));
  const notes = [...proposal.notes];
  const swappedTo = new Map(swaps.map((s) => [s.speakerId, s.voiceId]));
  /** A one-main-character voice already given by an earlier swap: voice id → speaker. */
  const given = new Map<string, string>();
  const allowed = swaps.filter((s) => {
    const voice = known.get(s.voiceId);
    if (!voice?.mainOnly) return true;
    // A speaker the cast gave it to who is not moved off it, or an earlier swap's speaker.
    const keeper =
      proposal.assignments.find((a) => a.speakerId !== s.speakerId && a.voiceId === s.voiceId && (swappedTo.get(a.speakerId) ?? a.voiceId) === s.voiceId)
        ?.speakerId ?? (given.get(s.voiceId) !== s.speakerId ? given.get(s.voiceId) : undefined);
    if (keeper) {
      notes.push(`"${voice.name}" is kept for one main character (${keeper} has it): not given to ${s.speakerId} too.`);
      return false;
    }
    given.set(s.voiceId, s.speakerId);
    return true;
  });
  const swapped = new Set<string>();
  const assignments = proposal.assignments.map((a) => {
    const swap = allowed.find((s) => s.speakerId === a.speakerId);
    const voice = swap ? known.get(swap.voiceId) : undefined;
    if (!voice) return a;
    swapped.add(a.speakerId);
    return { ...a, voiceId: voice.voiceId, voiceName: voice.name, by: 'order' as const };
  });
  for (const s of allowed) {
    const voice = known.get(s.voiceId);
    if (voice && !assignments.some((a) => a.speakerId === s.speakerId) && isSpeakerId(s.speakerId)) {
      assignments.push({ speakerId: s.speakerId, voiceId: voice.voiceId, voiceName: voice.name, by: 'order' });
    }
  }
  const pools: CastProposal['pools'] = {};
  for (const gender of ['male', 'female'] as const) {
    const pool = proposal.pools?.[gender];
    if (pool) pools[gender] = { ...pool, voices: pool.voices.map((v) => ({ ...v, speakers: v.speakers.filter((id) => !swapped.has(id)) })) };
  }
  // A speaker of unknown gender given a voice by a swap has one now: it is no
  // longer "left to the project voice" (the reply listed all 24 swapped
  // speakers there; claude-dubber, 2026-11-25).
  const voiced = new Set(assignments.map((a) => a.speakerId));
  const unassigned = proposal.unassigned.filter((id) => !voiced.has(id));
  const UNKNOWN_NOTE = 'speaker(s) of unknown gender keep the project voice';
  const kept = notes.filter((note) => !note.includes(UNKNOWN_NOTE));
  if (unassigned.length > 0 && kept.length !== notes.length) kept.push(`${unassigned.length} ${UNKNOWN_NOTE} (set them in the editor).`);
  return { ...proposal, assignments, pools, notes: kept, unassigned };
}

/**
 * The settings a cast writes: a voice for EVERY speaker it placed, the minor
 * ones included (a pool cannot be one default; the table holds the 100
 * speakers detection can find, most heard first should it ever overflow),
 * the genders, and the default voice per gender, the pool's first voice, for
 * a speaker detected later. A gender with speakers but no pool voice gets its
 * default cleared ('') rather than left on a clone. A speaker of unknown
 * gender keeps a voice someone chose for them (`current`). Pure.
 */
export function castSettings(
  proposal: CastProposal,
  speakers: readonly CastSpeaker[],
  current?: readonly SpeakerVoiceAssignment[],
): Pick<ProjectSettings, 'speakerVoices' | 'speakerGenders' | 'defaultMaleVoiceId' | 'defaultFemaleVoiceId'> {
  const minutes = new Map(speakers.map((s) => [s.speakerId, s.minutes]));
  const cast = new Map(proposal.assignments.map((a) => [a.speakerId, a.voiceId]));
  for (const v of current ?? []) {
    if (!cast.has(v.speakerId) && proposal.unassigned.includes(v.speakerId)) cast.set(v.speakerId, v.voiceId);
  }
  const speakerVoices = [...cast]
    .sort(([a], [b]) => (minutes.get(b) ?? 0) - (minutes.get(a) ?? 0) || a.localeCompare(b))
    .map(([speakerId, voiceId]) => ({ speakerId, voiceId }));
  const speakerGenders: Record<string, 'female' | 'male'> = {};
  for (const s of speakers) if (s.gender === 'male' || s.gender === 'female') speakerGenders[s.speakerId] = s.gender;
  const out: Pick<ProjectSettings, 'speakerVoices' | 'speakerGenders' | 'defaultMaleVoiceId' | 'defaultFemaleVoiceId'> = { speakerVoices, speakerGenders };
  if (speakers.some((s) => s.gender === 'male')) out.defaultMaleVoiceId = proposal.defaults.male ?? '';
  if (speakers.some((s) => s.gender === 'female')) out.defaultFemaleVoiceId = proposal.defaults.female ?? '';
  return out;
}

export { proposeCast };
