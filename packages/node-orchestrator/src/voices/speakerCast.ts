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

import { isSpeakerId, voiceForLine, type ProjectSettings, type TranscriptSegment, type VoiceLibraryItem } from '@videodubber/shared';

import type { DetectedSpeaker } from '../pipeline/diarization.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';
import { proposeCast, type CastProposal, type CastSpeaker, type CastVoice } from './casting.js';

/** One speaker of a project, for get_speakers and the editor. */
export interface SpeakerRow {
  speakerId: string;
  minutes: number;
  lines: number;
  f0Hz?: number;
  gender?: 'female' | 'male' | 'unknown';
  genderConfidence?: number;
  /** The longest lines, so a person can tell who it is. */
  samples: { id: string; text: string }[];
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
        samples: longest.map((l) => ({ id: l.id, text: (l.sourceText ?? '').trim().slice(0, 120) })),
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
      });
    }
  }
  // A clone with no gender at all is "unconfirmed" too: it must be named.
  for (const v of items) {
    if (v.kind === 'profile' && !v.gender) out.push({ voiceId: v.id, name: v.name, kind: 'profile', genderConfirmed: false });
  }
  return out;
}

/** What POST /projects/:id/speakers/cast answers. */
export interface CastResult extends CastProposal {
  applied?: boolean;
  refused?: boolean;
  message?: string;
}

/**
 * The cast with the user's swaps applied (a swap must name a speaker of the
 * project and a voice the cast could use). Pure.
 */
export function withSwaps(
  proposal: CastProposal,
  swaps: readonly { speakerId: string; voiceId: string }[] | undefined,
  voices: readonly CastVoice[],
): CastProposal {
  if (!swaps?.length) return proposal;
  const known = new Map(voices.map((v) => [v.voiceId, v]));
  const assignments = proposal.assignments.map((a) => {
    const swap = swaps.find((s) => s.speakerId === a.speakerId);
    const voice = swap ? known.get(swap.voiceId) : undefined;
    return voice ? { ...a, voiceId: voice.voiceId, voiceName: voice.name, by: 'order' as const } : a;
  });
  for (const s of swaps) {
    const voice = known.get(s.voiceId);
    if (voice && !assignments.some((a) => a.speakerId === s.speakerId) && isSpeakerId(s.speakerId)) {
      assignments.push({ speakerId: s.speakerId, voiceId: voice.voiceId, voiceName: voice.name, by: 'order' });
    }
  }
  return { ...proposal, assignments };
}

/**
 * The settings a cast writes: the distinct voices per speaker (a speaker on
 * their gender's default needs no entry, so a series of hundreds of speakers
 * fits the table of 100), the genders, and the default voice per gender. Pure.
 */
export function castSettings(
  proposal: CastProposal,
  speakers: readonly CastSpeaker[],
): Pick<ProjectSettings, 'speakerVoices' | 'speakerGenders' | 'defaultMaleVoiceId' | 'defaultFemaleVoiceId'> {
  const speakerVoices = proposal.assignments.filter((a) => a.by !== 'default').map((a) => ({ speakerId: a.speakerId, voiceId: a.voiceId }));
  const speakerGenders: Record<string, 'female' | 'male'> = {};
  for (const s of speakers) if (s.gender === 'male' || s.gender === 'female') speakerGenders[s.speakerId] = s.gender;
  return {
    speakerVoices,
    speakerGenders,
    ...(proposal.defaults.male ? { defaultMaleVoiceId: proposal.defaults.male } : {}),
    ...(proposal.defaults.female ? { defaultFemaleVoiceId: proposal.defaults.female } : {}),
  };
}

export { proposeCast };
