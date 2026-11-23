/**
 * A series that continues another (5.2 of the 2026-11-23 plan): a new
 * project, for a later season, that carries the first series' name, numbering
 * and name template on, and gives its speakers the voices of the speakers they
 * sound like there.
 *
 * WHY: the 27.8-hour source is "全1-12季" and its last upload is season 11,
 * so a season 12 will follow. Joining it to the 27.8 hours already dubbed and
 * running all of it again would cost days; a series of its own that numbers
 * its parts 49, 50… and keeps the cast's voices costs only the new hours.
 *
 * Speakers are matched by voice print (the speaker detection engine's
 * embeddings, kept per speaker in audio/diarization.json), one to one, most
 * alike first, at the threshold re-detection uses to follow a voice
 * (REMAP_MIN_SIMILARITY). A speaker who matches no one keeps no voice of its
 * own: the voices for minor speakers are for them (cast_voices).
 */
import { REMAP_MIN_SIMILARITY } from '../pipeline/diarization.js';
import { cosineSimilarity } from '../providers/diarization/voicePrint.js';

/** One speaker here who sounds like one of the continued series'. */
export interface VoiceMatch {
  /** The speaker id in this series. */
  ours: string;
  /** The speaker id in the series it continues. */
  theirs: string;
  /** Cosine similarity of their voice prints. */
  similarity: number;
}

/** Speakers matched across two series by voice print: one to one, most alike first. Pure. */
export function matchSpeakersByVoice(
  theirs: readonly { speakerId: string; print: readonly number[] }[],
  ours: readonly { speakerId: string; print: readonly number[] }[],
  minSimilarity: number = REMAP_MIN_SIMILARITY,
): VoiceMatch[] {
  const pairs: VoiceMatch[] = [];
  for (const o of ours) {
    for (const t of theirs) {
      const similarity = cosineSimilarity(o.print, t.print);
      if (similarity >= minSimilarity) pairs.push({ ours: o.speakerId, theirs: t.speakerId, similarity });
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity || a.ours.localeCompare(b.ours) || a.theirs.localeCompare(b.theirs));
  const usedOurs = new Set<string>();
  const usedTheirs = new Set<string>();
  const out: VoiceMatch[] = [];
  for (const p of pairs) {
    if (usedOurs.has(p.ours) || usedTheirs.has(p.theirs)) continue;
    usedOurs.add(p.ours);
    usedTheirs.add(p.theirs);
    out.push(p);
  }
  return out.sort((a, b) => a.ours.localeCompare(b.ours));
}

/**
 * The voices this series' speakers get from the series it continues: each
 * matched speaker with no voice of its own takes its match's voice there (a
 * match whose speaker had no voice there gives none). Returns the whole table
 * and the speakers it gave a voice to. Pure.
 */
export function continuedVoices(
  current: readonly { speakerId: string; voiceId: string }[] | undefined,
  matches: readonly VoiceMatch[],
  theirVoices: readonly { speakerId: string; voiceId: string }[],
): { table: { speakerId: string; voiceId: string }[]; given: VoiceMatch[] } {
  const voiceOf = new Map(theirVoices.map((v) => [v.speakerId, v.voiceId]));
  const table = new Map((current ?? []).map((v) => [v.speakerId, v.voiceId]));
  const given: VoiceMatch[] = [];
  for (const m of matches) {
    const voiceId = voiceOf.get(m.theirs);
    if (!voiceId || table.has(m.ours)) continue;
    table.set(m.ours, voiceId);
    given.push(m);
  }
  return {
    table: [...table].map(([speakerId, voiceId]) => ({ speakerId, voiceId })).sort((a, b) => a.speakerId.localeCompare(b.speakerId)),
    given,
  };
}
